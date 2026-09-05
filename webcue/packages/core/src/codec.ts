// The .cueshow codec. Ported from Source/Model/Cue.cpp (toVar/fromVar) and
// Source/Model/Show.cpp (save/load), and documented in docs/API.md.
//
// Three rules carry the round-trip promise:
//
// 1. UNKNOWN KEYS ARE PRESERVED. Anything this build does not recognise is kept
//    and written back out. The desktop refuses to open a show from a newer
//    version rather than dropping its fields; a browser tab that silently ate
//    them would be worse, because the operator would not find out until the
//    show ran differently.
//
// 2. PATHS STAY OPAQUE. audioFile is read and written as the exact string in the
//    file — never resolved, never normalised. A show written on Windows holds
//    "audio\cue1.wav"; rewriting the separators would stop it opening on the
//    machine that wrote it.
//
// 3. outputMessages round-trip verbatim. webcue cannot send MIDI or OSC yet, so
//    modelling them would model something unused — but dropping them would lose
//    the operator's work.
//
// Note on a documentation bug found while writing this: docs/API.md names the
// link's kind field "type", but the code writes and reads "mode". The code is
// authoritative; anything generated from the doc decodes to LinkMode::none and
// silently never fires.

import type {
  Cue,
  EndAction,
  FadeShape,
  LinkMode,
  RoutePoint,
  StreamingRef,
  VampRelease,
} from './cue.js';
import { makeCue } from './cue.js';
import { asArray, asBool, asDouble, asInt, asString, clamp, isObject } from './jsonvar.js';

export const showFormatVersion = 1;

export interface ShowData {
  masterGainDb: number;
  defaultFadeInTime: number;
  defaultFadeOutTime: number;
  defaultFadeShape: FadeShape;
  cues: Cue[];
  /** Root-level keys this build did not recognise, preserved on save. */
  unknown?: Record<string, unknown>;
}

export function makeShow(overrides: Partial<ShowData> = {}): ShowData {
  return {
    masterGainDb: 0,
    defaultFadeInTime: 0,
    defaultFadeOutTime: 0,
    defaultFadeShape: 'equalPower',
    cues: [],
    ...overrides,
  };
}

//== Enum coercions ===========================================================
// Every one falls back rather than throwing, matching Cue.cpp:20-84 and
// FadeCurve.cpp:29-40. Getting a fallback wrong is invisible: the show opens
// and behaves differently.

function fadeShapeFrom(s: string): FadeShape {
  switch (s) {
    case 'linear':
    case 'exponential':
    case 'logarithmic':
    case 'sCurve':
      return s;
    default:
      return 'equalPower';
  }
}

function linkModeFrom(s: string): LinkMode {
  switch (s) {
    case 'autoContinue':
    case 'autoFollow':
    case 'crossfade':
      return s;
    default:
      return 'none';
  }
}

function vampReleaseFrom(s: string): VampRelease {
  return s === 'immediately' ? 'immediately' : 'atEndOfPass';
}

function endActionFrom(s: string): EndAction {
  return s === 'hardStop' ? 'hardStop' : 'fadeOut';
}

function cueTypeFrom(s: string): Cue['type'] {
  return s === 'streaming' ? 'streaming' : s === 'control' ? 'control' : 'audioFile';
}

//== Cue ======================================================================

/** Every key this build writes. Anything outside it is preserved untouched. */
const knownCueKeys = new Set([
  'id',
  'type',
  'number',
  'name',
  'notes',
  'audioFile',
  'fileDuration',
  'fileChannels',
  'fileSampleRate',
  'streaming',
  'startTime',
  'endTime',
  'gainDb',
  'preWait',
  'fadeInTime',
  'fadeInShape',
  'fadeOutTime',
  'fadeOutShape',
  'loopEnabled',
  'loopCount',
  'vampEnabled',
  'vampStart',
  'vampEnd',
  'vampRelease',
  'endAction',
  'endFadeTime',
  'firePlayWithCue',
  'link',
  'outputMessages',
  'routing',
]);

const knownRootKeys = new Set([
  'format',
  'version',
  'masterGainDb',
  'defaultFadeInTime',
  'defaultFadeOutTime',
  'defaultFadeShape',
  'cues',
]);

