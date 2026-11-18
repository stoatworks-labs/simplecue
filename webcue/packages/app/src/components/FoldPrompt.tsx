// Asked once, on load, when a show is routed to outputs this browser has not
// got.
//
// This is not a cosmetic degradation. Cue::effectiveRouting drops every route
// whose output channel does not exist, and AudioEngine::buildSpec then refuses
// a cue whose surviving list is empty — so a show authored for eight outputs
// does not fold in a stereo tab, it refuses to play, cue by cue, with "is not
// routed to any output".
//
// Folding silently would be worse than refusing: the browser build would
// quietly disagree with the desktop about what the show sounds like, and the
// operator would have no way to know. So it is a question, it names the cues,
// and it says what happens either way.

import type { FoldCandidate } from '../store.ts';

interface Props {
  candidates: FoldCandidate[];
  numOutputs: number;
  onFold: () => void;
  onDismiss: () => void;
}

export function FoldPrompt(props: Props) {
  const n = props.candidates.length;

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fold-title">
        <h2 id="fold-title">This show is routed to outputs you have not got</h2>

        <p>
          {n === 1 ? 'One cue is' : `${n} cues are`} routed to output channels beyond the{' '}
          <strong>{props.numOutputs}</strong> this browser can address. A browser gives you the
          default output device, which is almost always stereo — the desktop app can address up
          to 64.
        </p>

        <p className="warn">
          Left alone, {n === 1 ? 'that cue' : 'those cues'} will not play at all. Every route is
          dropped, and a cue with no surviving route is refused rather than folded.
        </p>

        <ul className="fold-list">
          {props.candidates.slice(0, 8).map((c) => (
            <li key={c.cueId}>
              <span className="mono">{c.number || '--'}</span> {c.name}
            </li>
          ))}
          {n > 8 && <li className="dim">and {n - 8} more</li>}
        </ul>

        <p className="dim">
          Folding wraps each route onto the outputs that exist. It changes the mix — channels that
          were separate will sum — so the show will not sound as it does on the rig it was built
          for. Nothing is written to your show file unless you save it.
        </p>

        <div className="modal-actions">
          <button type="button" className="go" onClick={props.onFold}>
            Fold onto {props.numOutputs} outputs
          </button>
          <button type="button" onClick={props.onDismiss}>
            Leave it alone
          </button>
        </div>
      </div>
    </div>
  );
}
