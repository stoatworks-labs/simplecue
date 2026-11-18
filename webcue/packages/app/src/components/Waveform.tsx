// The waveform and its markers, rebuilt from Source/GUI/WaveformComponent.cpp.
//
// Peaks come from the engine, computed at load, because juce::AudioThumbnail
// has no browser equivalent.
//
// Two rules are carried over deliberately:
//
//   * The WHOLE file is drawn, dimmed, with the in..out region redrawn bright
//     on top. Nothing is hidden, so trimmed audio can be dragged back.
//   * Marker times are seconds within the SOURCE FILE, not within the trimmed
//     region, so moving the in point never drags the vamp markers with it.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Cue } from '@webcue/core';
import { resolvedEndTime } from '@webcue/core';
import type { SourcePeaks } from '@webcue/engine';

export type MarkerKind = 'in' | 'out' | 'vampStart' | 'vampEnd';

interface Props {
  cue: Cue;
  peaks: SourcePeaks | null;
  /** Play head in seconds within the file, or null when the cue is not running. */
  playhead: number | null;
  onMove: (marker: MarkerKind, seconds: number, isFinal: boolean) => void;
  onScrub: (seconds: number) => void;
}

const EDGE = 16; // keeps a marker at 0 s from being trapped against the frame
const RULER = 16;
const GRAB = 8;

const COLOURS = {
  in: '#5ddb9a',
  out: '#ff9a6e',
  vampStart: '#ffc857',
  vampEnd: '#ffc857',
};

const LABELS: Record<MarkerKind, string> = {
  in: 'IN',
  out: 'OUT',
  vampStart: 'V<',
  vampEnd: '>V',
};

/** One label per ~110 px, from the same ladder the desktop uses. */
const TICKS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

function chooseTick(duration: number, width: number): number {
  const target = duration / Math.max(1, width / 110);
  return TICKS.find((t) => t >= target) ?? TICKS[TICKS.length - 1]!;
}