function collectUnknown(
  source: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> | undefined {
  let extra: Record<string, unknown> | undefined;

  for (const key of Object.keys(source)) {
    if (known.has(key)) continue;
    extra ??= {};
    extra[key] = source[key];
  }

  return extra;
}

export function decodeCue(raw: unknown): Cue {
  const cue = makeCue();

  if (!isObject(raw)) return cue;

  const id = asString(raw['id']);
  if (id.length > 0) cue.id = id;

  cue.type = cueTypeFrom(asString(raw['type']));
  cue.number = asString(raw['number']);
  cue.name = asString(raw['name']);
  cue.notes = asString(raw['notes']);

  cue.audioFile = asString(raw['audioFile']);
  cue.fileDuration = asDouble(raw['fileDuration']);
  cue.fileChannels = asInt(raw['fileChannels']);
  cue.fileSampleRate = asDouble(raw['fileSampleRate']);

  const streaming = raw['streaming'];
  if (isObject(streaming)) {
    // provider, audioPath and the capture channels used to live here. They are
    // installation settings now, so anything older simply drops those fields.
    cue.streaming = {
      uri: asString(streaming['uri']),
      displayName: asString(streaming['displayName']),
      shuffle: asBool(streaming['shuffle']),
      repeat: asBool(streaming['repeat']),
    };
  }

  cue.startTime = asDouble(raw['startTime']);
  cue.endTime = asDouble(raw['endTime']);
  cue.gainDb = asDouble(raw['gainDb']);
  cue.preWait = asDouble(raw['preWait']);

  cue.fadeInTime = asDouble(raw['fadeInTime']);
  cue.fadeInShape = fadeShapeFrom(asString(raw['fadeInShape']));
  cue.fadeOutTime = asDouble(raw['fadeOutTime']);
  cue.fadeOutShape = fadeShapeFrom(asString(raw['fadeOutShape']));

  cue.loopEnabled = asBool(raw['loopEnabled']);
  cue.loopCount = asInt(raw['loopCount']);

  cue.vampEnabled = asBool(raw['vampEnabled']);
  cue.vampStart = asDouble(raw['vampStart']);
  cue.vampEnd = asDouble(raw['vampEnd']);
  cue.vampRelease = vampReleaseFrom(asString(raw['vampRelease']));

  cue.endAction = endActionFrom(asString(raw['endAction']));

  // Defaults that are NOT zero. Miss endFadeTime's and every older file opens
  // with a 0 s Fade/Stop — a hard stop where a three-second fade was built.
  cue.endFadeTime = clamp(0, 300, asDouble(raw['endFadeTime'], 3));
  cue.firePlayWithCue = asBool(raw['firePlayWithCue'], true);

  const link = raw['link'];
  if (isObject(link)) {
    cue.link.mode = linkModeFrom(asString(link['mode']));

    const target = asString(link['target']);
    cue.link.target = target.length > 0 ? target : null;

    cue.link.delay = asDouble(link['delay'], 0);
    cue.link.duration = asDouble(link['duration'], 3);
    cue.link.shape = fadeShapeFrom(asString(link['shape']));
  }

  cue.outputMessages = asArray(raw['outputMessages']);

  cue.routing = asArray(raw['routing']).map((item): RoutePoint => {
    const r = isObject(item) ? item : {};
    return {
      sourceChannel: asInt(r['src']),
      outputChannel: asInt(r['dst']),
      gain: asDouble(r['gain'], 1),
    };
  });

  const extra = collectUnknown(raw, knownCueKeys);
  if (extra) cue.unknown = extra;

  return cue;
}

export function encodeCue(cue: Cue): Record<string, unknown> {
  // Key order follows Cue::toVar so a diff against a desktop-written file stays
  // readable. Unknown keys go last: they were not in the original order anyway,
  // and putting them first would let a stale copy shadow a known key.
  const out: Record<string, unknown> = {
    id: cue.id,
    type: cue.type,
    number: cue.number,
    name: cue.name,
    notes: cue.notes,

    audioFile: cue.audioFile,
    fileDuration: cue.fileDuration,
    fileChannels: cue.fileChannels,
    fileSampleRate: cue.fileSampleRate,
  };

  // toVar writes this only for a streaming cue, so neither does this.
  if (cue.type === 'streaming') {
    const s: StreamingRef = cue.streaming;
    out['streaming'] = {
      uri: s.uri,
      displayName: s.displayName,
      shuffle: s.shuffle,
      repeat: s.repeat,
    };
  }

  out['startTime'] = cue.startTime;
  out['endTime'] = cue.endTime;
  out['gainDb'] = cue.gainDb;
  out['preWait'] = cue.preWait;

  out['fadeInTime'] = cue.fadeInTime;
  out['fadeInShape'] = cue.fadeInShape;
  out['fadeOutTime'] = cue.fadeOutTime;
  out['fadeOutShape'] = cue.fadeOutShape;

  out['loopEnabled'] = cue.loopEnabled;
  out['loopCount'] = cue.loopCount;

  out['vampEnabled'] = cue.vampEnabled;
  out['vampStart'] = cue.vampStart;
  out['vampEnd'] = cue.vampEnd;
  out['vampRelease'] = cue.vampRelease;

  out['endAction'] = cue.endAction;
  out['endFadeTime'] = cue.endFadeTime;
  out['firePlayWithCue'] = cue.firePlayWithCue;

  out['link'] = {
    mode: cue.link.mode,
    // A null target is written as "", never omitted — fromVar reads empty as
    // null, so omitting the key would break the round trip.
    target: cue.link.target ?? '',
    delay: cue.link.delay,
    duration: cue.link.duration,
    shape: cue.link.shape,
  };

  out['outputMessages'] = cue.outputMessages;

  out['routing'] = cue.routing.map((r) => ({
    src: r.sourceChannel,
    dst: r.outputChannel,
    gain: r.gain,
  }));

  if (cue.unknown) {
    for (const [key, value] of Object.entries(cue.unknown)) {
      if (!(key in out)) out[key] = value;
    }
  }

  return out;
}

//== Show =====================================================================

export class ShowFormatError extends Error {}

/** Show.cpp:143-177. Refuses what the desktop refuses, and for the same reasons. */
export function decodeShow(json: unknown): ShowData {
  if (!isObject(json)) {
    throw new ShowFormatError('That does not look like a SimpleCue show file.');
  }

  // "cue-player-show" is what the format was called before the app was renamed.
  // Shows written then are otherwise identical, so there is no reason to refuse
  // them. This is deliberate, not a stale reference.
  const format = asString(json['format']);

  if (format !== 'simplecue-show' && format !== 'cue-player-show') {
    throw new ShowFormatError('That does not look like a SimpleCue show file.');
  }

  if (asInt(json['version']) > showFormatVersion) {
    throw new ShowFormatError('That show was saved by a newer version of SimpleCue.');
  }

  const show = makeShow({
    masterGainDb: clamp(-100, 12, asDouble(json['masterGainDb'], 0)),
    defaultFadeInTime: clamp(0, 120, asDouble(json['defaultFadeInTime'], 0)),
    defaultFadeOutTime: clamp(0, 120, asDouble(json['defaultFadeOutTime'], 0)),
    defaultFadeShape: fadeShapeFrom(asString(json['defaultFadeShape'])),
    cues: asArray(json['cues']).map(decodeCue),
  });

  const extra = collectUnknown(json, knownRootKeys);
  if (extra) show.unknown = extra;

  return show;
}

export function encodeShow(show: ShowData): Record<string, unknown> {
  const out: Record<string, unknown> = {
    format: 'simplecue-show',
    version: showFormatVersion,
    masterGainDb: show.masterGainDb,
    defaultFadeInTime: show.defaultFadeInTime,
    defaultFadeOutTime: show.defaultFadeOutTime,
    defaultFadeShape: show.defaultFadeShape,
    cues: show.cues.map(encodeCue),
  };

  if (show.unknown) {
    for (const [key, value] of Object.entries(show.unknown)) {
      if (!(key in out)) out[key] = value;
    }
  }

  return out;
}

export function parseShow(text: string): ShowData {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ShowFormatError(`Could not read show: ${(e as Error).message}`);
  }

  return decodeShow(json);
}

/** Two-space indent, matching juce::JSON::toString(v, false) closely enough to
    keep a show file diffable. Byte-identical output is NOT a goal: JUCE writes a
    double zero as "0.0" and JSON.stringify writes "0". */
export function serialiseShow(show: ShowData): string {
  return JSON.stringify(encodeShow(show), null, 2);
}
