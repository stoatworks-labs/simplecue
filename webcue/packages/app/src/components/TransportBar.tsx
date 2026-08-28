// The transport strip, rebuilt from Source/GUI/TransportBar.cpp.
//
// Layout follows the desktop for a reason: GO is the largest target and sits
// hard left, PANIC is red and deliberately far from it, and every shortcut is
// printed on the button face rather than hidden in a menu.

import type { Cue, Standby } from '@webcue/core';
import { buildCueSteps, cueHeaderStep } from '@webcue/core';

interface Props {
  cues: Cue[];
  standby: Standby;
  running: boolean;
  paused: boolean;
  anythingVamping: boolean;
  anythingPlaying: boolean;
  masterGainDb: number;
  onGo: () => void;
  onStopAll: () => void;
  onTogglePause: () => void;
  onReleaseVamps: () => void;
  onPanic: () => void;
  onMasterGain: (db: number) => void;
}

export function TransportBar(props: Props) {
  const { cues, standby } = props;
  const cue = standby.index >= 0 ? cues[standby.index] : undefined;

  // "Storm builds - Devamp" when standby is on a sub-cue, so the readout says
  // what the next GO will actually do rather than just which cue it is on.
  let stepLabel = '';

  if (cue && standby.step !== cueHeaderStep) {
    stepLabel = buildCueSteps(cue)[standby.step]?.label ?? '';
  }

  return (
    <div className="transport">
      <button
        type="button"
        className="go"
        disabled={!props.running || !cue}
        onClick={props.onGo}
      >
        GO <span className="key">(space)</span>
      </button>

      <div className="standby-readout">
        {cue ? (
          <>
            <span className="standby-number">{cue.number || '--'}</span>
            <span className="standby-name">
              {cue.name}
              {stepLabel && <span className="standby-step"> — {stepLabel}</span>}
            </span>
          </>
        ) : (
          <span className="standby-name dim">Nothing on standby</span>
        )}
      </div>

      <button
        type="button"
        disabled={!props.anythingPlaying}
        onClick={props.onStopAll}
        title="Fade everything out over 2 seconds"
      >
        Stop all <span className="key">(s)</span>
      </button>

      <button type="button" disabled={!props.anythingPlaying} onClick={props.onTogglePause}>
        {props.paused ? 'Resume' : 'Pause'} <span className="key">(p)</span>
      </button>

      <button
        type="button"
        className={props.anythingVamping ? 'vamp-ready' : ''}
        disabled={!props.anythingVamping}
        onClick={props.onReleaseVamps}
      >
        Release vamp <span className="key">(enter)</span>
      </button>

      <button type="button" className="panic" disabled={!props.running} onClick={props.onPanic}>
        PANIC <span className="key">(esc)</span>
      </button>

      <label className="master">
        <span className="dim">Master</span>
        <input
          type="range"
          min={-60}
          max={12}
          step={0.1}
          value={props.masterGainDb}
          disabled={!props.running}
          onChange={(e) => props.onMasterGain(Number(e.target.value))}
        />
        <span className="mono master-value">{props.masterGainDb.toFixed(1)} dB</span>
      </label>
    </div>
  );
}
