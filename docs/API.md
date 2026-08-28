# SimpleCue interfaces

SimpleCue has two public interfaces:

1. **Control protocols** — OSC, MIDI, MSC, MMC, Art-Net and sACN, in and out.
   **See [`control.md`](control.md)** — that is the complete reference and this document does
   not duplicate it.
2. **The `.cueshow` file format** — documented below.

---

# The `.cueshow` format

A show is a single JSON file. It is plain text on purpose: readable, diffable, and
recoverable by hand if something goes wrong at a venue.

## Root object

```json
{
  "format": "simplecue-show",
  "version": 1,
  "masterGainDb": 0.0,
  "defaultFadeInTime": 0.0,
  "defaultFadeOutTime": 0.0,
  "defaultFadeShape": "<curve name>",
  "cues": [ ... ]
}
```

| Key | Type | Meaning |
|---|---|---|
| `format` | string | `"simplecue-show"` |
| `version` | int | Format version. Currently **1**. |
| `masterGainDb` | number | Show master gain, dB |
| `defaultFadeInTime` | number | Seconds, applied to new cues |
| `defaultFadeOutTime` | number | Seconds |
| `defaultFadeShape` | string | Default fade curve name — see [Enumerated string values](#enumerated-string-values) |
| `cues` | array | The cue list |

### Compatibility rules

- **`"cue-player-show"` is also accepted** on load. That's the pre-rename format name, kept
  deliberately so old shows still open. It is not a stale reference — don't remove it.
- **A file whose `version` is greater than the running build's is refused**, rather than
  being loaded with unknown fields silently dropped. A newer show opened in an older
  SimpleCue would otherwise appear to load and then behave differently from what the operator
  built.
- Audio-file paths are stored **relative to the show file's directory**, so a show plus its
  audio folder can be moved or copied to another machine as a unit.

### Saving is atomic

The show is written to a sibling `.tmp` file and then moved into place, so a failure
part-way through cannot destroy the show already on disk. At a venue this file is often the
only copy.

---

## Cue object

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Stable internal identifier |
| `type` | string | `audioFile`, `streaming` or `control` — see below |
| `number` | string | **Operator-facing cue number — free text.** `"12"`, `"12.5"`, `"PRE"` |
| `name` | string | Cue name |
| `notes` | string | Operator notes |
| `audioFile` | string | Path, relative to the show file |
| `startTime` | number | In point, seconds |
| `endTime` | number | Out point, seconds. **`0` (or less) means "end of file"** |
| `fileDuration` | number | Cached source length |
| `fileChannels` | int | Cached source channel count |
| `fileSampleRate` | number | Cached source rate |
| `gainDb` | number | Cue gain, dB |
| `preWait` | number | Seconds to wait before sounding |
| `fadeInTime` / `fadeOutTime` | number | Seconds |
| `fadeInShape` / `fadeOutShape` | string | Curve name — see below |
| `loopEnabled` | bool | |
| `loopCount` | int | `0` means loop forever |
| `vampEnabled` | bool | |
| `vampStart` / `vampEnd` | number | Vamp region, seconds |
| `vampRelease` | string | How the vamp is released |
| `endAction` | string | What happens at the end |
| `endFadeTime` | number | Seconds, default `3.0` |
| `firePlayWithCue` | bool | Default **true** — see below |
| `link` | object | Cue-to-cue handover |
| `routing` | array | Output routing matrix |
| `outputMessages` | array | Control messages this cue emits |
| `streaming` | object | Streaming settings |

`number` is free text because real shows use `12.5` and `PRE`, not just integers. **Control
protocols address cues by `number`** — with one exception, see below.

### Enumerated string values

Every enum in this format is stored as a string, and **every one of them silently falls back
to a default** when the string is not recognised. A misspelling, or the right value under the
wrong key name, does not fail the load and does not warn — the show opens and then behaves
differently from what you wrote. Spell these exactly.

| Field | Accepted values | Silently falls back to |
|---|---|---|
| `type` | `audioFile`, `streaming`, `control` | `audioFile` |
| `fadeInShape`, `fadeOutShape`, `link.shape`, `defaultFadeShape` | `linear`, `equalPower`, `exponential`, `logarithmic`, `sCurve` | `equalPower` |
| `endAction` | `fadeOut`, `hardStop` | `fadeOut` |
| `vampRelease` | `atEndOfPass`, `immediately` | `atEndOfPass` |
| `link.mode` | `none`, `autoContinue`, `autoFollow`, `crossfade` | `none` |
| `outputMessages[].type` | see [`outputMessages`](#outputmessages--messages-this-cue-sends) below | `osc` |

### `link` — how a cue hands over to the next

| Key | Type | Meaning |
|---|---|---|
| `mode` | string | The handover kind. **The key is `mode`** — not `type`. |
| `target` | string | Target cue's `id`. **Empty or absent means "the next cue in the list"** |
| `delay` | number | Seconds. **Ignored by crossfade.** |
| `duration` | number | Crossfade length, seconds. Default `3.0` |
| `shape` | string | Curve used for the crossfade. Default `equalPower` |

`mode` values:

| Value | What it does |
|---|---|
| `none` | Nothing follows automatically |
| `autoContinue` | Fires the target when this cue **starts**, after `delay` seconds |
| `autoFollow` | Fires the target when this cue **finishes**, after `delay` seconds |
| `crossfade` | Starts the target `duration` seconds before this cue's out point, fading this cue out across the overlap |

```json
"link": { "mode": "crossfade", "target": "", "delay": 0.0, "duration": 3.0, "shape": "equalPower" }
```

A `link` written with `"type"` instead of `"mode"` decodes to `none`: the cue never hands
over, with no error at load and nothing to see until the show fails to advance in front of an
audience.

### `routing` — the output matrix

An array of route points:

```json
{ "src": 0, "dst": 0, "gain": 1.0 }
```

`src` is a channel of the source file, `dst` an output channel of the device, `gain` linear.
A cue with no explicit routing gets a sensible default derived from the file's channel count
and the device's output count.

### `streaming` — for cues of type `streaming`

Written only when `type` is `streaming`, and ignored otherwise.

| Key | Type | Meaning |
|---|---|---|
| `uri` | string | Provider-native URI or a pasted share link. Normalised by the provider adapter |
| `displayName` | string | Cached label, so the cue list reads sensibly offline |
| `shuffle` | bool | |
| `repeat` | bool | |

Which service the account is on, which developer application it authenticates as and which
loopback input the audio arrives on are properties of the **installation**, not of a cue, and
are not stored in the show.

### `outputMessages` — messages this cue sends

An array of MIDI/OSC messages emitted when the cue fires. Available on **every** cue, not
just cues of type `control`. What the messages mean on the wire is in
[`control.md`](control.md); their storage is:

| Key | Type | Meaning |
|---|---|---|
| `type` | string | `osc`, `midiNoteOn`, `midiNoteOff`, `midiControlChange`, `midiProgramChange`, `midiShowControl`, `midiMachineControl` |
| `delay` | number | Extra seconds on top of the cue's pre-wait. Negative values are clamped to `0` |
| `oscTarget` | string | Configured target name |
| `oscAddress` | string | OSC address. Defaults to `/cue/1/go` when absent |
| `oscArguments` | string | |
| `midiTarget` | string | Configured output name |
| `midiChannel` | int | `1`–`16` |
| `midiData1` / `midiData2` | int | `0`–`127` |
| `mscDeviceID` | int | `0`–`127` |
| `mscCommandFormat` | int | MSC command format byte |
| `mscCommand` | int | MSC command byte |
| `mscCueNumber` / `mscCueList` | string | |
| `mmcCommand` | int | MMC command byte |

Every field is written for every message regardless of `type`; the ones that don't apply are
simply ignored on load. Out-of-range numbers are **clamped, not rejected**.

### `firePlayWithCue`

When **true** (the default), firing the cue also plays it, and standby skips the Play
sub-cue after the header — so the same audio is never offered to the operator twice.

---

## Cue steps are derived, never stored

A cue expands into the steps GO walks through — **Play** always, **Devamp** only if the cue
has a vamp, **Fade/Stop** always. Those steps are **computed at runtime** and never written
to the file.

This matters if you are generating `.cueshow` files: **do not try to author a step list.**
Set the cue's properties and the steps follow. It also means removing a vamp automatically
removes its Devamp step, with no stale state to clean up.

---

## Generating show files externally

Reasonable, and the format is stable — but:

- Set `"format": "simplecue-show"` and `"version": 1`.
- Keep audio paths **relative to the show file**.
- Don't invent step lists (above).
- Use `link.mode`, not `link.type` — and check every other enum against
  [Enumerated string values](#enumerated-string-values). An unrecognised value is not an
  error; it decodes to the fallback and the show quietly does something else.
- `loopCount: 0` means forever, not "no loops" — use `loopEnabled: false` for that.
- Cue `number` values are matched as text by the control protocols; keep them consistent
  with whatever your lighting desk or QLab-equivalent will send.
