// The mutable document, which @webcue/core deliberately does not own.
//
// The desktop Show is a ChangeBroadcaster with mutating setters and a file on
// disk. Core is pure functions over plain values instead, so the dirty flag,
// the undo history and the "which file is this" question live here — where a
// browser can answer them, and where they can change without touching anything
// that is under test.

import type { ActiveCueInfo, Cue, ShowData, Standby } from '@webcue/core';
import {
  Sequencer,
  clampStandby,
  isRoutedOffDevice,
  makeCue,
  makeShow,
  parseShow,
  standbyForCue,
} from '@webcue/core';
import type { WebCueEngine } from '@webcue/engine';

export type EngineStatus = 'idle' | 'starting' | 'running' | 'failed';

/** A cue whose routing addresses outputs this device does not have. Every route
    is filtered away and the cue would refuse to play at all — so the operator
    is asked, on load, rather than finding out at the first GO. */
export interface FoldCandidate {
  cueId: string;
  number: string;
  name: string;
}

export interface AppSnapshot {
  status: EngineStatus;
  error: string;
  show: ShowData;
  showName: string;
  dirty: boolean;
  standby: Standby;
  /** Which cue the inspector is editing. Separate from standby: the desktop
      lets you edit cue 40 while cue 3 is on standby, and so does this. */
  selectedIndex: number;
  active: ActiveCueInfo[];
  paused: boolean;
  masterGainDb: number;
  missingAudio: string[];
  foldCandidates: FoldCandidate[];
  foldPromptOpen: boolean;
  numOutputs: number;
  log: string[];
}

export class AppStore {
  private listeners = new Set<() => void>();
  private snapshot: AppSnapshot;

  private engine: WebCueEngine | null = null;
  private sequencer: Sequencer | null = null;

  constructor() {
    this.snapshot = {
      status: 'idle',
      error: '',
      show: makeShow(),
      showName: 'Untitled show',
      dirty: false,
      standby: { index: -1, step: -1 },
      selectedIndex: -1,
      active: [],
      paused: false,
      masterGainDb: 0,
      missingAudio: [],
      foldCandidates: [],
      foldPromptOpen: false,
      numOutputs: 2,
      log: [],
    };
  }

  //== React glue ===========================================================

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppSnapshot => this.snapshot;

