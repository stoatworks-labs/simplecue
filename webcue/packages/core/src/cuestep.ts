// Sub-cues, ported from Source/Model/CueStep.cpp:8-66.
//
// A cue is not always a single event. A vamped cue is played, held, released and
// eventually ended, and each of those is a separate GO — so a cue expands into
// the steps it actually needs, and GO walks them one at a time.
//
// The step list is DERIVED, never stored. Turning a vamp off removes the devamp
// step, which is why CueList has to re-clamp the standby step after every edit.

import type { Cue } from './cue.js';
import { hasUsableVamp } from './cue.js';

export type CueStepType = 'play' | 'devamp' | 'end';

/** Standby sits either on a step or on the cue itself, which is this. */
export const cueHeaderStep = -1;

export interface CueStep {
  type: CueStepType;
  vampIndex: number;
  label: string;
  detail: string;
}

/** Formats seconds as mm:ss.t, or h:mm:ss.t past an hour. Negative gives "--:--".
    Ported from Source/GUI/LookAndFeel.cpp:142-158 because the sub-cue detail
    strings use it, and a cue list that formats times differently from the
    desktop is a cue list an operator cannot cross-check. */
export function formatTime(seconds: number): string {
  if (seconds < 0 || Number.isNaN(seconds)) return '--:--';

  const totalTenths = Math.floor(seconds * 10 + 0.5);
  const tenths = totalTenths % 10;
  const total = Math.floor(totalTenths / 10);
  const secs = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  const p2 = (n: number) => String(n).padStart(2, '0');

  return hours > 0
    ? `${hours}:${p2(minutes)}:${p2(secs)}.${tenths}`
    : `${p2(minutes)}:${p2(secs)}.${tenths}`;
}

/** juce::String(double, int) — fixed decimal places, matching the detail text. */
function fixed(value: number, places: number): string {
  return value.toFixed(places);
}

export function buildCueSteps(cue: Cue): CueStep[] {
  const steps: CueStep[] = [];

  // A control cue is a single event: nothing to hold and nothing to fade.
  if (cue.type === 'control') {
    const n = cue.outputMessages.length;
    steps.push({
      type: 'play',
      vampIndex: 0,
      label: 'Fire messages',
      detail: `${n} ${n === 1 ? 'message' : 'messages'}`,
    });
    return steps;
  }

  // --- Play ---------------------------------------------------------------
  {
    let detail = '';

    if (cue.preWait > 0) detail = `after ${fixed(cue.preWait, 2)}s pre-wait`;
    else if (cue.fadeInTime > 0) detail = `${fixed(cue.fadeInTime, 1)}s fade in`;

    steps.push({ type: 'play', vampIndex: 0, label: 'Play cue', detail });
  }

  // --- Devamp -------------------------------------------------------------
  // Only when there is a vamp to release. A devamp row on a cue with no vamp
  // would be a step that does nothing, in the operator's way on every cue.
  if (hasUsableVamp(cue)) {
    steps.push({
      type: 'devamp',
      vampIndex: 0,
      label: 'Devamp',
      detail:
        `${formatTime(cue.vampStart)} to ${formatTime(cue.vampEnd)}` +
        (cue.vampRelease === 'immediately' ? ', leaves at once' : ', finishes the pass'),
    });
  }

  // --- Fade / Stop --------------------------------------------------------
  // Always. Even a cue that would end by itself can be wanted out early.
  steps.push({
    type: 'end',
    vampIndex: 0,
    label: 'Fade/Stop',
    detail: cue.endAction === 'hardStop' ? 'hard stop' : `${fixed(cue.endFadeTime, 1)}s fade out`,
  });

  return steps;
}
