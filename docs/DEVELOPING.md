# Developing SimpleCue

Build, test and extension guide. For the mental models behind the code read
[`AGENTS.md`](../AGENTS.md); for the control protocols [`control.md`](control.md); for the
show file format [`API.md`](API.md).

---

## Building

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j8
./build/SimpleCueTests_artefacts/<config>/SimpleCueTests
```

JUCE 8 / C++20. CI is green on macOS, Linux and Windows.

**macOS universal builds:** `CMAKE_OSX_ARCHITECTURES` must be set **before** `project()`, or
you silently ship arm64-only while the build log reports success. Verify with `lipo`/`file`,
never the log. CI cross-compiles macOS x86_64 on `macos-14` — never `macos-13`, those runners
are retired.

---

## Layout

```
Source/Model     Cue, CueList, Show (.cueshow JSON), FadeCurve, CueStep,
                 StreamingSettings.  MESSAGE THREAD ONLY.
Source/Audio     AudioEngine (device + voice pool + link scheduling),
                 CueVoice (one sounding instance),
                 SampleSource / SampleCache (decode + resample to device rate)
Source/Control   ControlHub (owns transports, schedules outgoing, publishes
                 status), OscControl, MidiControl, DmxControl.
                 DmxProtocol and the actionFor* mappings are PURE FUNCTIONS.
Source/GUI       UI
Source/App       Command/menu target
Tests/           EngineTests.cpp, ControlTests.cpp, e2e/
```

The internal namespace is still `cp`, predating the rename from cue-player. **Leave it** —
renaming touches every file for no user-visible gain.

---

## Real-time rules — not style preferences

- **The audio thread never allocates, never locks, and never touches a reference count.**
  Decoded audio is kept alive by a `shared_ptr` held on the **message** thread in
  `AudioEngine::records` for as long as the voice isn't idle; the voice holds a raw pointer.
  Handing the voice a `shared_ptr` puts a refcount on the audio thread.
- **A voice is claimed by `setSpec()` (state `reserved`) *before* its start command is
  queued.** Link scheduling runs synchronously straight afterwards; without the early claim
  it gets handed the same voice twice.
- **Control input arrives on socket and MIDI threads and must never touch the show from
  there.** Every transport marshals to the message thread before calling
  `performControlAction`.

## Design invariants

- **Cue steps are derived by `buildCueSteps()`, never stored.** Caching them introduces
  staleness bugs — removing a vamp must remove its Devamp step for free.
- **Standby is a `(cue, step)` pair**, where step `cueHeaderStep` (-1) means the cue header.
  `CueList::modify()` re-clamps it after every edit, because an edit can delete the sub-cue
  standby was sitting on.
- **Sequencing lives in the UI layer.** `MainComponent::fireStandbyStep()` is what GO does;
  the engine doesn't own the running order. Don't push it back down.
- **Audio is resampled to the device rate at load time**, which is what makes all loop and
  vamp arithmetic exact integer samples. Changing device rate reloads every cue — correct and
  intended.
- **DMX triggers are edge-detected**, and the first frame after a reset only arms the
  detector. Level-triggering would re-fire on every frame a desk sends.
- **Cues are addressed by number everywhere except DMX**, which can only count and so uses
  list position (`ControlAction::cueIndex`).

---

## Verifying playback changes — read this properly

**Extend `Tests/EngineTests.cpp`. Do not verify by listening.**

The stimulus is a **ramp whose sample values encode their own index**. That is the entire
trick: it makes "played the right region", "played the wrong region" and "looped one sample
early" three *different numbers*, rather than three waveforms that sound identical.

**Measure timing with a step, not a ramp.** JUCE's `WindowedSinc` interpolator has **100
input samples of latency** *and* about **1% passband gain error**. On a ramp those two are
indistinguishable — you cannot tell a timing error from a gain error. (`SampleSource::load`
primes the latency away so resampled cues stay aligned with cues already at the device rate.
The gain error is the filter, not a bug.)

## Verifying control changes

Extend `Tests/ControlTests.cpp`, and **build packets byte by byte rather than reusing the
parser's own layout constants**. Sharing constants lets a bug in the parser cancel out
against the identical bug in the test.

`DmxProtocol` and the `actionFor*` mappings are deliberately **pure functions**, so the
entire mapping layer is testable without opening a socket. Keep new mapping logic pure.

`Tests/e2e/` holds two scripts that drive a running app over **real sockets**. Run them by
hand after changing OSC or DMX — that is what makes the 404-check figure meaningful.

---

## Adding things

### A control protocol
Add a transport in `Source/Control`, owned by `ControlHub`. Keep the wire parsing and the
action mapping as pure functions so they're testable without sockets, and marshal to the
message thread before touching the show. Document it in [`control.md`](control.md).

### A cue property
Add it to `Cue`, serialise it in `Cue.cpp`, and document the key in [`API.md`](API.md). If it
affects which steps a cue has, that belongs in `buildCueSteps()` — not in stored state.

**Bump `showFormatVersion` only for a breaking change.** Loading refuses files with a version
newer than the build, so bumping it makes every older build reject shows containing your new
field. Additive fields that older builds can ignore don't need a bump.

---

## Conventions

- **No non-ASCII characters in string literals.** JUCE's `String(const char*)` asserts on
  them and mangles text. Em dashes are fine in comments, never in literals.
- Public repo, ships a user-facing AI-assisted disclaimer.
- "Commit" means commit **and** push.

## Status

Phases 1 (engine/UI) and 2 (control protocols) complete; **Phase 3 (streaming adapters) not
started**. Never run on a live show; no control hardware has ever been connected.