function label(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(s % 1 === 0 ? 0 : 1).padStart(s < 10 ? 4 : 2, '0')}`;
}

export function Waveform(props: Props) {
  const { cue, peaks } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 600, height: 118 });
  const [hover, setHover] = useState<MarkerKind | null>(null);
  const dragging = useRef<MarkerKind | null>(null);

  const duration = peaks ? peaks.numFrames / peaks.sampleRate : cue.fileDuration;

  const toX = useCallback(
    (seconds: number) => {
      if (duration <= 0) return EDGE;
      return EDGE + (seconds / duration) * (size.width - EDGE * 2);
    },
    [duration, size.width],
  );

  const toSeconds = useCallback(
    (x: number) => {
      if (duration <= 0) return 0;
      const t = ((x - EDGE) / (size.width - EDGE * 2)) * duration;
      return Math.max(0, Math.min(duration, t));
    },
    [duration, size.width],
  );

  const markers = (): { kind: MarkerKind; time: number }[] => {
    const list: { kind: MarkerKind; time: number }[] = [
      { kind: 'in', time: cue.startTime },
      { kind: 'out', time: resolvedEndTime(cue) },
    ];

    if (cue.vampEnabled) {
      list.push({ kind: 'vampStart', time: cue.vampStart });
      list.push({ kind: 'vampEnd', time: cue.vampEnd });
    }

    return list;
  };

  // Track the element's width so the drawing stays crisp and the ruler honest.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.max(120, entry.contentRect.width), height: 118 });
    });

    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, size.width, size.height);

    const waveTop = RULER;
    const waveHeight = size.height - RULER;
    const mid = waveTop + waveHeight / 2;

    ctx.fillStyle = '#1c1f25';
    ctx.fillRect(0, 0, size.width, size.height);

    if (!peaks || duration <= 0) {
      ctx.fillStyle = '#8b93a3';
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        cue.audioFile ? 'Audio not loaded' : 'No audio file',
        size.width / 2,
        mid,
      );
      return;
    }

    // Ruler.
    const tick = chooseTick(duration, size.width - EDGE * 2);
    ctx.strokeStyle = '#2c313a';
    ctx.fillStyle = '#8b93a3';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;

    for (let t = 0; t <= duration; t += tick) {
      const x = Math.round(toX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER - 4);
      ctx.lineTo(x, RULER);
      ctx.stroke();
      ctx.fillText(label(t), x + 3, 9);
    }

    // The whole file, dimmed — nothing is hidden, so trimmed audio can be
    // dragged back into the region.
    const drawPeaks = (from: number, to: number, colour: string) => {
      ctx.fillStyle = colour;

      const x0 = Math.floor(toX(from));
      const x1 = Math.ceil(toX(to));

      for (let x = x0; x <= x1; x++) {
        const t0 = toSeconds(x);
        const t1 = toSeconds(x + 1);

        let b0 = Math.floor((t0 * peaks.sampleRate) / peaks.samplesPerPeak);
        let b1 = Math.ceil((t1 * peaks.sampleRate) / peaks.samplesPerPeak);
        b0 = Math.max(0, b0);
        b1 = Math.min(peaks.data.length / 2, Math.max(b0 + 1, b1));

        let min = 0;
        let max = 0;

        for (let b = b0; b < b1; b++) {
          const lo = peaks.data[b * 2] ?? 0;
          const hi = peaks.data[b * 2 + 1] ?? 0;
          if (lo < min) min = lo;
          if (hi > max) max = hi;
        }

        const yTop = mid - max * (waveHeight / 2 - 2);
        const yBottom = mid - min * (waveHeight / 2 - 2);
        ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
      }
    };

    drawPeaks(0, duration, 'rgba(93, 219, 154, 0.28)');

    const inPoint = cue.startTime;
    const outPoint = resolvedEndTime(cue);

    // Vamp region behind the bright waveform.
    if (cue.vampEnabled && cue.vampEnd > cue.vampStart) {
      ctx.fillStyle = 'rgba(255, 200, 87, 0.14)';
      ctx.fillRect(toX(cue.vampStart), waveTop, toX(cue.vampEnd) - toX(cue.vampStart), waveHeight);
    }

    drawPeaks(inPoint, outPoint, '#5ddb9a');

    // Play head.
    if (props.playhead !== null) {
      const x = Math.round(toX(props.playhead)) + 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, waveTop);
      ctx.lineTo(x, size.height);
      ctx.stroke();
    }

    // Markers.
    for (const marker of markers()) {
      const x = Math.round(toX(marker.time)) + 0.5;
      const active = hover === marker.kind || dragging.current === marker.kind;

      ctx.strokeStyle = COLOURS[marker.kind];
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, waveTop);
      ctx.lineTo(x, size.height);
      ctx.stroke();

      // The tag flips to the left when it would run off the right edge.
      const tagWidth = 26;
      const flip = x + tagWidth > size.width;
      const tagX = flip ? x - tagWidth : x;

      ctx.fillStyle = COLOURS[marker.kind];
      ctx.fillRect(tagX, waveTop, tagWidth, 13);
      ctx.fillStyle = '#10131a';
      ctx.font = 'bold 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(LABELS[marker.kind], tagX + tagWidth / 2, waveTop + 10);
    }
  }, [cue, peaks, size, hover, duration, toX, toSeconds, props.playhead]);

  /** Closest wins, with later candidates winning ties — so at identical
      positions OUT beats IN and >V beats V<, matching the desktop's ordering. */
  const markerAt = (x: number): MarkerKind | null => {
    let best: MarkerKind | null = null;
    let bestDistance = GRAB;

    for (const marker of markers()) {
      const distance = Math.abs(toX(marker.time) - x);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = marker.kind;
      }
    }

    return best;
  };

  const localX = (e: React.PointerEvent | React.MouseEvent): number => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX - rect.left;
  };

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      style={{ width: '100%', height: size.height, cursor: hover ? 'ew-resize' : 'default' }}
      onPointerMove={(e) => {
        const x = localX(e);

        if (dragging.current) {
          props.onMove(dragging.current, toSeconds(x), false);
          return;
        }

        setHover(markerAt(x));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        const kind = markerAt(localX(e));
        if (!kind) return;

        dragging.current = kind;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;

        // One last move with isFinal, so an edit lands once in the undo history
        // rather than once per pixel.
        props.onMove(dragging.current, toSeconds(localX(e)), true);
        dragging.current = null;
      }}
      onDoubleClick={(e) => {
        if (markerAt(localX(e))) return;
        props.onScrub(toSeconds(localX(e)));
      }}
    />
  );
}
