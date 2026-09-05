// Link scheduling, pinned against AudioEngine::scheduleLink
// (AudioEngine.cpp:413-505).
//
// These assert SAMPLE OFFSETS, not that something played. That is the point:
// every failure mode here is a timing error that sounds like a slightly
// different performance rather than like a bug.

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

function load(cues: Cue[]): void {
  seq.setCues(cues);
}

beforeEach(() => {
  host = new FakeVoiceHost({ sampleRate: SR });
  sources = new FakeSourceRegistry();
  seq = new Sequencer({ host, sources });
  host.onVoiceFinished((ref) => seq.handleVoiceFinished(ref));
});

describe('the two clocks — the most valuable test here', () => {
  it('gives the target an offset INCLUDING the pre-wait and the stop one EXCLUDING it', () => {
    // Source: 2 s pre-wait, 10 s long, crossfading 3 s into the next cue.
    //
    //   target pre-wait  = 2 s pre-wait + 7 s overlap start  = 9 s
    //   scheduleStop at  =               7 s overlap start   = 7 s
    //
    // scheduleStop counts from the voice's first SOUNDING sample, so the
    // pre-wait is absent from it and present in the other. Swap them and every
    // crossfade in a show with a pre-wait is late by exactly the pre-wait.
    const a = audio('1', 10, {
      preWait: 2,
      link: { mode: 'crossfade', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });
    const b = audio('2', 10);

    load([a, b]);
    seq.fireCueByIndex(0);

    const starts = host.callsOfType('startVoice');
    expect(starts).toHaveLength(2);

    expect(starts[0]?.spec.preWaitSamples).toBe(2 * SR);
    expect(starts[1]?.spec.preWaitSamples).toBe(9 * SR);

    const scheduled = host.callsOfType('scheduleStop');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.atSounded).toBe(7 * SR);
    expect(scheduled[0]?.fadeSamples).toBe(3 * SR);
  });
});

