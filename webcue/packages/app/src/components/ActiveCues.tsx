// The running-cue panel, rebuilt from Source/GUI/ActiveCuesComponent.cpp.
//
// One row per VOICE, not per cue: firing a cue twice gives two voices, and the
// operator needs to see both. In the desktop this is hand-painted with
// hit-tested rectangles; here it is ordinary DOM, which is one of the few
// places the browser rebuild is simpler than the original.

import type { ActiveCueInfo } from '@webcue/core';
import { formatTime } from '@webcue/core';

interface Props {
  active: ActiveCueInfo[];
  onStopVoice: (info: ActiveCueInfo) => void;
  onReleaseVamp: (info: ActiveCueInfo) => void;
}

function stateOf(info: ActiveCueInfo): { label: string; className: string } {
  if (info.paused) return { label: 'PAUSED', className: 'paused' };
  if (info.inPreWait) return { label: 'WAITING', className: 'wait' };
  if (info.vamping) return { label: `VAMP ${info.vampPasses + 1}`, className: 'vamp' };
  if (info.stopping) return { label: 'FADING', className: 'fading' };
  return { label: '', className: 'playing' };
}

export function ActiveCues(props: Props) {
  if (props.active.length === 0) {
    return (
      <aside className="active-panel">
        <h2>Running</h2>
        <p className="dim empty">Nothing playing.</p>
      </aside>
    );
  }

  return (
    <aside className="active-panel">
      <h2>
        Running <span className="dim">({props.active.length})</span>
      </h2>

      {props.active.map((info) => {
        const state = stateOf(info);
        const known = info.remaining >= 0;
        const total = known ? info.elapsed + info.remaining : 0;
        const pct = known && total > 0 ? Math.min(100, (info.elapsed / total) * 100) : 0;

        return (
          <div key={`${info.ref.slot}:${info.ref.generation}`} className={`active-row ${state.className}`}>
            <div className="active-head">
              <span className="mono active-number">{info.number || '--'}</span>
              <span className="active-name">{info.name}</span>
              <span className={`active-state ${state.className}`}>{state.label}</span>
            </div>

            <div className="active-times mono dim">
              {formatTime(info.elapsed)}
              {' / '}
              {known ? `-${formatTime(info.remaining)}` : 'open'}
            </div>

            {known && (
              <div className="active-bar">
                <div className="active-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            )}

            <div className="active-actions">
              <button type="button" onClick={() => props.onStopVoice(info)}>
                Stop
              </button>
              {info.vamping && (
                <button type="button" className="vamp-ready" onClick={() => props.onReleaseVamp(info)}>
                  Release
                </button>
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
