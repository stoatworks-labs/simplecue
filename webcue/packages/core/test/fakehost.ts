// A VoiceHost with a deterministic sample clock.
//
// It does NOT reimplement CueVoice — that is already proven against the native
// build, sample by sample, by webcue/test/parity_main.cpp. This models only what
// the SEQUENCER's decisions depend on: when a voice starts sounding, when it
// finishes, and whether it is open-ended.
//
// Because it advances in samples, tests can assert the thing that actually
// breaks — offsets — rather than asserting that something played.

import type {
  FadeShape,
  SourceInfo,
  SourceRegistry,
  VoiceHost,
  VoiceRef,
  VoiceSpec,
  VoiceState,
} from '../src/index.js';
import { VoiceState as State } from '../src/index.js';

export type HostCall =
  | { call: 'startVoice'; ref: VoiceRef; spec: VoiceSpec }
  | { call: 'stopVoice'; ref: VoiceRef; fadeSamples: number; shape: FadeShape }
  | { call: 'scheduleStop'; ref: VoiceRef; atSounded: number; fadeSamples: number; shape: FadeShape }
  | { call: 'releaseVamp'; ref: VoiceRef }
  | { call: 'setPaused'; ref: VoiceRef; paused: boolean };

interface FakeVoice {
  ref: VoiceRef;
  spec: VoiceSpec;
  state: VoiceState;
  preWaitLeft: number;
  sounded: number;
  position: number;
  /** Infinity for a vamp or an endless loop. */
  remaining: number;
  vamping: boolean;
  scheduledStopAt: number | null;
  playPasses: number;
  vampPasses: number;
}

export class FakeSourceRegistry implements SourceRegistry {
  private readonly sources = new Map<string, SourceInfo>();
  private nextIndex = 0;

  add(audioFile: string, seconds: number, sampleRate = 48000, numChannels = 2): SourceInfo {
    const info: SourceInfo = {
      index: this.nextIndex++,
      numFrames: Math.round(seconds * sampleRate),
      numChannels,
    };
    this.sources.set(audioFile, info);
    return info;
  }

  get(audioFile: string): SourceInfo | null {
    return this.sources.get(audioFile) ?? null;
  }
}

export class FakeVoiceHost implements VoiceHost {
  readonly sampleRate: number;
  readonly maxVoices: number;
  numOutputChannels: number;

  /** Every call, in order. Assertions read this rather than voice state. */
  readonly log: HostCall[] = [];

  private readonly voices = new Map<number, FakeVoice>();
  private finishedListener: ((ref: VoiceRef) => void) | null = null;

