// The sequencer: which cue, which voice, and what follows it.
//
// Ported from AudioEngine::fireCue / scheduleLink / cancelChildrenOf
// (AudioEngine.cpp:319-533) and MainComponent::fireStandbyStep
// (MainComponent.cpp:734-786). Everything here runs on the main thread and
// talks to a VoiceHost, never to wasm — which is what lets the whole of it be
// driven by a fake with a sample clock.
//
// THE TRAP, stated once. There are two clocks and they are one line apart in
// scheduleLink:
//
//   * a link TARGET's offset is measured from GO, and INCLUDES the pre-wait;
//   * a scheduleStop offset is measured from the source voice's first SOUNDING
//     sample, EXCLUDES the pre-wait, and is not reset by loops.
//
// Swap them and every crossfade in a show with a pre-wait is wrong by exactly
// the pre-wait — which is not a sound anyone recognises as a bug.

import type { Cue, FadeShape } from './cue.js';
import { isOpenEnded, limits, playbackLength } from './cue.js';
import type { Standby } from './cuelist.js';
import {
  advanceStandby,
  cueAt,
  emptyStandby,
  indexOfId,
  resolveLinkTarget,
  standbyForCue,
  stepsFor,
} from './cuelist.js';
import { cueHeaderStep } from './cuestep.js';
import type { BuildSpecContext } from './spec.js';
import { buildVoiceSpec, secondsToSamples } from './spec.js';
import type { SourceRegistry, VoiceHost, VoiceRef } from './voicehost.js';
import { VoiceState } from './voicehost.js';
import { VoicePool } from './voicepool.js';

/** AudioEngine.cpp:10. Longer than any real show; a ring of links hits it. */
export const maxLinkChainDepth = 32;

interface PendingFollow {
  source: VoiceRef;
  targetCueIndex: number;
  delaySeconds: number;
}

export interface ActiveCueInfo {
  ref: VoiceRef;
  cueId: string;
  number: string;
  name: string;
  /** Seconds sounded, monotonic — never reset by loops. */
  elapsed: number;
  /** Seconds left, or -1 when open-ended. */
  remaining: number;
  /** Play head in seconds from the start of the file; jumps on loops and vamps. */
  position: number;
  inPreWait: boolean;
  vamping: boolean;
  vampPasses: number;
  playPasses: number;
  stopping: boolean;
  paused: boolean;
  gain: number;
}

export interface SequencerOptions {
  host: VoiceHost;
  sources: SourceRegistry;
  /** Called when a cue fires, with the time until its first sample sounds, so
      outgoing messages can be scheduled to land with the audio rather than with
      the GO. Nothing consumes this yet — the control layer is a later phase. */
  onCueFired?: (cue: Cue, secondsUntilAudio: number) => void;
  onChanged?: () => void;
}

export class Sequencer {
  private readonly host: VoiceHost;
  private readonly sources: SourceRegistry;
  private readonly pool: VoicePool;
  private readonly onCueFired?: (cue: Cue, secondsUntilAudio: number) => void;
  private readonly onChanged?: () => void;

  private cues: Cue[] = [];
  private standbyPos: Standby = emptyStandby;
  private pendingFollows: PendingFollow[] = [];
  private globallyPaused = false;

  /** Errors from the current operation. The desktop keeps only the last, so a
      failure deep in a link chain hides the one at the top; collecting them
      means the UI can show the cause rather than the symptom. */
  private errors: string[] = [];

  constructor(options: SequencerOptions) {
    this.host = options.host;
    this.sources = options.sources;
    this.pool = new VoicePool(Math.min(options.host.maxVoices, limits.maxVoices));
    this.onCueFired = options.onCueFired;
    this.onChanged = options.onChanged;
  }

  //== Show =================================================================

  setCues(cues: Cue[]): void {
    this.cues = cues;
    this.standbyPos = cues.length > 0 ? standbyForCue(cues, 0) : emptyStandby;
    this.changed();
  }

  getCues(): readonly Cue[] {
    return this.cues;
  }

  getStandby(): Standby {
    return this.standbyPos;
  }

  setStandby(standby: Standby): void {
    this.standbyPos = standby;
    this.changed();
  }

  getErrors(): readonly string[] {
    return this.errors;
  }

  getLastError(): string {
    return this.errors[this.errors.length - 1] ?? '';
  }

  isPaused(): boolean {
    return this.globallyPaused;
  }

  get busyVoices(): number {
    return this.pool.busy;
  }

