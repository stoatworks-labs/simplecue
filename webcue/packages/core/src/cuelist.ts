// Standby and list navigation, ported from Source/Model/CueList.cpp.
//
// The desktop CueList is a juce::ChangeBroadcaster that owns its cues and
// mutates in place. Here it is pure functions over a plain array: the mutable
// document, its dirty flag and its undo history belong to the app, and keeping
// this layer pure is what lets the sequencer be tested without any of that.
//
// Standby is a (cue, step) PAIR, not a row — step -1 (cueHeaderStep) means the
// cue itself. Every rule below depends on that.

import type { Cue } from './cue.js';
import type { CueStep } from './cuestep.js';
import { buildCueSteps, cueHeaderStep } from './cuestep.js';

export interface Standby {
  index: number;
  step: number;
}

export const emptyStandby: Standby = { index: -1, step: cueHeaderStep };

function jlimit(lower: number, upper: number, value: number): number {
  return value < lower ? lower : value > upper ? upper : value;
}

export function indexOfId(cues: readonly Cue[], id: string): number {
  return cues.findIndex((c) => c.id === id);
}

export function findById(cues: readonly Cue[], id: string): Cue | null {
  return cues.find((c) => c.id === id) ?? null;
}

export function cueAt(cues: readonly Cue[], index: number): Cue | null {
  return index >= 0 && index < cues.length ? (cues[index] ?? null) : null;
}

export function stepsFor(cues: readonly Cue[], index: number): CueStep[] {
  const cue = cueAt(cues, index);
  return cue ? buildCueSteps(cue) : [];
}

/** The clamping every standby write goes through. CueList.cpp:156-168. */
export function standbyPosition(cues: readonly Cue[], index: number, step: number): Standby {
  const clampedIndex = cues.length === 0 ? -1 : jlimit(-1, cues.length - 1, index);
  const numSteps = stepsFor(cues, clampedIndex).length;
  const clampedStep = jlimit(cueHeaderStep, Math.max(cueHeaderStep, numSteps - 1), step);

  return { index: clampedIndex, step: clampedStep };
}

/** Standing a cue by puts standby on the cue itself, never on a step. */
export function standbyForCue(cues: readonly Cue[], index: number): Standby {
  return standbyPosition(cues, index, cueHeaderStep);
}

/** The step GO is about to act on, or null when standby is on the cue header. */
export function standbyStepInfo(cues: readonly Cue[], standby: Standby): CueStep | null {
  const steps = stepsFor(cues, standby.index);
  return standby.step >= 0 && standby.step < steps.length ? (steps[standby.step] ?? null) : null;
}

/** CueList.cpp:188-222.

    Two rules here are easy to "fix" into being wrong:

    1. From the header, standby jumps to step 1 — skipping Play — when
       firePlayWithCue is set, because firing the cue already played it. With
       the flag off it goes to step 0 and the cue is a container.
    2. It deliberately does NOT wrap. An accidental extra GO at the end of a
       show should do nothing, not restart the top of the list.

    A control cue with firePlayWithCue set has numSteps == 1, so firstSubCue == 1
    is not < 1 and it falls straight through to the next cue's header. That reads
    accidental but is correct: the single step already fired with the header. */
export function advanceStandby(cues: readonly Cue[], standby: Standby): Standby {
  if (cues.length === 0) return standby;

  const steps = stepsFor(cues, standby.index);
  const numSteps = steps.length;

  if (standby.step === cueHeaderStep) {
    const cue = cueAt(cues, standby.index);
    const firstSubCue = cue !== null && cue.firePlayWithCue ? 1 : 0;

    if (firstSubCue < numSteps) {
      return standbyPosition(cues, standby.index, firstSubCue);
    }
  } else if (standby.step + 1 < numSteps) {
    return standbyPosition(cues, standby.index, standby.step + 1);
  }

  if (standby.index < cues.length - 1) {
    return standbyPosition(cues, standby.index + 1, cueHeaderStep);
  }

  return standbyPosition(cues, cues.length - 1, Math.max(cueHeaderStep, numSteps - 1));
}

/** Re-clamps after an edit. Editing a cue can remove a sub-cue — turning a vamp
    off drops its devamp — so the step has to be pulled back into range rather
    than pointing past the end. CueList.cpp:242-259. */
export function clampStandby(cues: readonly Cue[], standby: Standby): Standby {
  if (cues.length === 0) return { index: -1, step: cueHeaderStep };
  return standbyPosition(cues, standby.index, standby.step);
}

/** The number a newly added cue gets: one past the highest whole number in the
    list. CueList.cpp:130-138.

    It uses the INTEGER value of each number, which is why a list of "1", "2.5"
    and "PRE" suggests "3" rather than "3.5" or a failure — juce::String's
    getIntValue() reads the leading digits and gives 0 for text. Cue numbers are
    free text on purpose, so this only ever has to be a sensible guess. */
export function suggestNextNumber(cues: readonly Cue[]): string {
  let highest = 0;

  for (const cue of cues) {
    // parseInt semantics match getIntValue(): leading digits, else 0.
    const value = Number.parseInt(cue.number, 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }

  return String(highest + 1);
}

/** The cue a link points at: the explicit target when set, otherwise simply the
    next cue in the list. CueList.cpp:229-240.

    A null target meaning "next" is what lets a cue be inserted mid-chain
    without breaking the chain. */
export function resolveLinkTarget(cues: readonly Cue[], fromIndex: number): Cue | null {
  const from = cueAt(cues, fromIndex);
  if (from === null) return null;

  if (from.link.target !== null) return findById(cues, from.link.target);

  return cueAt(cues, fromIndex + 1);
}