  constructor(options: { sampleRate?: number; maxVoices?: number; numOutputChannels?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.maxVoices = options.maxVoices ?? 32;
    this.numOutputChannels = options.numOutputChannels ?? 2;
  }

  onVoiceFinished(fn: (ref: VoiceRef) => void): void {
    this.finishedListener = fn;
  }

  //== VoiceHost ============================================================

  startVoice(ref: VoiceRef, spec: VoiceSpec): void {
    this.log.push({ call: 'startVoice', ref, spec });

    const endless =
      spec.vampEnabled || (spec.loopEnabled && spec.loopCount <= 0);

    const region = spec.regionEnd - spec.regionStart;
    const passes = spec.loopEnabled && spec.loopCount > 0 ? spec.loopCount : 1;

    this.voices.set(ref.slot, {
      ref,
      spec,
      state: spec.preWaitSamples > 0 ? State.preWait : State.playing,
      preWaitLeft: spec.preWaitSamples,
      sounded: 0,
      position: spec.regionStart,
      remaining: endless ? Number.POSITIVE_INFINITY : region * passes,
      vamping: false,
      scheduledStopAt: null,
      playPasses: 0,
      vampPasses: 0,
    });
  }

  stopVoice(ref: VoiceRef, fadeSamples: number, shape: FadeShape): void {
    this.log.push({ call: 'stopVoice', ref, fadeSamples, shape });

    const v = this.live(ref);
    if (!v) return;

    // Nothing has been heard yet, so there is nothing to fade — CueVoice.cpp:70-80.
    if (v.state === State.preWait || v.state === State.reserved || fadeSamples <= 0) {
      this.finish(v);
      return;
    }

    v.state = State.stopping;
    v.remaining = fadeSamples;
  }

  scheduleStop(ref: VoiceRef, atSounded: number, fadeSamples: number, shape: FadeShape): void {
    this.log.push({ call: 'scheduleStop', ref, atSounded, fadeSamples, shape });

    const v = this.live(ref);
    if (v) v.scheduledStopAt = atSounded;
  }

  releaseVamp(ref: VoiceRef): void {
    this.log.push({ call: 'releaseVamp', ref });

    const v = this.live(ref);
    if (!v) return;

    v.vamping = false;
    // Once released, what is left is the rest of the region.
    if (v.remaining === Number.POSITIVE_INFINITY && v.spec.vampEnabled) {
      v.remaining = v.spec.regionEnd - v.position;
    }
  }

  setPaused(ref: VoiceRef, paused: boolean): void {
    this.log.push({ call: 'setPaused', ref, paused });
  }

  voiceState(ref: VoiceRef): VoiceState {
    return this.live(ref)?.state ?? State.idle;
  }

  voicePosition(ref: VoiceRef): number {
    return this.live(ref)?.position ?? 0;
  }

  voiceSounded(ref: VoiceRef): number {
    return this.live(ref)?.sounded ?? 0;
  }

  voiceIsVamping(ref: VoiceRef): boolean {
    return this.live(ref)?.vamping ?? false;
  }

  voiceGain(ref: VoiceRef): number {
    return this.live(ref) ? 1 : 0;
  }

  voicePlayPasses(ref: VoiceRef): number {
    return this.live(ref)?.playPasses ?? 0;
  }

  voiceVampPasses(ref: VoiceRef): number {
    return this.live(ref)?.vampPasses ?? 0;
  }

  //== The clock ============================================================

  /** Steps forward in event-bounded chunks so nothing — a finish, a scheduled
      stop, the end of a pre-wait — is stepped over. */
  advanceSamples(total: number): void {
    let left = total;

    while (left > 0) {
      const step = Math.min(left, this.samplesToNextEvent());
      const chunk = step > 0 ? step : left;

      for (const v of [...this.voices.values()]) this.stepVoice(v, chunk);

      left -= chunk;

      // Finishing a voice can fire a follow, which starts another voice.
      for (const v of [...this.voices.values()]) {
        if (v.state === State.finished) this.reportFinished(v);
      }
    }
  }

  advanceSeconds(seconds: number): void {
    this.advanceSamples(Math.round(seconds * this.sampleRate));
  }

  /** Ends a voice outright, for cases a clock cannot reach — an endless loop
      the operator stops, or a vamp released off-screen. */
  forceFinish(ref: VoiceRef): void {
    const v = this.live(ref);
    if (!v) return;

    this.finish(v);
    this.reportFinished(v);
  }

  activeSlots(): number[] {
    return [...this.voices.keys()].sort((a, b) => a - b);
  }

  callsOfType<T extends HostCall['call']>(type: T): Extract<HostCall, { call: T }>[] {
    return this.log.filter((c): c is Extract<HostCall, { call: T }> => c.call === type);
  }

  //== Internals ============================================================

  private live(ref: VoiceRef): FakeVoice | undefined {
    const v = this.voices.get(ref.slot);
    return v && v.ref.generation === ref.generation ? v : undefined;
  }

  private samplesToNextEvent(): number {
    let soonest = Number.POSITIVE_INFINITY;

    for (const v of this.voices.values()) {
      if (v.state === State.preWait) soonest = Math.min(soonest, v.preWaitLeft);
      else if (v.state === State.playing || v.state === State.stopping) {
        soonest = Math.min(soonest, v.remaining);
        if (v.scheduledStopAt !== null) {
          soonest = Math.min(soonest, Math.max(0, v.scheduledStopAt - v.sounded));
        }
      }
    }

    return Number.isFinite(soonest) ? Math.max(1, soonest) : Number.POSITIVE_INFINITY;
  }

  private stepVoice(v: FakeVoice, samples: number): void {
    if (v.state === State.preWait) {
      const n = Math.min(samples, v.preWaitLeft);
      v.preWaitLeft -= n;
      if (v.preWaitLeft <= 0) v.state = State.playing;
      return;
    }

    if (v.state !== State.playing && v.state !== State.stopping) return;

    v.sounded += samples;
    v.position += samples;

    if (v.spec.vampEnabled && v.position >= v.spec.vampStart && v.remaining === Number.POSITIVE_INFINITY) {
      v.vamping = true;
      if (v.position >= v.spec.vampEnd) {
        v.position = v.spec.vampStart;
        v.vampPasses++;
      }
    }

    if (v.remaining !== Number.POSITIVE_INFINITY) {
      v.remaining -= samples;
      if (v.remaining <= 0) this.finish(v);
    }

    if (v.scheduledStopAt !== null && v.sounded >= v.scheduledStopAt) {
      v.scheduledStopAt = null;
      if (v.state === State.playing) v.state = State.stopping;
    }
  }

  private finish(v: FakeVoice): void {
    v.state = State.finished;
    v.vamping = false;
  }

  private reportFinished(v: FakeVoice): void {
    this.voices.delete(v.ref.slot);
    this.finishedListener?.(v.ref);
  }
}
