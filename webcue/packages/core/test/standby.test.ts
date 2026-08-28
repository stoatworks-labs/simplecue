// Standby advance, pinned against Source/Model/CueList.cpp:188-222.
//
// This is the app's core interaction — GO walks a cue's lifecycle one step at a
// time — and it is the thing a browser rebuild is most likely to get subtly
// wrong. Several of these tests exist to stop a future reader "fixing" a rule
// that only looks like a bug.

import { describe, expect, it } from 'vitest';

import { makeCue } from '../src/cue.js';
import { advanceStandby, clampStandby, resolveLinkTarget, standbyForCue } from '../src/cuelist.js';
import { cueHeaderStep } from '../src/cuestep.js';

const plain = (n: string) => makeCue({ number: n, fileDuration: 10, endTime: 10 });

const vamped = (n: string) =>
  makeCue({
    number: n,
    fileDuration: 20,
    endTime: 20,
    vampEnabled: true,
    vampStart: 5,
    vampEnd: 10,
  });

describe('advanceStandby — CueList.cpp:188-222', () => {
  it('skips the Play step from the header when firePlayWithCue is set', () => {
    // Firing the cue already fired its Play sub-cue, so standby must not offer
    // to play the same thing twice. Steps are [play, end]; it lands on end.
    const cues = [plain('1'), plain('2')];
    const next = advanceStandby(cues, { index: 0, step: cueHeaderStep });

    expect(next).toEqual({ index: 0, step: 1 });
  });

  it('offers the Play step when firePlayWithCue is off', () => {
    // The cue is then a container that does nothing until a sub-cue is fired.
    const cues = [plain('1'), plain('2')];
    cues[0]!.firePlayWithCue = false;

    expect(advanceStandby(cues, { index: 0, step: cueHeaderStep })).toEqual({ index: 0, step: 0 });
  });

  it('walks a vamped cue header -> devamp -> end -> next cue', () => {
    const cues = [vamped('1'), plain('2')];

    let sb = { index: 0, step: cueHeaderStep };
    sb = advanceStandby(cues, sb);
    expect(sb).toEqual({ index: 0, step: 1 }); // devamp

    sb = advanceStandby(cues, sb);
    expect(sb).toEqual({ index: 0, step: 2 }); // end

    sb = advanceStandby(cues, sb);
    expect(sb).toEqual({ index: 1, step: cueHeaderStep }); // next cue's header
  });

  it('parks on the last step of the last cue instead of wrapping', () => {
    // An accidental extra GO at the end of a show should do nothing, not
    // restart the top of the list (ControlTests.cpp:1223-1228).
    const cues = [plain('1')];

    let sb = { index: 0, step: cueHeaderStep };
    sb = advanceStandby(cues, sb);
    expect(sb).toEqual({ index: 0, step: 1 });

    for (let i = 0; i < 5; i++) sb = advanceStandby(cues, sb);
    expect(sb).toEqual({ index: 0, step: 1 });
  });

  it('falls straight through a control cue with firePlayWithCue set', () => {
    // PINNED DELIBERATELY. numSteps is 1, so firstSubCue (1) is not < 1 and the
    // header branch does not take. It reads accidental but is correct: the
    // single step already fired along with the header. Do not "fix" this.
    const cues = [makeCue({ type: 'control', number: '1', outputMessages: [{}] }), plain('2')];

    expect(advanceStandby(cues, { index: 0, step: cueHeaderStep })).toEqual({
      index: 1,
      step: cueHeaderStep,
    });
  });

  it('offers a control cue its step when firePlayWithCue is off', () => {
    const cues = [makeCue({ type: 'control', number: '1', outputMessages: [{}] }), plain('2')];
    cues[0]!.firePlayWithCue = false;

    expect(advanceStandby(cues, { index: 0, step: cueHeaderStep })).toEqual({ index: 0, step: 0 });
  });

  it('does nothing on an empty list', () => {
    const sb = { index: -1, step: cueHeaderStep };
    expect(advanceStandby([], sb)).toBe(sb);
  });
});

describe('clampStandby — CueList.cpp:242-259', () => {
  it('pulls the step back when an edit removes a sub-cue', () => {
    // Standby sits on a vamped cue's end step (index 2). Turning the vamp off
    // drops the devamp, leaving two steps — the step must not point past the end.
    const cues = [vamped('1')];
    const standby = { index: 0, step: 2 };

    cues[0]!.vampEnabled = false;

    expect(clampStandby(cues, standby)).toEqual({ index: 0, step: 1 });
  });

  it('resets to nothing when the list empties', () => {
    expect(clampStandby([], { index: 3, step: 1 })).toEqual({ index: -1, step: cueHeaderStep });
  });
});

describe('standbyForCue', () => {
  it('puts standby on the cue itself, not on a step', () => {
    expect(standbyForCue([plain('1'), plain('2')], 1)).toEqual({
      index: 1,
      step: cueHeaderStep,
    });
  });

  it('clamps an out-of-range index', () => {
    expect(standbyForCue([plain('1')], 9)).toEqual({ index: 0, step: cueHeaderStep });
  });
});

describe('resolveLinkTarget — CueList.cpp:229-240', () => {
  it('follows an explicit target by id', () => {
    const cues = [plain('1'), plain('2'), plain('3')];
    cues[0]!.link.target = cues[2]!.id;

    expect(resolveLinkTarget(cues, 0)?.number).toBe('3');
  });

  it('means "the next cue in the list" when the target is null', () => {
    // This is what lets a cue be inserted mid-chain without breaking the chain.
    const cues = [plain('1'), plain('2')];
    expect(resolveLinkTarget(cues, 0)?.number).toBe('2');
  });

  it('resolves to nothing past the end of the list', () => {
    expect(resolveLinkTarget([plain('1')], 0)).toBeNull();
  });
});