  //== GO ===================================================================

  /** MainComponent::fireStandbyStep (MainComponent.cpp:734-786).

      Standby advances even when the step could not be performed — a missing
      file must not strand the operator on a cue that will never fire. The
      caller reports the error. */
  go(): boolean {
    this.errors = [];

    const index = this.standbyPos.index;
    const cue = cueAt(this.cues, index);

    if (cue === null) return false;

    const steps = stepsFor(this.cues, index);
    const stepIndex = this.standbyPos.step;

    // Read before advancing: advanceStandby can change what the cue looks like
    // to later code, and the desktop copies these for the same reason.
    const cueId = cue.id;
    const { endAction, endFadeTime } = cue;

    if (stepIndex === cueHeaderStep) {
      const played = cue.firePlayWithCue ? this.fireCueByIndex(index) : true;
      this.advance();
      return played;
    }

    if (stepIndex < 0 || stepIndex >= steps.length) return false;

    let performed = true;

    switch (steps[stepIndex]?.type) {
      case 'play':
        performed = this.fireCueByIndex(index);
        break;

      case 'devamp':
        // Acts on the CUE, not on one voice: firing a cue twice gives two
        // voices, and the operator's devamp means both of them.
        this.releaseVamp(cueId);
        break;

      case 'end':
        this.stopCue(cueId, endAction === 'hardStop' ? 0 : endFadeTime);
        break;
    }

    this.advance();
    return performed;
  }

  /** Cue-list double-click and the goCue control action.
      MainComponent::fireCueAsWhole (MainComponent.cpp:715-732). */
  fireCueAsWhole(index: number): boolean {
    this.errors = [];

    const cue = cueAt(this.cues, index);
    if (cue === null) return false;

    if (!cue.firePlayWithCue) {
      // A container: standing it by is all firing it means.
      this.standbyPos = standbyForCue(this.cues, index);
      this.changed();
      return true;
    }

    return this.fireCueByIndex(index);
  }

  /** AudioEngine::go (AudioEngine.cpp:277-281). */
  fireCueByIndex(index: number): boolean {
    const fired = this.fireCue(index, 0, null, 0, []);
    this.changed();
    return fired;
  }

  private advance(): void {
    this.standbyPos = advanceStandby(this.cues, this.standbyPos);
    this.changed();
  }

  //== Firing and linking ===================================================

  private fireCue(
    cueIndex: number,
    extraPreWaitSamples: number,
    parent: VoiceRef | null,
    depth: number,
    visited: string[],
  ): boolean {
    const cue = cueAt(this.cues, cueIndex);
    if (cue === null) return false;

    if (depth > maxLinkChainDepth || visited.includes(cue.id)) {
      this.setError(
        `Link chain from cue ${cue.number} loops back on itself; stopped there.`,
      );
      return false;
    }

    // PINNED: this runs before the spec can fail, so a cue that failed to load
    // still blocks a revisit later in the same chain. Undocumented in the C++
    // but almost certainly deliberate — it prevents a spin.
    visited.push(cue.id);

    const { sampleRate } = this.host;
    const preWaitSeconds =
      cue.preWait + (sampleRate > 0 ? extraPreWaitSamples / sampleRate : 0);

    // A cue that only sends messages: no voice, but it still links onward.
    if (cue.type === 'control') {
      this.onCueFired?.(cue, preWaitSeconds);
      this.scheduleLink(cueIndex, null, secondsToSamples(preWaitSeconds, sampleRate), depth, visited);
      return true;
    }

    const ctx: BuildSpecContext = {
      sampleRate,
      numOutputChannels: this.host.numOutputChannels,
      sources: this.sources,
    };

    const built = buildVoiceSpec(cue, ctx, extraPreWaitSamples);

    if (!built.ok) {
      this.setError(built.error);
      return false;
    }

    const record = this.pool.allocate({
      cueId: cue.id,
      cueIndex,
      parent,
      sourceIndex: built.spec.sourceIndex,
      linksOnward: true,
    });

    if (record === null) {
      this.setError(`All ${this.pool.capacity} voices are in use.`);
      return false;
    }

    this.host.startVoice(record.ref, built.spec);

    this.onCueFired?.(
      cue,
      sampleRate > 0 ? built.spec.preWaitSamples / sampleRate : 0,
    );

    this.scheduleLink(cueIndex, record.ref, built.spec.preWaitSamples, depth, visited);
    return true;
  }