  private set(patch: Partial<AppSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private say(message: string): void {
    this.set({ log: [...this.snapshot.log.slice(-60), message] });
  }

  //== Engine ===============================================================

  /** Must be called from a user gesture: an AudioContext starts suspended, and
      a browser will not resume one otherwise. Doing it silently at load and
      hoping is how the first GO of a show turns out to be inaudible. */
  async start(engineFactory: () => Promise<WebCueEngine>): Promise<void> {
    if (this.snapshot.status !== 'idle' && this.snapshot.status !== 'failed') return;

    this.set({ status: 'starting', error: '' });

    try {
      const engine = await engineFactory();
      this.engine = engine;

      const sequencer = new Sequencer({
        host: engine,
        sources: engine,
        onChanged: () => this.refresh(),
      });

      this.sequencer = sequencer;

      engine.setEvents({
        onVoiceFinished: (ref) => sequencer.handleVoiceFinished(ref),
        onSnapshot: () => this.refresh(),
        onError: (message) => this.say(`engine: ${message}`),
      });

      sequencer.setCues(this.snapshot.show.cues);

      this.set({
        status: 'running',
        numOutputs: engine.numOutputChannels,
      });

      this.say(
        `engine ready at ${engine.sampleRate} Hz, ${engine.numOutputChannels} out, ${engine.maxVoices} voices`,
      );

      this.checkRouting();
    } catch (e) {
      this.set({ status: 'failed', error: (e as Error).message });
    }
  }

  private refresh(): void {
    if (!this.sequencer) return;

    this.set({
      active: this.sequencer.getActiveCues(),
      standby: this.sequencer.getStandby(),
      paused: this.sequencer.isPaused(),
    });
  }

  //== Show =================================================================

  async openShow(file: File): Promise<void> {
    try {
      const show = parseShow(await file.text());
      const name = file.name.replace(/\.cueshow$/i, '');

      this.set({
        show,
        showName: name,
        dirty: false,
        masterGainDb: show.masterGainDb,
        standby: show.cues.length > 0 ? standbyForCue(show.cues, 0) : { index: -1, step: -1 },
      });

      this.sequencer?.setCues(show.cues);
      this.engine?.setMasterGain(dbToGain(show.masterGainDb));

      this.say(`opened ${file.name} — ${show.cues.length} cues`);
      this.updateMissing();
      this.checkRouting();
    } catch (e) {
      this.say(`could not open ${file.name}: ${(e as Error).message}`);
      this.set({ error: (e as Error).message });
    }
  }

  /** Matches picked files to the paths the show refers to. A show stores paths
      relative to itself, which a browser cannot resolve, so this matches on the
      basename — good enough to run a show, and replaced in the phase that does
      File System Access properly. */
  async addAudioFiles(files: FileList | File[]): Promise<void> {
    if (!this.engine) return;

    const wanted = new Map<string, string>();

    for (const cue of this.snapshot.show.cues) {
      if (cue.type !== 'audioFile' || cue.audioFile.length === 0) continue;
      wanted.set(basename(cue.audioFile), cue.audioFile);
    }

    let loaded = 0;

    for (const file of Array.from(files)) {
      const path = wanted.get(file.name);
      if (path === undefined || this.engine.hasSource(path)) continue;

      try {
        await this.engine.loadSource(path, await file.arrayBuffer());
        loaded++;
      } catch (e) {
        this.say(`could not decode ${file.name}: ${(e as Error).message}`);
      }
    }

    if (loaded > 0) this.say(`loaded ${loaded} audio file${loaded === 1 ? '' : 's'}`);

    this.updateMissing();
    this.refresh();
  }

  private updateMissing(): void {
    const missing: string[] = [];

    for (const cue of this.snapshot.show.cues) {
      if (cue.type !== 'audioFile' || cue.audioFile.length === 0) continue;
      if (!this.engine?.hasSource(cue.audioFile)) missing.push(cue.audioFile);
    }

    this.set({ missingAudio: [...new Set(missing)] });
  }

  //== Routing =============================================================

  /** Asked on load, never applied silently. Folding without saying so would
      make webcue quietly disagree with the desktop about what the show sounds
      like, which is worse than refusing to play it. */
  private checkRouting(): void {
    const outputs = this.engine?.numOutputChannels ?? 2;

    const candidates = this.snapshot.show.cues
      .filter((cue) => isRoutedOffDevice(cue, cue.fileChannels || 2, outputs))
      .map((cue) => ({ cueId: cue.id, number: cue.number, name: cue.name }));

    this.set({ foldCandidates: candidates, foldPromptOpen: candidates.length > 0 });
  }

  /** Rewrites the offending cues' routing onto the outputs that exist. */
  applyFold(): void {
    const outputs = this.engine?.numOutputChannels ?? 2;
    const ids = new Set(this.snapshot.foldCandidates.map((c) => c.cueId));

    const cues = this.snapshot.show.cues.map((cue) => {
      if (!ids.has(cue.id)) return cue;

      return {
        ...cue,
        routing: cue.routing.map((r) => ({
          ...r,
          outputChannel: r.outputChannel % outputs,
        })),
      };
    });

    this.setCues(cues, true);
    this.set({ foldPromptOpen: false, foldCandidates: [] });
    this.say(`folded ${ids.size} cue${ids.size === 1 ? '' : 's'} onto ${outputs} outputs`);
  }

  dismissFold(): void {
    this.set({ foldPromptOpen: false });
    this.say('left the routing alone; those cues will refuse to play');
  }

  //== Editing =============================================================

  setCues(cues: Cue[], dirty = true): void {
    const standby = clampStandby(cues, this.snapshot.standby);
    this.set({ show: { ...this.snapshot.show, cues }, dirty, standby });
    this.sequencer?.setCues(cues);
    this.sequencer?.setStandby(standby);
  }

  setStandby(standby: Standby): void {
    this.sequencer?.setStandby(standby);
    this.set({ standby });
  }

  setSelected(index: number): void {
    this.set({ selectedIndex: index });
  }

  /** Edits one cue in place. Every inspector field goes through this, so the
      dirty flag and the standby re-clamp happen in one place — turning a vamp
      off removes its Devamp step, and standby has to come back into range. */
  updateCue(cueId: string, patch: Partial<Cue>): void {
    const cues = this.snapshot.show.cues.map((cue) =>
      cue.id === cueId ? { ...cue, ...patch } : cue,
    );

    this.setCues(cues, true);
  }

  addCue(): void {
    const show = this.snapshot.show;

    // A new cue takes the show's default fades, as Show::applyDefaultsTo does.
    const cue = makeCue({
      number: String(show.cues.length + 1),
      name: 'New cue',
      fadeInTime: show.defaultFadeInTime,
      fadeOutTime: show.defaultFadeOutTime,
      fadeInShape: show.defaultFadeShape,
      fadeOutShape: show.defaultFadeShape,
    });

    const at = this.snapshot.selectedIndex >= 0 ? this.snapshot.selectedIndex + 1 : show.cues.length;
    const cues = [...show.cues.slice(0, at), cue, ...show.cues.slice(at)];

    this.setCues(cues, true);
    this.set({ selectedIndex: at });
  }

  removeCue(cueId: string): void {
    const cues = this.snapshot.show.cues.filter((c) => c.id !== cueId);
    const selected = Math.min(this.snapshot.selectedIndex, cues.length - 1);

    this.setCues(cues, true);
    this.set({ selectedIndex: selected });
  }

  moveCue(from: number, to: number): void {
    const cues = [...this.snapshot.show.cues];
    if (from < 0 || from >= cues.length || to < 0 || to >= cues.length) return;

    const [moved] = cues.splice(from, 1);
    if (!moved) return;
    cues.splice(to, 0, moved);

    this.setCues(cues, true);
    this.set({ selectedIndex: to });
  }

  /** Listening to a cue must never fire the rest of the show, so this goes
      through Sequencer.audition, which strips the pre-wait and the link. */
  audition(cue: Cue, fromSeconds: number): void {
    if (!this.sequencer?.audition(cue, fromSeconds)) {
      for (const error of this.sequencer?.getErrors() ?? []) this.say(error);
    }
  }

  getPeaks(audioFile: string) {
    return this.engine?.getPeaks(audioFile) ?? null;
  }

  /** Attaches a picked file to a cue that had none, or replaces its audio. */
  async setCueAudio(cueId: string, file: File): Promise<void> {
    if (!this.engine) return;

    const path = file.name;

    try {
      await this.engine.loadSource(path, await file.arrayBuffer());
    } catch (e) {
      this.say(`could not decode ${file.name}: ${(e as Error).message}`);
      return;
    }

    const info = this.engine.get(path);
    const peaks = this.engine.getPeaks(path);

    this.updateCue(cueId, {
      audioFile: path,
      fileDuration: peaks ? peaks.numFrames / peaks.sampleRate : 0,
      fileChannels: info?.numChannels ?? 2,
      fileSampleRate: peaks?.sampleRate ?? 48000,
      // A fresh file with no out point means "to the end", which is what 0 says.
      endTime: 0,
    });

    this.updateMissing();
  }

  setMasterGainDb(db: number): void {
    const clamped = Math.max(-100, Math.min(12, db));
    this.set({ masterGainDb: clamped, show: { ...this.snapshot.show, masterGainDb: clamped }, dirty: true });
    this.engine?.setMasterGain(dbToGain(clamped));
  }

  //== Transport ===========================================================

  go(): void {
    if (!this.sequencer) return;

    const ok = this.sequencer.go();

    if (!ok) {
      for (const error of this.sequencer.getErrors()) this.say(error);
    }
  }

  fireCue(index: number): void {
    if (!this.sequencer) return;

    if (!this.sequencer.fireCueAsWhole(index)) {
      for (const error of this.sequencer.getErrors()) this.say(error);
    }
  }

  stopAll(fadeSeconds = 2): void {
    this.sequencer?.stopAll(fadeSeconds);
  }

  panic(): void {
    this.sequencer?.panic();
    this.say('panic');
  }

  releaseAllVamps(): void {
    this.sequencer?.releaseAllVamps();
  }

  /** One voice, not the whole cue — the running-cue panel lists voices. */
  stopVoice(info: ActiveCueInfo, fadeSeconds = 2): void {
    this.sequencer?.stopVoice(info.ref, fadeSeconds);
  }

  releaseVampVoice(info: ActiveCueInfo): void {
    this.sequencer?.releaseVampVoice(info.ref);
  }

  togglePause(): void {
    this.sequencer?.setPaused(!this.snapshot.paused);
  }

  isAnythingVamping(): boolean {
    return this.snapshot.active.some((a) => a.vamping);
  }
}

function basename(path: string): string {
  // Both separators, because a show written on Windows holds backslashes and we
  // deliberately never rewrite them.
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

export function dbToGain(db: number): number {
  return db > -100 ? Math.pow(10, db * 0.05) : 0;
}
