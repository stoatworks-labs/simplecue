// Cancelling a link chain, pinned against AudioEngine::cancelChildrenOf
// (AudioEngine.cpp:508-533).
//
// The rule that matters: stopping a cue kills its pre-scheduled successors that
// have NOT yet been heard, recursively — and leaves alone any that are already
// sounding, because those are the operator's to stop.

import { beforeEach, describe, expect, it } from 'vitest';

import type { Cue } from '../src/index.js';
import { Sequencer, makeCue } from '../src/index.js';
import { FakeSourceRegistry, FakeVoiceHost } from './fakehost.js';

const SR = 48000;

let host: FakeVoiceHost;
let sources: FakeSourceRegistry;
let seq: Sequencer;

function audio(number: string, seconds: number, overrides: Partial<Cue> = {}): Cue {
  const file = `${number}.wav`;
  sources.add(file, seconds, SR);

  return makeCue({
    number,
    name: `Cue ${number}`,
    audioFile: file,
    fileDuration: seconds,
    fileChannels: 2,
    fileSampleRate: SR,
    endTime: seconds,
    ...overrides,
  });
}

const crossfadeTo = (duration: number): Cue['link'] => ({
  mode: 'crossfade',
  target: null,
  delay: 0,
  duration,
  shape: 'equalPower',
});

const continueTo = (delay: number): Cue['link'] => ({
  mode: 'autoContinue',
  target: null,
  delay,
  duration: 3,
  shape: 'equalPower',
});

beforeEach(() => {
  host = new FakeVoiceHost({ sampleRate: SR });
  sources = new FakeSourceRegistry();
  seq = new Sequencer({ host, sources });
  host.onVoiceFinished((ref) => seq.handleVoiceFinished(ref));
});

describe('cancelChildrenOf', () => {
  it('cancels a successor that has not been heard yet', () => {
    const a = audio('1', 10, { link: crossfadeTo(3) });
    seq.setCues([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.activeSlots()).toEqual([0, 1]);

    // Cue 2 is still in its pre-wait, so stopping cue 1 takes it with it.
    seq.stopCue(a.id, 1);

    const stops = host.callsOfType('stopVoice');
    expect(stops.map((s) => s.ref.slot)).toContain(1);
    expect(stops.find((s) => s.ref.slot === 1)?.fadeSamples).toBe(0);
  });

  it('leaves a successor alone once it has started sounding', () => {
    const a = audio('1', 10, { link: crossfadeTo(3) });
    seq.setCues([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    // Past the overlap, so cue 2 is audible. Cutting it off behind the
    // operator's back would be wrong.
    host.advanceSeconds(7.5);
    seq.stopCue(a.id, 1);

    expect(host.callsOfType('stopVoice').map((s) => s.ref.slot)).not.toContain(1);
  });

  it('cancels recursively down a chain', () => {
    // A -> B -> C, all pre-scheduled. The parent threaded down the chain is A's
    // voice throughout, matching the C++, so stopping A reaches C.
    const a = audio('1', 10, { link: continueTo(2) });
    const b = audio('2', 10, { link: continueTo(2) });
    seq.setCues([a, b, audio('3', 10)]);
    seq.fireCueByIndex(0);

    expect(host.activeSlots()).toEqual([0, 1, 2]);

    seq.stopCue(a.id, 0);

    const stopped = new Set(host.callsOfType('stopVoice').map((s) => s.ref.slot));
    expect(stopped).toContain(1);
    expect(stopped).toContain(2);
  });

  it('drops a pending follow waiting on the stopped voice', () => {
    const a = audio('1', 10, {
      loopEnabled: true,
      loopCount: 0,
      link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    seq.setCues([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    seq.stopCue(a.id, 0);

    // The stop finished the voice; the follow must not fire behind it.
    expect(host.callsOfType('startVoice')).toHaveLength(1);
  });
});

describe('stopAll and panic', () => {
  it('stopAll stops everything and clears pending follows', () => {
    const a = audio('1', 10, {
      loopEnabled: true,
      loopCount: 0,
      link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    seq.setCues([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    seq.stopAll(2);

    expect(host.callsOfType('stopVoice')[0]?.fadeSamples).toBe(2 * SR);
    expect(host.callsOfType('startVoice')).toHaveLength(1);
  });

  it('panic stops instantly and clears the operator pause', () => {
    seq.setCues([audio('1', 10)]);
    seq.fireCueByIndex(0);
    seq.setPaused(true);

    expect(seq.isPaused()).toBe(true);

    seq.panic();

    expect(seq.isPaused()).toBe(false);
    const stops = host.callsOfType('stopVoice');
    expect(stops[stops.length - 1]?.fadeSamples).toBe(0);
  });
});

describe('generation guards', () => {
  it('ignores a finish reported for a slot that has been reused', () => {
    seq.setCues([audio('1', 1)]);
    seq.fireCueByIndex(0);

    const stale = { slot: 0, generation: 1 };
    host.advanceSeconds(1.5); // finishes and releases slot 0

    seq.fireCueByIndex(0); // slot 0 again, generation 2
    const before = host.callsOfType('startVoice').length;

    seq.handleVoiceFinished(stale); // must be discarded

    expect(host.callsOfType('startVoice')).toHaveLength(before);
    expect(seq.busyVoices).toBe(1);
  });

  it('fires a follow before releasing the slot, so it cannot reuse it', () => {
    const a = audio('1', 2, {
      vampEnabled: true,
      vampStart: 0.5,
      vampEnd: 1,
      link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    seq.setCues([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    host.forceFinish({ slot: 0, generation: 1 });

    const starts = host.callsOfType('startVoice');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.ref.slot).not.toBe(0);
  });
});

describe('the voice pool', () => {
  it('refuses a fire when every voice is in use', () => {
    const host32 = new FakeVoiceHost({ sampleRate: SR, maxVoices: 2 });
    const seq2 = new Sequencer({ host: host32, sources });

    const cue = audio('1', 30);
    seq2.setCues([cue]);

    expect(seq2.fireCueByIndex(0)).toBe(true);
    expect(seq2.fireCueByIndex(0)).toBe(true);
    expect(seq2.fireCueByIndex(0)).toBe(false);
    expect(seq2.getLastError()).toMatch(/voices are in use/);
  });

  it('lets one cue occupy several voices, so it can overlap itself', () => {
    seq.setCues([audio('1', 30)]);
    seq.fireCueByIndex(0);
    seq.fireCueByIndex(0);

    expect(seq.busyVoices).toBe(2);
  });

  it('stopCue stops every voice of that cue', () => {
    const cue = audio('1', 30);
    seq.setCues([cue]);
    seq.fireCueByIndex(0);
    seq.fireCueByIndex(0);

    seq.stopCue(cue.id, 1);

    expect(host.callsOfType('stopVoice')).toHaveLength(2);
  });
});
