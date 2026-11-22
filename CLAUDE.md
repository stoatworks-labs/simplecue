# simplecue (SimpleCue)

Platform-independent audio cue player for theatre and live events. Cues (audio files with
in/out points), fades, links (cue-to-cue transitions), loops and vamps. JUCE 8 / C++20,
CMake. Public repo. Phases 1 (engine/UI) and 2 (control protocols) complete; Phase 3
(streaming adapters) not started.

## Commands
- Configure: `cmake -B build -DCMAKE_BUILD_TYPE=Release`
- Build: `cmake --build build -j8`
- Tests: `./build/SimpleCueTests_artefacts/<config>/SimpleCueTests`
- Diagnostics bundle: `SimpleCue --collect-diagnostics` (or Help -> Collect Diagnostics...)
- See a crash report: build target `SimpleCueDiagCrash`, run it with `segv` or `exception`

The internal C++ namespace is still `cp`. It predates the rename to SimpleCue and is left
alone deliberately: renaming it touches every file for no user-visible gain.

## Logging
Log via the `CP_LOG_*` macros from `Source/Diag/Diag.h`, never `DBG` or `std::cout`. Lines go to a rotating daily file *and* an in-memory ring that gets embedded in a crash report; every line is flushed as written, because buffered output dies with the process. Crashes are caught two ways (native signal handler + `unhandledException`). **A plugin must pass `installCrashHandler = false`** - it lives in the host's process. See docs/diagnostics.md.

## Architecture
- `Source/Model` — `Cue`, `CueList`, `Show` (JSON `.cueshow`), `FadeCurve`, `CueStep`,
  `StreamingSettings`. Message thread only.
- `Source/Audio` — `AudioEngine` (device + voice pool + link scheduling), `CueVoice` (one
  sounding instance), `SampleSource`/`SampleCache` (decode + resample to device rate).
- `Source/Control` — `ControlHub` (owns the transports, schedules outgoing messages,
  publishes status), `OscControl`, `MidiControl`, `DmxControl`. `DmxProtocol` and the
  `actionFor*` mappings are pure functions so they can be tested without sockets.
- `Source/GUI`, `Source/App` — UI and the command/menu target.

## Rules that matter here
- **The audio thread never allocates, locks, or touches a reference count.** Decoded audio is
  kept alive by a `shared_ptr` held on the message thread in `AudioEngine::records` for as
  long as the voice is not idle; the voice holds a raw pointer.
- A voice is claimed by `setSpec()` (state `reserved`) *before* its start command is queued.
  Without that, link scheduling — which runs synchronously right after — would be handed the
  same voice twice.
- Audio is resampled to the device rate **at load time**, so all loop/vamp maths is exact
  integer sample arithmetic. Changing the device rate reloads every cue.
- JUCE's `WindowedSinc` interpolator has 100 input samples of latency; `SampleSource::load`
  primes it away so resampled cues stay aligned with cues that already matched the rate.
  It also has ~1% passband gain error — that is the filter, not a bug.
- **No non-ASCII characters in string literals.** JUCE's `String(const char*)` asserts on
  them and mangles the text. Em dashes in comments are fine; in literals they are not.

## Cue lifecycles
- A cue's sub-cues are **derived** by `buildCueSteps()`, never stored. Play cue always;
  Devamp only when the cue has a vamp; Fade/Stop always.
- Standby is a **(cue, step)** pair where step `cueHeaderStep` (-1) means the cue itself.
  `CueList::modify()` re-clamps it, because an edit can remove the sub-cue standby sits on.
- `Cue::firePlayWithCue` decides whether firing the cue also plays it. When on, standby
  skips the Play sub-cue after the header, so the same audio is never offered twice.
- `MainComponent::fireStandbyStep()` is what GO does — the engine no longer owns sequencing.

## Rules for the control layer
- Incoming control arrives on socket/MIDI threads. **Never touch the show from those** —
  every transport marshals to the message thread before calling `performControlAction`.
- DMX triggers are edge-detected, and the first frame after a reset only arms the detector.
  Level-triggering would fire a cue on every frame a desk sends.
- Cues are addressed by **number** everywhere except DMX, which can only count and so uses
  list position (`ControlAction::cueIndex`).

## Verifying playback changes
Extend `Tests/EngineTests.cpp` rather than listening. The stimulus is a ramp whose sample
values encode their own index, so "played the right region", "played the wrong region" and
"looped a sample early" are three different numbers instead of three identical waveforms.
Measure timing with a step, not a ramp — the interpolator's gain error and its delay are
indistinguishable on a ramp.

For the control layer, extend `Tests/ControlTests.cpp`. Build packets byte by byte rather
than reusing the parser's own layout, so a bug in the parser cannot cancel out against a
matching bug in the test. `Tests/e2e/` holds two scripts that drive a running app over real
sockets; run them by hand after changing OSC or DMX.

For how the cue list looks, extend `Tests/CueListTests.cpp`: it paints the real
`CueListComponent` into an image and reads the rows back as pixels. The cue list's highlight
follows the show's selected cue (`CueList::getSelectedIndex`), never the table's own row
number, which drifts whenever the standby cue's steps open or close.