  /** AudioEngine::scheduleLink (AudioEngine.cpp:413-505). */
  private scheduleLink(
    cueIndex: number,
    sourceVoice: VoiceRef | null,
    basePreWaitSamples: number,
    depth: number,
    visited: string[],
  ): void {
    const cue = cueAt(this.cues, cueIndex);
    if (cue === null || cue.link.mode === 'none') return;

    const target = resolveLinkTarget(this.cues, cueIndex);
    if (target === null) return;

    const targetIndex = indexOfId(this.cues, target.id);
    if (targetIndex < 0 || targetIndex === cueIndex) return;

    const { sampleRate } = this.host;
    const delaySamples = secondsToSamples(cue.link.delay, sampleRate);
    const playLength = playbackLength(cue);

    // A control cue also has a playbackLength of 0, but for the opposite reason:
    // it takes no time at all rather than an unknowable amount. isOpenEnded() is
    // what separates "cannot be predicted" from "finishes immediately".
    const openEnded = isOpenEnded(cue);

    switch (cue.link.mode) {
      case 'autoContinue':
        // Relative to this cue's own start, so the pre-wait carries through.
        this.fireCue(
          targetIndex,
          basePreWaitSamples + delaySamples,
          sourceVoice,
          depth + 1,
          visited,
        );
        break;

      case 'autoFollow':
        if (!openEnded) {
          this.fireCue(
            targetIndex,
            basePreWaitSamples + secondsToSamples(playLength, sampleRate) + delaySamples,
            sourceVoice,
            depth + 1,
            visited,
          );
        } else if (sourceVoice !== null) {
          // Nothing can predict the end, so watch for it instead. An open-ended
          // cue holding no voice — a remote streaming cue — drops its follow,
          // because there is nothing to watch.
          this.pendingFollows.push({
            source: sourceVoice,
            targetCueIndex: targetIndex,
            delaySeconds: cue.link.delay,
          });
        }
        break;

      case 'crossfade': {
        if (openEnded) {
          // A crossfade "before the end" is meaningless without an end.
          // Degrade to following it — and note link.delay is dropped here, not
          // carried, matching AudioEngine.cpp:482.
          if (sourceVoice !== null) {
            this.pendingFollows.push({
              source: sourceVoice,
              targetCueIndex: targetIndex,
              delaySeconds: 0,
            });
          }
          break;
        }

        // link.delay is ignored by a crossfade, by design (Cue.h:44).
        const crossfade = Math.min(Math.max(cue.link.duration, 0), playLength);
        const overlapStart = secondsToSamples(playLength - crossfade, sampleRate);

        this.fireCue(
          targetIndex,
          basePreWaitSamples + overlapStart,
          sourceVoice,
          depth + 1,
          visited,
        );

        // The other clock: counted from the first sounding sample, so no
        // basePreWaitSamples here. See the note at the top of this file.
        if (sourceVoice !== null) {
          this.host.scheduleStop(
            sourceVoice,
            overlapStart,
            secondsToSamples(crossfade, sampleRate),
            cue.link.shape,
          );
        }
        break;
      }
    }
  }

  //== Stopping =============================================================

  stopVoice(ref: VoiceRef, fadeSeconds: number, shape: FadeShape = 'equalPower'): void {
    if (this.pool.get(ref) === undefined) return;

    this.host.stopVoice(ref, secondsToSamples(fadeSeconds, this.host.sampleRate), shape);
    this.cancelChildrenOf(ref);
    this.changed();
  }

  stopCue(cueId: string, fadeSeconds: number): void {
    for (const record of this.pool.forCue(cueId)) {
      this.stopVoice(record.ref, fadeSeconds);
    }
  }

  stopAll(fadeSeconds: number): void {
    const fadeSamples = secondsToSamples(fadeSeconds, this.host.sampleRate);

    for (const record of this.pool.all()) {
      this.host.stopVoice(record.ref, fadeSamples, 'equalPower');
    }

    this.pendingFollows = [];
    this.changed();
  }

  /** Instant silence. Cancels pending pre-waits as well as anything sounding,
      and clears the operator's pause so the next GO is heard. */
  panic(): void {
    for (const record of this.pool.all()) {
      this.host.stopVoice(record.ref, 0, 'linear');
    }

    this.pendingFollows = [];
    this.globallyPaused = false;
    this.changed();
  }

