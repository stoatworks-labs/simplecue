// The .cueshow codec, pinned against Source/Model/Cue.cpp (toVar/fromVar) and
// Source/Model/Show.cpp (save/load).
//
// The property that matters is encode(decode(json)) deep-equals json, on files
// the DESKTOP wrote. The other direction is false by construction, because the
// clamps run on decode: a file with endFadeTime 999 decodes to 300.
//
// That test needs a real file and is at the bottom, currently skipped with an
// explanation rather than substituted with a hand-written one — see the note
// there. Everything above it pins the decode rules that make it possible.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeCue } from '../src/cue.js';
import {
  ShowFormatError,
  decodeCue,
  decodeShow,
  encodeCue,
  encodeShow,
  makeShow,
  parseShow,
  serialiseShow,
} from '../src/codec.js';

describe('decodeCue — defaults that are not zero', () => {
  it('defaults endFadeTime to 3, not 0', () => {
    // Cue.cpp:352. Miss this and every older file opens with a hard stop where
    // the operator built a three-second fade — silent, and not visibly wrong.
    expect(decodeCue({}).endFadeTime).toBe(3);
  });

  it('clamps endFadeTime to [0, 300]', () => {
    expect(decodeCue({ endFadeTime: 999 }).endFadeTime).toBe(300);
    expect(decodeCue({ endFadeTime: -5 }).endFadeTime).toBe(0);
  });

  it('defaults firePlayWithCue to true', () => {
    // Cue.cpp:353. Defaulting to false would make every cue a container that
    // does nothing when fired.
    expect(decodeCue({}).firePlayWithCue).toBe(true);
    expect(decodeCue({ firePlayWithCue: false }).firePlayWithCue).toBe(false);
  });

  it('defaults link.duration to 3 and link.delay to 0', () => {
    const cue = decodeCue({ link: { mode: 'crossfade' } });
    expect(cue.link.duration).toBe(3);
    expect(cue.link.delay).toBe(0);
  });

  it('defaults a route gain to 1', () => {
    const cue = decodeCue({ routing: [{ src: 0, dst: 1 }] });
    expect(cue.routing[0]?.gain).toBe(1);
  });
});

describe('decodeCue — tolerant enum coercion', () => {
  // fromVar never rejects: an unrecognised string falls back. A strict schema
  // parse would refuse files the desktop opens without complaint.
  it('falls back rather than throwing', () => {
    const cue = decodeCue({
      type: 'nonsense',
      fadeInShape: 'nonsense',
      vampRelease: 'nonsense',
      endAction: 'nonsense',
      link: { mode: 'nonsense' },
    });

    expect(cue.type).toBe('audioFile');
    expect(cue.fadeInShape).toBe('equalPower');
    expect(cue.vampRelease).toBe('atEndOfPass');
    expect(cue.endAction).toBe('fadeOut');
    expect(cue.link.mode).toBe('none');
  });

  it('reads the link kind from "mode", which is what the code writes', () => {
    // docs/API.md calls this key "type" and is wrong. A file generated from the
    // documentation decodes to "none" and silently never fires.
    expect(decodeCue({ link: { mode: 'crossfade' } }).link.mode).toBe('crossfade');
    expect(decodeCue({ link: { type: 'crossfade' } }).link.mode).toBe('none');
  });
});

describe('link.target null round-trip', () => {
  it('reads "" as null and writes null back as ""', () => {
    // toVar writes an empty string for a null uuid and fromVar reads empty as
    // null. Omitting the key instead would break the round trip.
    expect(decodeCue({ link: { mode: 'autoFollow', target: '' } }).link.target).toBeNull();

    const encoded = encodeCue(makeCue({ link: { mode: 'autoFollow', target: null, delay: 0, duration: 3, shape: 'equalPower' } }));
    expect((encoded['link'] as Record<string, unknown>)['target']).toBe('');
  });
});

describe('paths stay opaque', () => {
  it('does not normalise separators', () => {
    // A show written on Windows holds "audio\cue1.wav". Rewriting it to "/"
    // would stop the file opening on the machine that wrote it.
    const path = 'audio\\act one\\cue1.wav';
    const cue = decodeCue({ audioFile: path });

    expect(cue.audioFile).toBe(path);
    expect(encodeCue(cue)['audioFile']).toBe(path);
  });
});

