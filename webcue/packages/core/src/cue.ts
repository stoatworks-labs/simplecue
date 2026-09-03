// The cue model, ported from Source/Model/Cue.h and Cue.cpp.
//
// The enums are string unions whose members are exactly the strings the desktop
// app writes to a .cueshow (Source/Model/Cue.cpp:7-84, Source/Model/FadeCurve.cpp:13-40).
// That makes the JSON the canonical form and the codec close to a straight copy,
// which is what a round-trip promise needs. The wasm boundary wants integers
// instead, so the orderings are given separately at the bottom.
//
// Times are seconds *within the source file*, not within the trimmed region, so
// moving the in point never invalidates the vamp markers (Cue.h:112-115).

export type CueType = 'audioFile' | 'streaming' | 'control';

export type FadeShape =
  | 'linear'
  | 'equalPower'
  | 'exponential'
  | 'logarithmic'
  | 'sCurve';

export type LinkMode = 'none' | 'autoContinue' | 'autoFollow' | 'crossfade';

export type VampRelease = 'atEndOfPass' | 'immediately';

export type EndAction = 'fadeOut' | 'hardStop';

/** Hard ceilings the wasm engine is sized to. Source/Model/Cue.h:16-21. */
export const limits = {
  maxSourceChannels: 16,
  maxOutputChannels: 64,
  maxVoices: 32,
} as const;

export interface Link {
  mode: LinkMode;
  /** Null means "the next cue in the list" — Cue.h:57. */
  target: string | null;
  /** Seconds. Ignored by crossfade. */
  delay: number;
  /** Crossfade length in seconds. */
  duration: number;
  shape: FadeShape;
}

/** One routed connection: source channel -> output channel, at a linear gain. */
export interface RoutePoint {
  sourceChannel: number;
  outputChannel: number;
  gain: number;
}

export interface StreamingRef {
  uri: string;
  displayName: string;
  shuffle: boolean;
  repeat: boolean;
}

export interface Cue {
  id: string;
  number: string;
  name: string;
  notes: string;
  type: CueType;

  /** Path as written in the show file — relative to the show when it can be.
      In a browser this is a key into the resolved-file map, not a real path. */
  audioFile: string;
  streaming: StreamingRef;

  startTime: number;
  /** A value <= 0 means "end of file". Use resolvedEndTime(). */
  endTime: number;
  fileDuration: number;
  fileChannels: number;
  fileSampleRate: number;

  gainDb: number;
  preWait: number;

  fadeInTime: number;
  fadeInShape: FadeShape;
  fadeOutTime: number;
  fadeOutShape: FadeShape;

  loopEnabled: boolean;
  /** Total passes. 0 means forever. */
  loopCount: number;

  vampEnabled: boolean;
  vampStart: number;
  vampEnd: number;
  vampRelease: VampRelease;

  endAction: EndAction;
  endFadeTime: number;
  firePlayWithCue: boolean;

  link: Link;

  /** Kept opaque on purpose. webcue cannot send MIDI or OSC yet, so modelling
      these would be modelling something unused — but dropping them would lose
      data from a show the desktop app wrote. They round-trip verbatim. */
  outputMessages: readonly unknown[];

  routing: RoutePoint[];

  /** Anything in the file this build did not recognise, preserved so that saving
      a show written by a newer SimpleCue cannot silently destroy its fields. */
  unknown?: Record<string, unknown>;
}

/** A cue with the same defaults a freshly constructed C++ Cue has. */
export function makeCue(overrides: Partial<Cue> = {}): Cue {
  return {
    id: newCueId(),
    number: '',
    name: '',
    notes: '',
    type: 'audioFile',
    audioFile: '',
    streaming: { uri: '', displayName: '', shuffle: false, repeat: false },
    startTime: 0,
    endTime: 0,
    fileDuration: 0,
    fileChannels: 0,
    fileSampleRate: 0,
    gainDb: 0,
    preWait: 0,
    fadeInTime: 0,
    fadeInShape: 'equalPower',
    fadeOutTime: 0,
    fadeOutShape: 'equalPower',
    loopEnabled: false,
    loopCount: 0,
    vampEnabled: false,
    vampStart: 0,
    vampEnd: 0,
    vampRelease: 'atEndOfPass',
    endAction: 'fadeOut',
    endFadeTime: 3,
    firePlayWithCue: true,
    link: { mode: 'none', target: null, delay: 0, duration: 3, shape: 'equalPower' },
    outputMessages: [],
    routing: [],
    ...overrides,
  };
}

export function newCueId(): string {
  // Dashed lower-case, matching juce::Uuid::toDashedString().
  return crypto.randomUUID();
}

//== Derived properties =======================================================
// Ports of Cue.cpp:90-183. These decide sub-cue structure and link scheduling,
// so they have to agree with the C++ exactly.