  /** AudioEngine::cancelChildrenOf (AudioEngine.cpp:508-533).

      Only cancels what has not been heard yet: a successor already sounding is
      the operator's to stop, not something to cut off behind their back. */
  private cancelChildrenOf(ref: VoiceRef): void {
    for (const child of this.pool.childrenOf(ref)) {
      const state = this.host.voiceState(child.ref);

      if (state === VoiceState.preWait || state === VoiceState.reserved) {
        this.host.stopVoice(child.ref, 0, 'linear');
        this.cancelChildrenOf(child.ref);
      }
    }

    this.pendingFollows = this.pendingFollows.filter(
      (f) => !(f.source.slot === ref.slot && f.source.generation === ref.generation),
    );
  }

  //== Vamps and pause ======================================================

  releaseVamp(cueId: string): void {
    for (const record of this.pool.forCue(cueId)) {
      this.host.releaseVamp(record.ref);
    }
    this.changed();
  }

  /** Releases one voice rather than every voice of its cue. The running-cue
      panel needs this: it lists voices, and a cue firing twice shows twice. */
  releaseVampVoice(ref: VoiceRef): void {
    if (this.pool.get(ref) === undefined) return;

    this.host.releaseVamp(ref);
    this.changed();
  }

  releaseAllVamps(): void {
    for (const record of this.pool.all()) {
      if (this.host.voiceIsVamping(record.ref)) this.host.releaseVamp(record.ref);
    }
    this.changed();
  }

  isAnythingVamping(): boolean {
    return this.pool.all().some((r) => this.host.voiceIsVamping(r.ref));
  }

  setPaused(paused: boolean): void {
    this.globallyPaused = paused;

    for (const record of this.pool.all()) {
      this.host.setPaused(record.ref, paused);
    }

    this.changed();
  }

  //== Events from the engine ===============================================

  /** The engine reports a finished voice. This replaces the desktop's 30 Hz
      timer poll (AudioEngine.cpp:840-894): a message arrives promptly even in a
      backgrounded tab, where a timer would be throttled to 1 Hz and a follow
      could land a second late.

      Follows fire BEFORE the slot is released, matching the desktop, so the
      follow cannot be handed the slot its own source just vacated. */
  handleVoiceFinished(ref: VoiceRef): void {
    const record = this.pool.get(ref);

    // A stale event from a previous occupant of this slot. Discard it — this is
    // the whole reason the generation exists.
    if (record === undefined) return;

    const due = this.pendingFollows.filter(
      (f) => f.source.slot === ref.slot && f.source.generation === ref.generation,
    );

    this.pendingFollows = this.pendingFollows.filter((f) => !due.includes(f));

    for (const follow of due) {
      // A fresh visited set and depth 0, and no parent: the followed cue is not
      // a child of the finished voice, so it survives a later cancel. It can
      // also re-enter cues already fired in the original chain.
      this.fireCue(
        follow.targetCueIndex,
        secondsToSamples(follow.delaySeconds, this.host.sampleRate),
        null,
        0,
        [],
      );
    }

    this.pool.release(ref);
    this.changed();
  }

  //== State for the UI =====================================================

  getActiveCues(): ActiveCueInfo[] {
    const rate = this.host.sampleRate > 0 ? this.host.sampleRate : 48000;
    const out: ActiveCueInfo[] = [];

    for (const record of this.pool.all()) {
      const state = this.host.voiceState(record.ref);

      if (state === VoiceState.idle || state === VoiceState.finished) continue;

      const cue = this.cues.find((c) => c.id === record.cueId);
      const elapsed = this.host.voiceSounded(record.ref) / rate;
      const length = cue ? playbackLength(cue) : 0;

      out.push({
        ref: record.ref,
        cueId: record.cueId,
        number: cue?.number ?? '',
        name: cue?.name ?? '',
        elapsed,
        remaining: length > 0 ? Math.max(0, length - elapsed) : -1,
        position: this.host.voicePosition(record.ref) / rate,
        inPreWait: state === VoiceState.preWait || state === VoiceState.reserved,
        vamping: this.host.voiceIsVamping(record.ref),
        vampPasses: this.host.voiceVampPasses(record.ref),
        playPasses: this.host.voicePlayPasses(record.ref),
        stopping: state === VoiceState.stopping,
        paused: this.globallyPaused,
        gain: this.host.voiceGain(record.ref),
      });
    }

    return out;
  }

  private setError(message: string): void {
    this.errors.push(message);
  }

  private changed(): void {
    this.onChanged?.();
  }
}
