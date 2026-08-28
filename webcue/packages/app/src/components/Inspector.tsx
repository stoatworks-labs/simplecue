// The cue inspector, rebuilt from Source/GUI/CueInspector.cpp.
//
// One scrolling panel, no tabs — deliberate on the desktop and kept here.
//
// Sections HIDE rather than grey out when they do not apply to the cue type,
// and the panel closes up: a control cue has no in point, and a disabled in
// point is worse than no in point. Individual controls within a visible section
// do grey out when they depend on another setting.

import { useRef } from 'react';

import type { Cue, EndAction, FadeShape, LinkMode, RoutePoint, VampRelease } from '@webcue/core';
import { resolvedEndTime, trimmedLength } from '@webcue/core';
import type { SourcePeaks } from '@webcue/engine';

import { Check, DeferredText, LiveText, Row, Section, Select, Slider, TimeField } from './fields.tsx';
import { RoutingMatrix } from './RoutingMatrix.tsx';
import type { MarkerKind } from './Waveform.tsx';
import { Waveform } from './Waveform.tsx';

interface Props {
  cue: Cue;
  cues: Cue[];
  peaks: SourcePeaks | null;
  playhead: number | null;
  numOutputs: number;
  onChange: (patch: Partial<Cue>) => void;
  onAudition: (fromSeconds: number) => void;
  onPickAudio: (file: File) => void;
  onDelete: () => void;
}

const fadeShapes: { value: FadeShape; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'equalPower', label: 'Equal power' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'logarithmic', label: 'Logarithmic' },
  { value: 'sCurve', label: 'S-curve' },
];

// Named for what they do rather than for the jargon: "auto-follow" tells an
// operator nothing about when the next cue actually fires (Cue.cpp:29-37).
const linkModes: { value: LinkMode; label: string }[] = [
  { value: 'none', label: "Don't fire next cue" },
  { value: 'autoContinue', label: 'Fire next cue instantly' },
  { value: 'autoFollow', label: 'Fire next cue at end' },
  { value: 'crossfade', label: 'Crossfade into next cue' },
];

const db = (v: number) => `${v.toFixed(1)} dB`;
const secs = (v: number) => `${v.toFixed(2)} s`;

