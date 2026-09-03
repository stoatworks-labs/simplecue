// The seam between the sequencer and whatever actually makes sound.
//
// The sequencer must be testable without an AudioContext, so it never sees the
// wasm engine, a MessagePort or a Promise — only this. packages/engine
// implements it over the AudioWorklet; the test suite implements it as a fake
// with a sample clock.
//
// Every method is synchronous and fire-and-forget. The host NEVER allocates a
// slot: allocation is the sequencer's, on the main thread, because scheduleLink
// recurses synchronously and has to know the slot before the next call. That is
// the same reason CueVoice has a `reserved` state (CueVoice.h:80-85).

import type { FadeShape } from './cue.js';

/** CueVoice.h:172 — the ceiling the wasm routes array is sized to. */
export const maxRoutesPerVoice = 128;

/** Mirrors CueVoice::State. The numbering matters: it crosses to wasm as-is. */
export const VoiceState = {
  idle: 0,
  reserved: 1,
  preWait: 2,
  playing: 3,
  stopping: 4,
  finished: 5,
} as const;

export type VoiceState = (typeof VoiceState)[keyof typeof VoiceState];

/** A voice's identity for one sounding. The slot alone is ambiguous because
    slots are reused; the generation is what makes the pair stable, and is what
    stops a stale follow firing against a recycled slot. */
export interface VoiceRef {
  readonly slot: number;
  readonly generation: number;
}

export interface SpecRoute {
  source: number;
  output: number;
  gain: number;
}

/** Everything the engine needs, already resolved to device samples. */
export interface VoiceSpec {
  sourceIndex: number;
  fromDeviceInput: boolean;
  inputFirstChannel: number;
  inputNumChannels: number;

  regionStart: number;
  regionEnd: number;
  preWaitSamples: number;

  loopEnabled: boolean;
  loopCount: number;

  vampEnabled: boolean;
  vampStart: number;
  vampEnd: number;
  vampRelease: 0 | 1;

  gain: number;

  fadeInSamples: number;
  fadeInShape: FadeShape;
  fadeOutSamples: number;
  fadeOutShape: FadeShape;

  routes: SpecRoute[];
}

export interface VoiceHost {
  readonly sampleRate: number;
  readonly maxVoices: number;
  readonly numOutputChannels: number;

  /** Collapses the desktop's setSpec-then-start pair, which exists only because
      of the lock-free FIFO. Safe here because allocation is on this thread. */
  startVoice(ref: VoiceRef, spec: VoiceSpec): void;

  stopVoice(ref: VoiceRef, fadeSamples: number, shape: FadeShape): void;
  scheduleStop(ref: VoiceRef, atSounded: number, fadeSamples: number, shape: FadeShape): void;
  releaseVamp(ref: VoiceRef): void;
  setPaused(ref: VoiceRef, paused: boolean): void;

  voiceState(ref: VoiceRef): VoiceState;
  voicePosition(ref: VoiceRef): number;
  voiceSounded(ref: VoiceRef): number;
  voiceIsVamping(ref: VoiceRef): boolean;
  voiceGain(ref: VoiceRef): number;
  voicePlayPasses(ref: VoiceRef): number;
  voiceVampPasses(ref: VoiceRef): number;
}

/** Decoded audio the engine already holds, keyed by the show's own path string. */
export interface SourceInfo {
  index: number;
  numFrames: number;
  numChannels: number;
}

export interface SourceRegistry {
  get(audioFile: string): SourceInfo | null;
}
