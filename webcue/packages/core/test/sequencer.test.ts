// GO, pinned against MainComponent::fireStandbyStep (MainComponent.cpp:734-786).
//
// "GO walks the cue's lifecycle one step at a time" is the single most
// important rule in the app. Get it wrong and webcue misrepresents SimpleCue
// rather than merely being a reduced version of it.

import { beforeEach, describe, expect, it } from 'vitest';

import type { Cue } from '../src/index.js';
import { Sequencer, cueHeaderStep, makeCue } from '../src/index.js';
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

beforeEach(() => {
  host = new FakeVoiceHost({ sampleRate: SR });
  sources = new FakeSourceRegistry();
  seq = new Sequencer({ host, sources });
  host.onVoiceFinished((ref) => seq.handleVoiceFinished(ref));
});

describe('GO from a cue header', () => {
  it('fires the cue and moves standby past its Play step', () => {
    seq.setCues([audio('1', 10), audio('2', 10)]);

    expect(seq.getStandby()).toEqual({ index: 0, step: cueHeaderStep });
    expect(seq.go()).toBe(true);

    expect(host.callsOfType('startVoice')).toHaveLength(1);
    // Steps are [play, end]; Play already happened, so standby offers end.
    expect(seq.getStandby()).toEqual({ index: 0, step: 1 });
  });

  it('does not fire a container cue, but still advances', () => {
    const cue = audio('1', 10, { firePlayWithCue: false });
    seq.setCues([cue, audio('2', 10)]);

    expect(seq.go()).toBe(true);
    expect(host.callsOfType('startVoice')).toHaveLength(0);
    expect(seq.getStandby()).toEqual({ index: 0, step: 0 }); // Play now offered
  });
});

describe('GO walks a vamped cue', () => {
  it('goes play -> devamp -> fade/stop -> next cue', () => {
    const cue = audio('1', 20, {
      vampEnabled: true,
      vampStart: 5,
      vampEnd: 10,
      endFadeTime: 4,
    });

    seq.setCues([cue, audio('2', 10)]);

    // 1: the header fires the cue.
    seq.go();
    expect(host.callsOfType('startVoice')).toHaveLength(1);
    expect(seq.getStandby()).toEqual({ index: 0, step: 1 });

    // 2: devamp releases the vamp — on the CUE, so on every voice of it.
    seq.go();
    expect(host.callsOfType('releaseVamp')).toHaveLength(1);
    expect(seq.getStandby()).toEqual({ index: 0, step: 2 });

    // 3: Fade/Stop stops it over the cue's own end fade time.
    seq.go();
    expect(host.callsOfType('stopVoice')[0]?.fadeSamples).toBe(4 * SR);
    expect(seq.getStandby()).toEqual({ index: 1, step: cueHeaderStep });
  });

  it('devamps every voice when a cue is firing twice', () => {
    const cue = audio('1', 20, { vampEnabled: true, vampStart: 5, vampEnd: 10 });
    seq.setCues([cue]);

    seq.fireCueByIndex(0);
    seq.fireCueByIndex(0);

    seq.releaseVamp(cue.id);

    expect(host.callsOfType('releaseVamp')).toHaveLength(2);
  });
});

describe('the Fade/Stop step', () => {
  it('cuts instantly when endAction is hardStop', () => {
    const cue = audio('1', 10, { endAction: 'hardStop', endFadeTime: 5 });
    seq.setCues([cue]);

    seq.go(); // header, fires
    seq.go(); // end step

    expect(host.callsOfType('stopVoice')[0]?.fadeSamples).toBe(0);
  });
});

describe('standby advances even when a step fails', () => {
  it('does not strand the operator on a cue that cannot fire', () => {
    // A missing file must not mean GO stops working. The desktop advances
    // regardless and lets the caller report the error.
    const missing = makeCue({
      number: '1',
      name: 'Missing',
      audioFile: 'nowhere.wav',
      fileDuration: 10,
      endTime: 10,
    });

    seq.setCues([missing, audio('2', 10)]);

    expect(seq.go()).toBe(false);
    expect(seq.getLastError()).toMatch(/Could not load/);
    expect(seq.getStandby()).toEqual({ index: 0, step: 1 });
  });
});

describe('fireCueAsWhole — MainComponent.cpp:715-732', () => {
  it('fires a normal cue', () => {
    seq.setCues([audio('1', 10), audio('2', 10)]);

    expect(seq.fireCueAsWhole(0)).toBe(true);
    expect(host.callsOfType('startVoice')).toHaveLength(1);
  });

  it('only stands by a container cue', () => {
    const cue = audio('1', 10, { firePlayWithCue: false });
    seq.setCues([audio('0', 10), cue]);

    expect(seq.fireCueAsWhole(1)).toBe(true);
    expect(host.callsOfType('startVoice')).toHaveLength(0);
    expect(seq.getStandby()).toEqual({ index: 1, step: cueHeaderStep });
  });
});

describe('getActiveCues', () => {
  it('reports elapsed, position and an open-ended remaining', () => {
    const finite = audio('1', 10);
    const endless = audio('2', 10, { loopEnabled: true, loopCount: 0 });

    seq.setCues([finite, endless]);
    seq.fireCueByIndex(0);
    seq.fireCueByIndex(1);

    host.advanceSeconds(3);

    const active = seq.getActiveCues();
    expect(active).toHaveLength(2);

    const one = active.find((a) => a.number === '1');
    expect(one?.elapsed).toBeCloseTo(3, 5);
    expect(one?.remaining).toBeCloseTo(7, 5);

    const two = active.find((a) => a.number === '2');
    expect(two?.remaining).toBe(-1); // open-ended
  });

  it('reports a cue still in its pre-wait', () => {
    seq.setCues([audio('1', 10, { preWait: 5 })]);
    seq.fireCueByIndex(0);

    expect(seq.getActiveCues()[0]?.inPreWait).toBe(true);

    host.advanceSeconds(6);
    expect(seq.getActiveCues()[0]?.inPreWait).toBe(false);
  });

  it('drops a voice once it has finished', () => {
    seq.setCues([audio('1', 2)]);
    seq.fireCueByIndex(0);

    expect(seq.getActiveCues()).toHaveLength(1);

    host.advanceSeconds(2.5);
    expect(seq.getActiveCues()).toHaveLength(0);
  });
});

describe('pause', () => {
  it('applies to every sounding voice and to voices fired later', () => {
    seq.setCues([audio('1', 10), audio('2', 10)]);
    seq.fireCueByIndex(0);

    seq.setPaused(true);
    expect(host.callsOfType('setPaused')).toHaveLength(1);
    expect(seq.isPaused()).toBe(true);

    seq.setPaused(false);
    expect(host.callsOfType('setPaused')).toHaveLength(2);
  });
});
