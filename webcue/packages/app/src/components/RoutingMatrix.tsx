// The crosspoint matrix, rebuilt from Source/GUI/RoutingMatrixComponent.cpp.
//
// The subtle rule is the default. An EMPTY routing array does not mean "no
// routing" — it means "the implicit 1:1 map", which the engine builds at fire
// time. So the first click has to MATERIALISE that map into real RoutePoints
// before toggling, or the second click silently drops the whole 1:1 and the cue
// goes quiet in a way nothing on screen explains.

import type { Cue, RoutePoint } from '@webcue/core';
import { effectiveRouting } from '@webcue/core';

interface Props {
  cue: Cue;
  numOutputs: number;
  onChange: (routing: RoutePoint[]) => void;
}

function sourceLabel(channel: number, count: number): string {
  if (count === 2) return channel === 0 ? 'Left' : 'Right';
  return `Ch ${channel + 1}`;
}

export function RoutingMatrix({ cue, numOutputs, onChange }: Props) {
  const numSources = Math.max(1, cue.fileChannels || 2);
  const implicit = cue.routing.length === 0;
  const routes = effectiveRouting(cue, numSources, numOutputs);

  if (numOutputs <= 0) {
    return <p className="dim">No audio device open.</p>;
  }

  const gainAt = (src: number, dst: number): number | null => {
    const route = routes.find((r) => r.sourceChannel === src && r.outputChannel === dst);
    return route ? route.gain : null;
  };

  const toggle = (src: number, dst: number) => {
    // Materialise the implicit map first, then toggle within it.
    const base: RoutePoint[] = implicit
      ? effectiveRouting(cue, numSources, numOutputs).map((r) => ({ ...r }))
      : cue.routing.map((r) => ({ ...r }));

    const at = base.findIndex((r) => r.sourceChannel === src && r.outputChannel === dst);

    if (at >= 0) base.splice(at, 1);
    else base.push({ sourceChannel: src, outputChannel: dst, gain: 1 });

    onChange(base);
  };

  const setGain = (src: number, dst: number) => {
    const current = gainAt(src, dst);
    if (current === null) return;

    const asDb = current > 0 ? 20 * Math.log10(current) : -100;
    const typed = window.prompt('Trim for this crosspoint, in dB', asDb.toFixed(1));
    if (typed === null) return;

    const db = Number.parseFloat(typed);
    if (Number.isNaN(db)) return;

    const clamped = Math.max(-100, Math.min(12, db));
    const gain = clamped <= -100 ? 0 : Math.pow(10, clamped / 20);

    const base: RoutePoint[] = implicit
      ? effectiveRouting(cue, numSources, numOutputs).map((r) => ({ ...r }))
      : cue.routing.map((r) => ({ ...r }));

    const at = base.findIndex((r) => r.sourceChannel === src && r.outputChannel === dst);
    if (at >= 0) base[at] = { sourceChannel: src, outputChannel: dst, gain };

    onChange(base);
  };

  return (
    <div className="routing">
      {implicit && (
        <p className="dim routing-note">
          Default 1:1 routing — click any crosspoint to take manual control.
        </p>
      )}

      <table className={`routing-grid${implicit ? ' implicit' : ''}`}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: numOutputs }, (_, dst) => (
              <th key={dst} className="mono">
                {dst + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: numSources }, (_, src) => (
            <tr key={src}>
              <th className="routing-source">{sourceLabel(src, numSources)}</th>
              {Array.from({ length: numOutputs }, (_, dst) => {
                const gain = gainAt(src, dst);
                const on = gain !== null;
                const db = on && gain !== 1 ? 20 * Math.log10(Math.max(gain, 1e-6)) : null;

                return (
                  <td key={dst}>
                    <button
                      type="button"
                      className={`crosspoint${on ? ' on' : ''}`}
                      title={on ? 'Click to remove, double-click to trim' : 'Click to route'}
                      onClick={() => toggle(src, dst)}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setGain(src, dst);
                      }}
                    >
                      {db !== null ? db.toFixed(0) : ''}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {!implicit && (
        <button type="button" className="link-button" onClick={() => onChange([])}>
          Back to default 1:1
        </button>
      )}
    </div>
  );
}
