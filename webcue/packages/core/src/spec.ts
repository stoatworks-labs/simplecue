// Building a VoiceSpec from a cue, ported from AudioEngine::buildSpec
// (AudioEngine.cpp:155-274).
//
// This is where seconds become samples and where a cue is refused. The clamps
// are load-bearing: a vamp whose markers fall outside the trimmed region must
// be dropped rather than armed, or the voice loops a boundary it can never
// reach (CueVoice.cpp:44-50 relies on this having been done here).

import type { Cue, FadeShape } from './cue.js';
import { effectiveRouting, hasUsableVamp, limits, resolvedEndTime } from './cue.js';
import type { SourceRegistry, SpecRoute, VoiceSpec } from './voicehost.js';
import { maxRoutesPerVoice } from './voicehost.js';

/** AudioEngine.cpp:137-143. Zero for a non-positive time, so a cue with no
    pre-wait is not one sample late. */
export function secondsToSamples(seconds: number, sampleRate: number): number {
  if (sampleRate <= 0 || seconds <= 0) return 0;
  return Math.round(seconds * sampleRate);
}

/** juce::Decibels::decibelsToGain with a -100 dB floor, matching the call at
    AudioEngine.cpp:168. Below the floor the gain is exactly zero, not an
    epsilon — that is what makes a -inf fader truly silent. */
export function decibelsToGain(db: number, minusInfinityDb = -100): number {
  return db > minusInfinityDb ? Math.pow(10, db * 0.05) : 0;
}

export interface BuildSpecContext {
  sampleRate: number;
  numOutputChannels: number;
  sources: SourceRegistry;
}

export type BuildSpecResult =
  | { ok: true; spec: VoiceSpec }
  | { ok: false; error: string };

function clamp(lower: number, upper: number, value: number): number {
  return value < lower ? lower : value > upper ? upper : value;
}

export function buildVoiceSpec(
  cue: Cue,
  ctx: BuildSpecContext,
  extraPreWaitSamples = 0,
  overrideStartSeconds = -1,
): BuildSpecResult {
  const { sampleRate, numOutputChannels } = ctx;

  if (sampleRate <= 0 || numOutputChannels <= 0) {
    return { ok: false, error: 'No audio device is open.' };
  }

  const s = (seconds: number) => secondsToSamples(seconds, sampleRate);

  const spec: VoiceSpec = {
    sourceIndex: -1,
    fromDeviceInput: false,
    inputFirstChannel: 0,
    inputNumChannels: 2,
    regionStart: 0,
    regionEnd: 0,
    preWaitSamples: s(cue.preWait) + Math.max(0, extraPreWaitSamples),
    loopEnabled: false,
    loopCount: 0,
    vampEnabled: false,
    vampStart: 0,
    vampEnd: 0,
    vampRelease: 0,
    gain: decibelsToGain(cue.gainDb),
    fadeInSamples: s(cue.fadeInTime),
    fadeInShape: cue.fadeInShape,
    fadeOutSamples: s(cue.fadeOutTime),
    fadeOutShape: cue.fadeOutShape,
    routes: [],
  };

  let numSourceChannels = 0;

  if (cue.type === 'streaming') {
    // A DELIBERATE DIVERGENCE. The desktop offers two paths: capture from a
    // loopback input, or drive a remote Connect device. A browser can do
    // neither — it cannot open a named input by channel offset, and the remote
    // path needs OAuth and a server. Saying so plainly is better than inheriting
    // the desktop's message, which would send the operator to an Audio setup
    // window that does not exist here.
    return {
      ok: false,
      error: `Cue "${cue.number || cue.name}" is a streaming cue, which needs a loopback input a browser cannot open.`,
    };
  }

  const source = ctx.sources.get(cue.audioFile);

  if (source === null) {
    return {
      ok: false,
      error:
        cue.audioFile.length > 0
          ? `Could not load ${cue.audioFile}`
          : `Cue "${cue.number || cue.name}" has no audio file.`,
    };
  }

  spec.sourceIndex = source.index;
  numSourceChannels = source.numChannels;

  const frames = source.numFrames;
  const startSeconds = overrideStartSeconds >= 0 ? overrideStartSeconds : cue.startTime;

  spec.regionStart = clamp(0, frames, s(startSeconds));

  const end = resolvedEndTime(cue);
  spec.regionEnd = end > 0 ? clamp(spec.regionStart, frames, s(end)) : frames;

  if (spec.regionEnd <= spec.regionStart) {
    return {
      ok: false,
      error: `Cue "${cue.name}" has no audio between its in and out points.`,
    };
  }

  spec.loopEnabled = cue.loopEnabled;
  spec.loopCount = cue.loopCount;

  if (hasUsableVamp(cue)) {
    const vs = clamp(spec.regionStart, spec.regionEnd, s(cue.vampStart));
    const ve = clamp(spec.regionStart, spec.regionEnd, s(cue.vampEnd));

    // Re-checked after clamping: markers that both land on the same boundary
    // would otherwise arm a zero-length vamp the voice can never leave.
    if (ve > vs) {
      spec.vampEnabled = true;
      spec.vampStart = vs;
      spec.vampEnd = ve;
      spec.vampRelease = cue.vampRelease === 'immediately' ? 1 : 0;
    }
  }

  const regionLength = spec.regionEnd - spec.regionStart;
  spec.fadeInSamples = Math.min(spec.fadeInSamples, regionLength);
  spec.fadeOutSamples = Math.min(spec.fadeOutSamples, regionLength);

  const routes = effectiveRouting(cue, numSourceChannels, numOutputChannels);

  if (routes.length === 0) {
    // On the desktop this means you plugged in the wrong interface. In a
    // browser it usually means the show was authored for more outputs than a
    // tab has — see isRoutedOffDevice(), which the app uses to offer a fold.
    return { ok: false, error: `Cue "${cue.name}" is not routed to any output.` };
  }

  spec.routes = routes.slice(0, maxRoutesPerVoice).map(
    (r): SpecRoute => ({ source: r.sourceChannel, output: r.outputChannel, gain: r.gain }),
  );

  return { ok: true, spec };
}

/** Fold every route onto the outputs that exist, preserving gains and summing
    sources that collide. The app offers this explicitly when a show is authored
    for more outputs than the browser has; it is never applied silently, because
    that would make webcue quietly disagree with the desktop about the mix. */
export function foldRoutingToOutputs(cue: Cue, numOutputChannels: number): Cue {
  if (numOutputChannels <= 0 || cue.routing.length === 0) return cue;

  return {
    ...cue,
    routing: cue.routing.map((r) => ({
      ...r,
      outputChannel: r.outputChannel % numOutputChannels,
      sourceChannel: Math.min(r.sourceChannel, limits.maxSourceChannels - 1),
    })),
  };
}

export type { FadeShape };
