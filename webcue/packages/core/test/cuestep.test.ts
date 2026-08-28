// Sub-cue derivation, pinned against Source/Model/CueStep.cpp:8-66.
//
// The assertions about step counts are the same ones the desktop test suite
// makes at Tests/ControlTests.cpp:1183 ("a plain cue has two sub-cues") and
// :1207 ("the vamped cue has three sub-cues"). Each test cites the C++ it is
// pinned to, so when the desktop changes, the drift is traceable rather than
// mysterious.

import { describe, expect, it } from 'vitest';

import { makeCue } from '../src/cue.js';
import { buildCueSteps, formatTime } from '../src/cuestep.js';

describe('buildCueSteps — CueStep.cpp:8-66', () => {
  it('gives a plain cue two steps: play and end (ControlTests.cpp:1183)', () => {
    const steps = buildCueSteps(makeCue({ fileDuration: 10, endTime: 10 }));

    expect(steps.map((s) => s.type)).toEqual(['play', 'end']);
    expect(steps[0]?.label).toBe('Play cue');
    expect(steps[1]?.label).toBe('Fade/Stop');
  });

  it('gives a vamped cue three steps (ControlTests.cpp:1207)', () => {
    const cue = makeCue({
      fileDuration: 20,
      endTime: 20,
      vampEnabled: true,
      vampStart: 5,
      vampEnd: 10,
    });

    expect(buildCueSteps(cue).map((s) => s.type)).toEqual(['play', 'devamp', 'end']);
  });

  it('omits devamp when the vamp region is unusable', () => {
    // vampEnd <= vampStart, so hasUsableVamp() is false even though the flag is on.
    const cue = makeCue({
      fileDuration: 20,
      endTime: 20,
      vampEnabled: true,
      vampStart: 10,
      vampEnd: 10,
    });

    expect(buildCueSteps(cue).map((s) => s.type)).toEqual(['play', 'end']);
  });

  it('omits devamp when the vamp starts before the in point', () => {
    // hasUsableVamp compares vampStart against startTime, not against zero.
    const cue = makeCue({
      fileDuration: 20,
      startTime: 8,
      endTime: 20,
      vampEnabled: true,
      vampStart: 5,
      vampEnd: 12,
    });

    expect(buildCueSteps(cue).map((s) => s.type)).toEqual(['play', 'end']);
  });

  it('collapses a control cue to a single step', () => {
    const cue = makeCue({ type: 'control', outputMessages: [{}, {}] });
    const steps = buildCueSteps(cue);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe('Fire messages');
    expect(steps[0]?.detail).toBe('2 messages');
  });

  it('singularises one message', () => {
    const cue = makeCue({ type: 'control', outputMessages: [{}] });
    expect(buildCueSteps(cue)[0]?.detail).toBe('1 message');
  });

  it('prefers pre-wait over fade-in in the play detail', () => {
    const cue = makeCue({ fileDuration: 10, endTime: 10, preWait: 1.5, fadeInTime: 2 });
    expect(buildCueSteps(cue)[0]?.detail).toBe('after 1.50s pre-wait');
  });

  it('falls back to the fade-in when there is no pre-wait', () => {
    const cue = makeCue({ fileDuration: 10, endTime: 10, fadeInTime: 2 });
    expect(buildCueSteps(cue)[0]?.detail).toBe('2.0s fade in');
  });

  it('describes both vamp release modes', () => {
    const base = {
      fileDuration: 60,
      endTime: 60,
      vampEnabled: true,
      vampStart: 12.3,
      vampEnd: 41,
    };

    expect(buildCueSteps(makeCue(base))[1]?.detail).toBe('00:12.3 to 00:41.0, finishes the pass');

    expect(buildCueSteps(makeCue({ ...base, vampRelease: 'immediately' }))[1]?.detail).toBe(
      '00:12.3 to 00:41.0, leaves at once',
    );
  });

  it('describes the end step from endAction', () => {
    expect(buildCueSteps(makeCue({ fileDuration: 5, endTime: 5 }))[1]?.detail).toBe(
      '3.0s fade out',
    );

    expect(
      buildCueSteps(makeCue({ fileDuration: 5, endTime: 5, endAction: 'hardStop' }))[1]?.detail,
    ).toBe('hard stop');
  });
});

describe('formatTime — LookAndFeel.cpp:142-158', () => {
  it('formats mm:ss.t', () => {
    expect(formatTime(0)).toBe('00:00.0');
    expect(formatTime(12.34)).toBe('00:12.3');
    expect(formatTime(41)).toBe('00:41.0');
    expect(formatTime(90.06)).toBe('01:30.1');
  });

  it('adds hours past an hour', () => {
    expect(formatTime(3661.2)).toBe('1:01:01.2');
  });

  it('gives --:-- for negative input', () => {
    expect(formatTime(-1)).toBe('--:--');
    expect(formatTime(Number.NaN)).toBe('--:--');
  });
});