export function Inspector(props: Props) {
  const { cue, cues } = props;
  const audioInput = useRef<HTMLInputElement>(null);

  const isFile = cue.type === 'audioFile';
  const isControl = cue.type === 'control';
  const duration = cue.fileDuration;

  const set = props.onChange;

  /** Marker clamping lives here, not in the waveform — the waveform reports a
      position and the model decides what is legal (CueInspector.cpp:30-57). */
  const moveMarker = (marker: MarkerKind, seconds: number) => {
    switch (marker) {
      case 'in':
        set({ startTime: Math.max(0, Math.min(seconds, resolvedEndTime(cue))) });
        break;
      case 'out':
        set({ endTime: Math.max(cue.startTime, Math.min(seconds, duration || seconds)) });
        break;
      case 'vampStart':
        set({ vampStart: Math.max(cue.startTime, Math.min(seconds, cue.vampEnd)) });
        break;
      case 'vampEnd':
        set({ vampEnd: Math.max(cue.vampStart, Math.min(seconds, resolvedEndTime(cue))) });
        break;
    }
  };

  /** Enabling a vamp on a zero-length region seeds it to the middle half of the
      cue, so the markers are somewhere useful instead of both at zero. */
  const toggleVamp = (on: boolean) => {
    if (!on) {
      set({ vampEnabled: false });
      return;
    }

    if (cue.vampEnd > cue.vampStart) {
      set({ vampEnabled: true });
      return;
    }

    const length = trimmedLength(cue);
    set({
      vampEnabled: true,
      vampStart: cue.startTime + length * 0.25,
      vampEnd: cue.startTime + length * 0.75,
    });
  };

  return (
    <div className="inspector">
      {isFile && (
        <div className="inspector-top">
          <Waveform
            cue={cue}
            peaks={props.peaks}
            playhead={props.playhead}
            onMove={(marker, seconds) => moveMarker(marker, seconds)}
            onScrub={(seconds) => props.onAudition(seconds)}
          />

          <div className="time-bar">
            <label>
              <span className="dim">In</span>
              <TimeField seconds={cue.startTime} onCommit={(v) => moveMarker('in', v)} />
            </label>
            <label>
              <span className="dim">Out</span>
              <TimeField seconds={resolvedEndTime(cue)} onCommit={(v) => moveMarker('out', v)} />
            </label>
            <label>
              <span className="dim">Vamp from</span>
              <TimeField
                seconds={cue.vampStart}
                disabled={!cue.vampEnabled}
                onCommit={(v) => moveMarker('vampStart', v)}
              />
            </label>
            <label>
              <span className="dim">Vamp to</span>
              <TimeField
                seconds={cue.vampEnd}
                disabled={!cue.vampEnabled}
                onCommit={(v) => moveMarker('vampEnd', v)}
              />
            </label>
          </div>
        </div>
      )}

      <div className="inspector-scroll">
        <Section title="Source">
          <Row label="Cue number">
            <LiveText value={cue.number} onChange={(v) => set({ number: v })} placeholder="12.5" />
          </Row>

          <Row label="Name">
            <LiveText value={cue.name} onChange={(v) => set({ name: v })} />
          </Row>

          <Row label="Type">
            <Select
              value={cue.type}
              options={[
                { value: 'audioFile', label: 'Audio file' },
                { value: 'control', label: 'Control (messages only)' },
                { value: 'streaming', label: 'Streaming' },
              ]}
              onChange={(v) => set({ type: v })}
            />
          </Row>

          {isFile && (
            <Row label="Audio file">
              <span className="file-row">
                <button type="button" onClick={() => audioInput.current?.click()}>
                  {cue.audioFile ? 'Replace' : 'Choose'}
                </button>
                <span className="dim file-name">{cue.audioFile || 'none'}</span>
              </span>
              <input
                ref={audioInput}
                type="file"
                accept="audio/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) props.onPickAudio(file);
                  e.target.value = '';
                }}
              />
            </Row>
          )}

          {cue.type === 'streaming' && (
            <p className="dim warn-note">
              Streaming cues need a loopback input, which a browser cannot open. This cue will not
              play here — it is kept so the show still round-trips to the desktop app.
            </p>
          )}

          <Row label="Notes">
            <DeferredText value={cue.notes} onCommit={(v) => set({ notes: v })} multiline />
          </Row>

          <Row label="Gain">
            <Slider
              value={cue.gainDb}
              min={-60}
              max={12}
              step={0.1}
              format={db}
              onChange={(v) => set({ gainDb: v })}
            />
          </Row>

          <Row label="Pre-wait" hint="silence between GO and the first sample">
            <Slider
              value={cue.preWait}
              min={0}
              max={60}
              step={0.01}
              format={secs}
              onChange={(v) => set({ preWait: v })}
            />
          </Row>

          {isFile && (
            <Row label="">
              <button type="button" onClick={() => props.onAudition(cue.startTime)}>
                Audition
              </button>
            </Row>
          )}
        </Section>

        <Section title="Fades">
          <Row label="Fade in">
            <Slider
              value={cue.fadeInTime}
              min={0}
              max={120}
              step={0.1}
              format={secs}
              onChange={(v) => set({ fadeInTime: v })}
            />
          </Row>
          <Row label="Shape">
            <Select
              value={cue.fadeInShape}
              options={fadeShapes}
              onChange={(v) => set({ fadeInShape: v })}
            />
          </Row>
          <Row label="Fade out">
            <Slider
              value={cue.fadeOutTime}
              min={0}
              max={120}
              step={0.1}
              format={secs}
              onChange={(v) => set({ fadeOutTime: v })}
            />
          </Row>
          <Row label="Shape">
            <Select
              value={cue.fadeOutShape}
              options={fadeShapes}
              onChange={(v) => set({ fadeOutShape: v })}
            />
          </Row>
        </Section>

        {isFile && (
          <Section title="Loop and vamp">
            <Check
              checked={cue.loopEnabled}
              onChange={(v) => set({ loopEnabled: v })}
              label="Loop the whole cue"
            />

            <Row label="Play count">
              <Slider
                value={cue.loopCount}
                min={0}
                max={99}
                step={1}
                disabled={!cue.loopEnabled}
                format={(v) => (v === 0 ? 'forever' : `${v} times`)}
                onChange={(v) => set({ loopCount: v })}
              />
            </Row>

            <Check
              checked={cue.vampEnabled}
              onChange={toggleVamp}
              label="Vamp a section until released"
            />

            <Row label="On release">
              <Select
                value={cue.vampRelease}
                disabled={!cue.vampEnabled}
                options={[
                  { value: 'atEndOfPass' as VampRelease, label: 'Finish the current pass' },
                  { value: 'immediately' as VampRelease, label: 'Leave immediately' },
                ]}
                onChange={(v) => set({ vampRelease: v })}
              />
            </Row>
          </Section>
        )}

        {!isControl && (
          <Section title="Ending this cue">
            <Check
              checked={cue.firePlayWithCue}
              onChange={(v) => set({ firePlayWithCue: v })}
              label="Firing this cue also fires its Play sub-cue"
            />

            <Row label="Ends by">
              <Select
                value={cue.endAction}
                options={[
                  { value: 'fadeOut' as EndAction, label: 'Fade out' },
                  { value: 'hardStop' as EndAction, label: 'Hard stop' },
                ]}
                onChange={(v) => set({ endAction: v })}
              />
            </Row>

            <Row label="Fade over">
              <Slider
                value={cue.endFadeTime}
                min={0}
                max={60}
                step={0.1}
                format={secs}
                disabled={cue.endAction !== 'fadeOut'}
                onChange={(v) => set({ endFadeTime: v })}
              />
            </Row>
          </Section>
        )}

        <Section title="Link to the next cue">
          <Row label="When">
            <Select
              value={cue.link.mode}
              options={linkModes}
              onChange={(v) => set({ link: { ...cue.link, mode: v } })}
            />
          </Row>

          <Row label="Target">
            <select
              value={cue.link.target ?? ''}
              disabled={cue.link.mode === 'none'}
              onChange={(e) =>
                set({ link: { ...cue.link, target: e.target.value === '' ? null : e.target.value } })
              }
            >
              {/* Null means "the next cue in the list", which is what lets a cue
                  be inserted mid-chain without breaking the chain. */}
              <option value="">The next cue in the list</option>
              {cues
                .filter((c) => c.id !== cue.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.number || '--'} {c.name}
                  </option>
                ))}
            </select>
          </Row>

          <Row
            label="Delay"
            hint={cue.link.mode === 'crossfade' ? 'ignored by a crossfade' : undefined}
          >
            <Slider
              value={cue.link.delay}
              min={0}
              max={60}
              step={0.1}
              format={secs}
              disabled={cue.link.mode !== 'autoContinue' && cue.link.mode !== 'autoFollow'}
              onChange={(v) => set({ link: { ...cue.link, delay: v } })}
            />
          </Row>

          <Row label="Crossfade">
            <Slider
              value={cue.link.duration}
              min={0}
              max={60}
              step={0.1}
              format={secs}
              disabled={cue.link.mode !== 'crossfade'}
              onChange={(v) => set({ link: { ...cue.link, duration: v } })}
            />
          </Row>

          <Row label="Curve">
            <Select
              value={cue.link.shape}
              options={fadeShapes}
              disabled={cue.link.mode !== 'crossfade'}
              onChange={(v) => set({ link: { ...cue.link, shape: v } })}
            />
          </Row>
        </Section>

        {!isControl && (
          <Section title="Output routing">
            <RoutingMatrix
              cue={cue}
              numOutputs={props.numOutputs}
              onChange={(routing: RoutePoint[]) => set({ routing })}
            />
          </Section>
        )}

        <div className="inspector-footer">
          <button type="button" className="danger-text" onClick={props.onDelete}>
            Delete this cue
          </button>
        </div>
      </div>
    </div>
  );
}
