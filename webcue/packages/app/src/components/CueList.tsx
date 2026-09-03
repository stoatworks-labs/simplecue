// The cue list, rebuilt from Source/GUI/CueListComponent.cpp.
//
// The list is FLAT, not a tree: each row is either a cue header or one of that
// cue's derived sub-cues, exactly as the desktop flattens it. The standby cue
// is always expanded regardless of manual state, because the operator needs to
// see what the next few GOs will do.

import type { ActiveCueInfo, Cue, Standby } from '@webcue/core';
import {
  buildCueSteps,
  cueHeaderStep,
  formatTime,
  playbackLength,
} from '@webcue/core';

interface Props {
  cues: Cue[];
  standby: Standby;
  selectedIndex: number;
  active: ActiveCueInfo[];
  missingAudio: string[];
  expanded: Set<string>;
  onToggleExpand: (cueId: string) => void;
  onStandby: (standby: Standby) => void;
  onSelect: (index: number) => void;
  onFire: (index: number) => void;
}

/** CueListComponent.cpp:224-243. The priority order is load-bearing: a paused
    vamping cue reads PAUSED, not VAMP. */
function statusFor(
  cue: Cue,
  active: ActiveCueInfo[],
  missing: boolean,
): { label: string; className: string } | null {
  const entry = active.find((a) => a.cueId === cue.id);

  if (!entry) {
    if (cue.type === 'audioFile' && missing) return { label: 'MISSING', className: 'missing' };
    return null;
  }

  if (entry.paused) return { label: 'PAUSED', className: 'paused' };
  if (entry.inPreWait) return { label: 'WAIT', className: 'wait' };
  if (entry.vamping) return { label: `VAMP ${entry.vampPasses + 1}`, className: 'vamp' };
  if (entry.stopping) return { label: 'FADING', className: 'fading' };

  return { label: 'PLAYING', className: 'playing' };
}

function sourceText(cue: Cue, missing: boolean): { text: string; className: string } {
  if (cue.type === 'control') {
    const n = cue.outputMessages.length;
    return { text: `${n} message${n === 1 ? '' : 's'}`, className: 'dim' };
  }

  if (cue.type === 'streaming') {
    return { text: cue.streaming.displayName || cue.streaming.uri || 'no playlist', className: 'dim' };
  }

  if (cue.audioFile.length === 0) return { text: 'no file', className: 'dim' };

  const name = cue.audioFile.split(/[/\\]/).pop() ?? cue.audioFile;
  return { text: name, className: missing ? 'missing-text' : '' };
}

function repeatText(cue: Cue): string {
  const loop = cue.loopEnabled ? (cue.loopCount <= 0 ? 'loop' : `x${cue.loopCount}`) : '';
  const vamp = cue.vampEnabled ? 'vamp' : '';

  if (loop && vamp) return `${loop} + ${vamp}`;
  return loop || vamp || '';
}

function linkText(cue: Cue, cues: Cue[]): string {
  if (cue.link.mode === 'none') return '';

  const target = cue.link.target
    ? (cues.find((c) => c.id === cue.link.target)?.number ?? '?')
    : 'next';

  switch (cue.link.mode) {
    case 'autoContinue':
      return `instantly -> ${target}${cue.link.delay > 0 ? ` +${cue.link.delay.toFixed(1)}s` : ''}`;
    case 'autoFollow':
      return `at end -> ${target}${cue.link.delay > 0 ? ` +${cue.link.delay.toFixed(1)}s` : ''}`;
    case 'crossfade':
      return `xfade ${cue.link.duration.toFixed(1)}s -> ${target}`;
    default:
      return '';
  }
}

/** A zero time is dimmed so the eye skips it, as the desktop does. */
function TimeCell({ seconds }: { seconds: number }) {
  return (
    <td className={`mono ${seconds > 0 ? '' : 'dim'}`}>{formatTime(Math.max(0, seconds))}</td>
  );
}

export function CueList(props: Props) {
  const { cues, standby, active, missingAudio, expanded } = props;
  const missing = new Set(missingAudio);

  if (cues.length === 0) {
    return (
      <div className="empty-list">
        No cues. Drop audio files here to make some, or open a <code>.cueshow</code> to load a
        show.
      </div>
    );
  }

  const rows: React.ReactNode[] = [];

  cues.forEach((cue, index) => {
    const steps = buildCueSteps(cue);
    const isStandbyCue = standby.index === index;
    const fileMissing = cue.type === 'audioFile' && missing.has(cue.audioFile);
    const status = statusFor(cue, active, fileMissing);
    const source = sourceText(cue, fileMissing);
    const length = playbackLength(cue);

    // The standby cue opens on its own so the next few GOs are visible.
    const open = isStandbyCue || expanded.has(cue.id);

    // When standby is on a step that has no visible row, the marker belongs on
    // the header instead of vanishing.
    const markHeader = isStandbyCue && (standby.step === cueHeaderStep || !open);

    rows.push(
      <tr
        key={cue.id}
        className={`cue-row${markHeader ? ' standby' : ''}${
          props.selectedIndex === index ? ' selected' : ''
        }`}
        onClick={() => {
          // Clicking a cue header selects it for editing AND stands it by, the
          // way the desktop's list does.
          props.onSelect(index);
          props.onStandby({ index, step: cueHeaderStep });
        }}
        onDoubleClick={() => props.onFire(index)}
      >
        <td className="status">
          {status && <span className={`badge ${status.className}`}>{status.label}</span>}
        </td>
        <td className="number mono">
          <button
            type="button"
            className={`twisty${open ? ' open' : ''}`}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleExpand(cue.id);
            }}
          >
            ▶
          </button>
          {cue.number}
        </td>
        <td>{cue.name}</td>
        <td className={source.className}>{source.text}</td>
        <TimeCell seconds={cue.preWait} />
        <td className={`mono ${length > 0 ? '' : 'dim'}`}>
          {length > 0 ? formatTime(length) : 'open'}
        </td>
        <td className="mono dim">
          {cue.fadeInTime.toFixed(1)} / {cue.fadeOutTime.toFixed(1)}
        </td>
        <td className="dim">{repeatText(cue)}</td>
        <td className="dim">{linkText(cue, cues)}</td>
      </tr>,
    );

    if (!open) return;

    steps.forEach((step, stepIndex) => {
      const onStandby = isStandbyCue && standby.step === stepIndex;

      rows.push(
        <tr
          key={`${cue.id}:${stepIndex}`}
          className={`step-row${onStandby ? ' standby' : ''}`}
          onClick={() => props.onStandby({ index, step: stepIndex })}
        >
          <td />
          <td />
          <td className="step-label">
            <span className={`step-dot ${step.type}`} />
            {step.label}
          </td>
          <td className="dim" colSpan={6}>
            {step.detail}
          </td>
        </tr>,
      );
    });
  });

  return (
    <table className="cue-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Cue</th>
          <th>Name</th>
          <th>Source</th>
          <th>Pre</th>
          <th>Length</th>
          <th>Fades</th>
          <th>Repeat</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}