describe('unknown keys are preserved', () => {
  it('keeps a cue key this build does not know and writes it back', () => {
    const cue = decodeCue({ number: '1', somethingNewer: { nested: true } });

    expect(cue.unknown).toEqual({ somethingNewer: { nested: true } });
    expect(encodeCue(cue)['somethingNewer']).toEqual({ nested: true });
  });

  it('keeps an unknown root key', () => {
    const show = decodeShow({
      format: 'simplecue-show',
      version: 1,
      cues: [],
      showNotes: 'from a newer build',
    });

    expect(show.unknown).toEqual({ showNotes: 'from a newer build' });
    expect(encodeShow(show)['showNotes']).toBe('from a newer build');
  });

  it('never lets a preserved key shadow a known one', () => {
    const cue = makeCue({ number: 'real' });
    cue.unknown = { number: 'stale' };

    expect(encodeCue(cue)['number']).toBe('real');
  });

  it('round-trips outputMessages verbatim without modelling them', () => {
    const messages = [{ type: 'osc', address: '/go', args: [1, 'two'] }];
    const cue = decodeCue({ outputMessages: messages });

    expect(encodeCue(cue)['outputMessages']).toEqual(messages);
  });
});

describe('decodeShow — Show.cpp:143-177', () => {
  it('accepts the pre-rename format name', () => {
    // "cue-player-show" is deliberate compatibility, not a stale reference.
    expect(() => decodeShow({ format: 'cue-player-show', version: 1, cues: [] })).not.toThrow();
  });

  it('refuses a file that is not a show', () => {
    expect(() => decodeShow({ format: 'something-else' })).toThrow(ShowFormatError);
    expect(() => decodeShow([])).toThrow(ShowFormatError);
  });

  it('refuses a newer format version rather than dropping its fields', () => {
    expect(() => decodeShow({ format: 'simplecue-show', version: 99, cues: [] })).toThrow(
      /newer version/,
    );
  });

  it('clamps the show-level values', () => {
    const show = decodeShow({
      format: 'simplecue-show',
      version: 1,
      masterGainDb: 500,
      defaultFadeInTime: 999,
      cues: [],
    });

    expect(show.masterGainDb).toBe(12);
    expect(show.defaultFadeInTime).toBe(120);
  });

  it('reports a JSON syntax error as a show-format error', () => {
    expect(() => parseShow('{ not json')).toThrow(ShowFormatError);
  });
});

describe('streaming is written only for a streaming cue', () => {
  it('omits the object on an audio cue, as toVar does', () => {
    expect('streaming' in encodeCue(makeCue())).toBe(false);
  });

  it('writes it on a streaming cue', () => {
    const cue = makeCue({ type: 'streaming' });
    cue.streaming = { uri: 'spotify:playlist:x', displayName: 'Preshow', shuffle: true, repeat: false };

    expect(encodeCue(cue)['streaming']).toEqual({
      uri: 'spotify:playlist:x',
      displayName: 'Preshow',
      shuffle: true,
      repeat: false,
    });
  });
});

describe('serialiseShow', () => {
  it('produces text that parses back to an equal show', () => {
    const show = makeShow({
      masterGainDb: -3,
      cues: [makeCue({ number: '1', name: 'Opening', fileDuration: 10, endTime: 10 })],
    });

    expect(parseShow(serialiseShow(show))).toEqual(show);
  });
});

//== The test that actually proves compatibility ==============================

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

const fixtures: string[] = existsSync(fixtureDir)
  ? readdirSync(fixtureDir).filter((f: string) => f.endsWith('.cueshow'))
  : [];

// Real files, never synthetic ones. A hand-written fixture only tests this
// codec's reading of itself; a file the desktop app wrote tests the thing we
// actually promise. Drop one into test/fixtures/ — File > Save As from
// SimpleCue — and this suite starts running. A skipped suite is honest; one
// that quietly substitutes a hand-made file is not.
describe.skipIf(fixtures.length === 0)('round-trip against desktop-written shows', () => {
  for (const name of fixtures) {
    it(`${name} survives encode(decode(json)) unchanged`, () => {
      const text = readFileSync(join(fixtureDir, name), 'utf8');
      const original = JSON.parse(text) as Record<string, unknown>;

      expect(encodeShow(decodeShow(original))).toEqual(original);
    });

    it(`${name} has no cue key this codec does not account for`, () => {
      const text = readFileSync(join(fixtureDir, name), 'utf8');
      const parsed = JSON.parse(text) as { cues?: Record<string, unknown>[] };

      // If SimpleCue gains a cue property, this fails and names it — rather than
      // the field being silently carried in the unknown bag and never surfaced.
      for (const cue of parsed.cues ?? []) {
        expect(decodeCue(cue).unknown, `unhandled keys in ${name}`).toBeUndefined();
      }
    });
  }
});