/** Out point in seconds, resolving "<= 0 means end of file". Cue.cpp:90-97. */
export function resolvedEndTime(cue: Cue): number {
  return cue.endTime > 0 ? cue.endTime : cue.fileDuration;
}

/** Length of the trimmed region before looping or vamping. */
export function trimmedLength(cue: Cue): number {
  return Math.max(0, resolvedEndTime(cue) - cue.startTime);
}

/** Whether the vamp markers describe a usable region. Cue.cpp:99-113.
    Note it compares against startTime, not zero, and tolerates an unknown
    file length by treating a non-positive region end as "no upper bound". */
export function hasUsableVamp(cue: Cue): boolean {
  if (!cue.vampEnabled) return false;

  const regionEnd = resolvedEndTime(cue);

  return (
    cue.vampEnd > cue.vampStart &&
    cue.vampStart >= cue.startTime &&
    (regionEnd <= 0 || cue.vampEnd <= regionEnd)
  );
}

/** True when nothing can predict when this cue finishes, so a link from it
    cannot be pre-scheduled. Cue.cpp:115-127.

    Note this looks at whether a vamp is *armed*, not whether it has been
    released: releasing one mid-cue does not retroactively make the cue
    predictable, and the desktop app does not re-plan the link either. */
export function isOpenEnded(cue: Cue): boolean {
  if (cue.type === 'control') return false; // fires its messages and is done
  if (cue.type === 'streaming') return true; // the service decides
  if (hasUsableVamp(cue)) return true;
  return cue.loopEnabled && cue.loopCount <= 0;
}

/** Playing length ignoring vamp repeats, including finite loop repeats.
    Returns 0 both for an endless cue and for a control cue, which have
    opposite reasons — isOpenEnded() is what separates them. Cue.cpp:129-145. */
export function playbackLength(cue: Cue): number {
  if (cue.type === 'control' || cue.type === 'streaming') return 0;
  if (hasUsableVamp(cue)) return 0;

  const once = trimmedLength(cue);

  if (!cue.loopEnabled) return once;
  if (cue.loopCount <= 0) return 0; // endless

  return once * cue.loopCount;
}

/** The effective routing: the explicit matrix when non-empty, otherwise a 1:1
    default of file channels onto the first outputs. Cue.cpp:147-172.

    The filtering is load-bearing and is the reason webcue needs a fold-to-stereo
    escape hatch. An explicit matrix has every route dropped whose channel no
    longer exists, and AudioEngine::buildSpec (AudioEngine.cpp:262-266) then
    REFUSES a cue whose surviving list is empty. On the desktop that is right —
    you plugged in the wrong interface. In a browser, where the destination is
    almost always stereo, a show authored for eight outputs would refuse every
    single cue. Keep this faithful; handle the browser case above it. */
export function effectiveRouting(
  cue: Cue,
  numFileChannels: number,
  numDeviceOutputs: number,
): RoutePoint[] {
  if (cue.routing.length > 0) {
    return cue.routing.filter(
      (r) =>
        r.sourceChannel >= 0 &&
        r.sourceChannel < numFileChannels &&
        r.outputChannel >= 0 &&
        r.outputChannel < numDeviceOutputs,
    );
  }

  const n = Math.min(numFileChannels, numDeviceOutputs, limits.maxSourceChannels);
  const routes: RoutePoint[] = [];

  for (let c = 0; c < n; c++) {
    routes.push({ sourceChannel: c, outputChannel: c, gain: 1 });
  }

  return routes;
}

/** True when a cue carries an explicit matrix that addresses outputs this device
    does not have, so every route was filtered away and buildSpec would refuse it.

    This is the condition the app offers a fold-to-stereo for. It must never fold
    silently: doing so would make the browser build quietly disagree with the
    desktop about what the show sounds like, which is worse than refusing. */
export function isRoutedOffDevice(cue: Cue, numFileChannels: number, numDeviceOutputs: number): boolean {
  return (
    cue.routing.length > 0 &&
    effectiveRouting(cue, numFileChannels, numDeviceOutputs).length === 0
  );
}

//== The wasm boundary ========================================================
// CueVoice takes integers. These orderings match the C++ enum declarations and
// must not be reordered — webcue_engine.cpp maps them straight back.

export const fadeShapeOrder: readonly FadeShape[] = [
  'linear',
  'equalPower',
  'exponential',
  'logarithmic',
  'sCurve',
];

export function fadeShapeIndex(shape: FadeShape): number {
  const i = fadeShapeOrder.indexOf(shape);
  return i < 0 ? 1 : i; // equalPower, matching the C++ fallbacks
}

export function vampReleaseIndex(release: VampRelease): number {
  return release === 'immediately' ? 1 : 0;
}
