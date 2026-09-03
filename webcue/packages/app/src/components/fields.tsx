// Inspector field primitives.
//
// The commit rules are the point of this file, and they are not uniform — the
// desktop varies them per field for reasons that matter:
//
//   * Cue number and name commit PER KEYSTROKE. They are short, and seeing the
//     cue list update as you type is the feedback you want.
//   * Notes and the timecode fields commit ON BLUR ONLY. CueInspector.cpp:641
//     explains the timecode case: typing "1" on the way to "1:02" would move
//     the marker to one second and drag the waveform with it.
//   * Sliders ignore the scroll wheel until clicked. Scrolling the inspector
//     past a gain slider must not silently rewrite the gain of the cue the
//     pointer happened to cross (LookAndFeel.h:47-64).

import { useEffect, useRef, useState } from 'react';

interface RowProps {
  label: string;
  children: React.ReactNode;
  hint?: string;
}

export function Row({ label, children, hint }: RowProps) {
  return (
    <label className="field-row">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint dim">{hint}</span>}
    </label>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Commits on every keystroke. */
export function LiveText({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Commits on blur or Enter, never per keystroke. Reverts on Escape. */
export function DeferredText({
  value,
  onCommit,
  multiline,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  // Never overwrite what the operator is typing (CueInspector.cpp:696-699).
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    focused.current = false;
    if (draft !== value) onCommit(draft);
  };

  const common = {
    value: draft,
    placeholder,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      } else if (e.key === 'Escape') {
        setDraft(value);
        focused.current = false;
        (e.target as HTMLElement).blur();
      }
    },
  };

  return multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />;
}

/** mm:ss.mmm in, mm:ss.mmm or m:ss or plain seconds accepted.
    Ports formatTimecode/parseTimecode from LookAndFeel.cpp:160-211. */
export function formatTimecode(seconds: number): string {
  if (seconds < 0 || Number.isNaN(seconds)) seconds = 0;

  const totalMs = Math.floor(seconds * 1000 + 0.5);
  const millis = totalMs % 1000;
  const total = Math.floor(totalMs / 1000);
  const secs = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  const p = (n: number, w = 2) => String(n).padStart(w, '0');

  return hours > 0
    ? `${hours}:${p(minutes)}:${p(secs)}.${p(millis, 3)}`
    : `${p(minutes)}:${p(secs)}.${p(millis, 3)}`;
}

export function parseTimecode(text: string, fallback = 0): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallback;

  // Colon-separated fields count from the RIGHT, so "5" is five seconds,
  // "1:05" is a minute and five, and "1:00:05" is an hour and five. The
  // operator types whichever is quickest without padding the rest out.
  const parts = trimmed.split(':');
  if (parts.length > 3) return fallback;

  let seconds = 0;

  for (const part of parts) {
    const field = part.trim();
    if (field.length === 0 || !/[0-9]/.test(field)) return fallback;

    const value = Number.parseFloat(field);
    if (Number.isNaN(value)) return fallback;

    seconds = seconds * 60 + value;
  }

  return Math.max(0, seconds);
}

/** A time field. Commits on blur or Enter; unparseable input silently reverts
    to the real value rather than rewriting it to zero. */
export function TimeField({
  seconds,
  onCommit,
  disabled,
}: {
  seconds: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatTimecode(seconds));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(formatTimecode(seconds));
  }, [seconds]);

  const commit = () => {
    focused.current = false;
    const parsed = parseTimecode(draft, Number.NaN);

    if (Number.isNaN(parsed)) {
      setDraft(formatTimecode(seconds));
      return;
    }

    if (parsed !== seconds) onCommit(parsed);
    else setDraft(formatTimecode(seconds));
  };

  return (
    <input
      type="text"
      className="mono time-field"
      value={draft}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={commit}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(formatTimecode(seconds));
          focused.current = false;
          (e.target as HTMLElement).blur();
        }
      }}
    />
  );
}

/** A slider that ignores the scroll wheel until it has been clicked.

    Without this, scrolling the inspector past a gain slider rewrites the gain
    of whichever cue the pointer crossed — silently, and with no undo. */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  format?: (v: number) => string;
}) {
  const [engaged, setEngaged] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!engaged) {
        // Let the panel scroll instead of adjusting the value.
        e.stopPropagation();
        el.blur();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, [engaged]);

  return (
    <span className="slider-wrap">
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={() => setEngaged(true)}
        onBlur={() => setEngaged(false)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="mono slider-value">{format ? format(value) : value.toFixed(2)}</span>
    </span>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