describe('autoContinue — AudioEngine.cpp:448-453', () => {
  it('carries the pre-wait through and adds the delay', () => {
    const a = audio('1', 10, {
      preWait: 1.5,
      link: { mode: 'autoContinue', target: null, delay: 0.5, duration: 3, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    const starts = host.callsOfType('startVoice');
    expect(starts[1]?.spec.preWaitSamples).toBe(2 * SR); // 1.5 + 0.5
  });

  it('fires even when the source is open-ended', () => {
    // autoContinue fires relative to the START, so nothing about it needs the
    // end to be predictable.
    const a = audio('1', 10, {
      loopEnabled: true,
      loopCount: 0,
      link: { mode: 'autoContinue', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')).toHaveLength(2);
  });
});

describe('autoFollow — AudioEngine.cpp:456-473', () => {
  it('pre-schedules a determinate cue at preWait + length + delay', () => {
    const a = audio('1', 10, {
      preWait: 1,
      link: { mode: 'autoFollow', target: null, delay: 2, duration: 3, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')[1]?.spec.preWaitSamples).toBe(13 * SR);
  });

  it('counts finite loop repeats into the length', () => {
    const a = audio('1', 4, {
      loopEnabled: true,
      loopCount: 3,
      link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')[1]?.spec.preWaitSamples).toBe(12 * SR);
  });

  it('waits for the finish instead when the source is open-ended', () => {
    const a = audio('1', 10, {
      vampEnabled: true,
      vampStart: 2,
      vampEnd: 5,
      link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    // Only the source has started; the follow is armed, not scheduled.
    expect(host.callsOfType('startVoice')).toHaveLength(1);

    host.forceFinish({ slot: 0, generation: 1 });

    expect(host.callsOfType('startVoice')).toHaveLength(2);
  });

  it('applies the delay as a pre-wait on the followed cue', () => {
    const a = audio('1', 10, {
      loopEnabled: true,
      loopCount: 0,
      link: { mode: 'autoFollow', target: null, delay: 1.5, duration: 3, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);
    host.forceFinish({ slot: 0, generation: 1 });

    expect(host.callsOfType('startVoice')[1]?.spec.preWaitSamples).toBe(1.5 * SR);
  });
});

describe('crossfade — AudioEngine.cpp:475-499', () => {
  it('clamps the duration to the playable length', () => {
    // A 30 s crossfade on a 4 s cue becomes a 4 s crossfade starting at 0.
    const a = audio('1', 4, {
      link: { mode: 'crossfade', target: null, delay: 0, duration: 30, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    const scheduled = host.callsOfType('scheduleStop')[0];
    expect(scheduled?.atSounded).toBe(0);
    expect(scheduled?.fadeSamples).toBe(4 * SR);
  });

  it('ignores link.delay entirely', () => {
    // Documented at Cue.h:44. A delay on a crossfade is meaningless — the
    // overlap already says when the next cue starts.
    const withDelay = audio('1', 10, {
      link: { mode: 'crossfade', target: null, delay: 5, duration: 2, shape: 'equalPower' },
    });

    load([withDelay, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')[1]?.spec.preWaitSamples).toBe(8 * SR);
    expect(host.callsOfType('scheduleStop')[0]?.atSounded).toBe(8 * SR);
  });

  it('uses the link shape for the fade, not the cue fade shape', () => {
    const a = audio('1', 10, {
      fadeOutShape: 'linear',
      link: { mode: 'crossfade', target: null, delay: 0, duration: 2, shape: 'sCurve' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('scheduleStop')[0]?.shape).toBe('sCurve');
  });

  it('degrades to a follow with NO delay when the source is open-ended', () => {
    // AudioEngine.cpp:482 passes 0.0, not link.delay. A crossfade "before the
    // end" is meaningless without an end.
    const a = audio('1', 10, {
      loopEnabled: true,
      loopCount: 0,
      link: { mode: 'crossfade', target: null, delay: 4, duration: 2, shape: 'equalPower' },
    });

    load([a, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('scheduleStop')).toHaveLength(0);

    host.forceFinish({ slot: 0, generation: 1 });

    expect(host.callsOfType('startVoice')[1]?.spec.preWaitSamples).toBe(0);
  });
});

describe('link targets', () => {
  it('follows an explicit target rather than the next cue', () => {
    const cues = [audio('1', 10), audio('2', 10), audio('3', 10)];
    cues[0]!.link = {
      mode: 'autoContinue',
      target: cues[2]!.id,
      delay: 0,
      duration: 3,
      shape: 'equalPower',
    };

    load(cues);
    seq.fireCueByIndex(0);

    const starts = host.callsOfType('startVoice');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.spec.sourceIndex).toBe(sources.get('3.wav')?.index);
  });

  it('does nothing when a null target has no next cue', () => {
    const a = audio('1', 10, {
      link: { mode: 'autoContinue', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([a]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')).toHaveLength(1);
  });

  it('refuses to link a cue to itself', () => {
    const cues = [audio('1', 10)];
    cues[0]!.link = {
      mode: 'autoContinue',
      target: cues[0]!.id,
      delay: 0,
      duration: 3,
      shape: 'equalPower',
    };

    load(cues);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')).toHaveLength(1);
  });
});

describe('cycle and depth guards — AudioEngine.cpp:331-338', () => {
  it('fires each cue once around a ring and reports the loop', () => {
    const cues = [audio('1', 10), audio('2', 10)];
    cues[0]!.link = { mode: 'autoContinue', target: cues[1]!.id, delay: 0, duration: 3, shape: 'equalPower' };
    cues[1]!.link = { mode: 'autoContinue', target: cues[0]!.id, delay: 0, duration: 3, shape: 'equalPower' };

    load(cues);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')).toHaveLength(2);
    expect(seq.getLastError()).toMatch(/loops back on itself/);
  });

  it('stops a long chain at the depth limit rather than spinning', () => {
    const cues = Array.from({ length: 40 }, (_, i) => audio(String(i + 1), 5));

    for (let i = 0; i < cues.length - 1; i++) {
      cues[i]!.link = { mode: 'autoContinue', target: null, delay: 0, duration: 3, shape: 'equalPower' };
    }

    load(cues);
    seq.fireCueByIndex(0);

    // 32 voices is the pool ceiling, so exhaustion bites before depth does —
    // and either way the chain terminates instead of recursing forever.
    expect(host.callsOfType('startVoice').length).toBeLessThanOrEqual(32);
    expect(seq.getLastError()).not.toBe('');
  });
});

describe('failures truncate the chain', () => {
  it('does not schedule a link when the cue could not be built', () => {
    const missing = makeCue({
      number: '1',
      name: 'Missing',
      audioFile: 'nowhere.wav',
      fileDuration: 10,
      endTime: 10,
      link: { mode: 'autoContinue', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([missing, audio('2', 10)]);

    expect(seq.fireCueByIndex(0)).toBe(false);
    expect(host.callsOfType('startVoice')).toHaveLength(0);
    expect(seq.getLastError()).toMatch(/Could not load/);
  });

  it('collects every error in a chain rather than keeping only the last', () => {
    const cues = [audio('1', 10), audio('2', 10)];
    cues[0]!.link = { mode: 'autoContinue', target: cues[1]!.id, delay: 0, duration: 3, shape: 'equalPower' };
    cues[1]!.link = { mode: 'autoContinue', target: cues[0]!.id, delay: 0, duration: 3, shape: 'equalPower' };

    load(cues);
    seq.fireCueByIndex(0);

    expect(seq.getErrors().length).toBeGreaterThan(0);
  });
});

describe('a control cue links onward without taking a voice', () => {
  it('fires its target with only the pre-wait', () => {
    const control = makeCue({
      number: '1',
      type: 'control',
      outputMessages: [{}],
      preWait: 0.5,
      link: { mode: 'autoContinue', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([control, audio('2', 10)]);
    seq.fireCueByIndex(0);

    const starts = host.callsOfType('startVoice');
    expect(starts).toHaveLength(1); // only the audio cue
    expect(starts[0]?.spec.preWaitSamples).toBe(0.5 * SR);
  });

  it('auto-follows immediately, because a control cue finishes at once', () => {
    // playbackLength is 0 and isOpenEnded is false, which is what separates
    // "finishes immediately" from "cannot be predicted".
    const control = makeCue({
      number: '1',
      type: 'control',
      outputMessages: [{}],
      link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    });

    load([control, audio('2', 10)]);
    seq.fireCueByIndex(0);

    expect(host.callsOfType('startVoice')[0]?.spec.preWaitSamples).toBe(0);
  });
});
