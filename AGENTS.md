# AGENTS.md — bringing an LLM up to speed on SimpleCue

Orientation for an AI assistant (or a new human) picking this project up cold.

`CLAUDE.md` is the working reference — commands, architecture, and the specific rules that
bite. **Read it too.** This file gives you the mental model those rules protect, so you can
tell which ones are load-bearing and why.

---

## 1. What this is

A **platform-independent audio cue player** for theatre, live events and installation, built
in JUCE 8 / C++20 with CMake. Public repo. Released v0.3.1 for macOS universal, Windows
x64/arm64 and Linux x64/arm64.

The domain model in one paragraph: a **cue** is an audio file with in/out points, gain and
pre-wait. **Fades** shape its entry and exit. **Links** describe how one cue hands over to
the next — fire instantly, fire at the end, or crossfade. **Loops** repeat a section a set
number of times or forever. **Vamps** circle a section until the operator calls GO. GO walks
the cue's derived steps one at a time.

Phases 1 (engine/UI) and 2 (OSC/MIDI/MSC/MMC/Art-Net/sACN in and out) are complete. Phase 3
(streaming adapters) has not started.

## 2. The four ideas that explain most of the code

**Cue steps are derived, never stored.** `buildCueSteps()` expands a cue into the steps it
actually needs (Play always; Devamp only if it has a vamp; Fade/Stop always). Nothing
persists a sub-cue list. If you find yourself caching one, you are about to introduce a
staleness bug — an edit that removes a vamp must remove its Devamp step for free.

**Standby is a (cue, step) pair**, where step `cueHeaderStep` (-1) means the cue header
itself. `CueList::modify()` re-clamps standby after every edit, because an edit can delete
the very sub-cue standby was sitting on.

**Sequencing lives in the UI layer, not the engine.** `MainComponent::fireStandbyStep()` is
what GO does. The engine plays what it is told; it does not own the running order. This was
a deliberate move — don't push sequencing back down into `AudioEngine`.

**Everything is resampled to the device rate at load time.** That is what makes all loop and
vamp maths exact integer sample arithmetic rather than fractional drift. The cost is that
changing the audio device rate reloads every cue, which is correct and intended.

## 3. Layout

```
Source/Model     Cue, CueList, Show (.cueshow JSON), FadeCurve, CueStep,
                 StreamingSettings.  Message thread only.
Source/Audio     AudioEngine (device + voice pool + link scheduling),
                 CueVoice (one sounding instance),
                 SampleSource / SampleCache (decode + resample).
Source/Control   ControlHub (owns transports, schedules outgoing, publishes
                 status), OscControl, MidiControl, DmxControl.
                 DmxProtocol and the actionFor* mappings are pure functions.
Source/GUI       UI components.
Source/App       Command/menu target.
Tests/           EngineTests.cpp, ControlTests.cpp, e2e/ (real-socket scripts).
```

The internal C++ namespace is still `cp`, predating the rename from cue-player. **Leave it
alone** — renaming touches every file for no user-visible gain. Likewise, `Show.cpp` still
accepts the `cue-player-show` format string when loading; that is deliberate backward
compatibility for old show files, not a stale reference.

## 4. Real-time rules — these are not style preferences

- **The audio thread never allocates, never locks, and never touches a reference count.**
  Decoded audio is kept alive by a `shared_ptr` held on the *message* thread in
  `AudioEngine::records` for as long as the voice isn't idle; the voice itself holds a raw
  pointer. Handing the voice a `shared_ptr` would put a refcount on the audio thread.
- **A voice is claimed by `setSpec()` (state `reserved`) *before* its start command is
  queued.** Link scheduling runs synchronously immediately afterwards; without the early
  claim it would be handed the same voice twice.
- **Control input arrives on socket and MIDI threads and must never touch the show from
  there.** Every transport marshals to the message thread before calling
  `performControlAction`.
- **DMX triggers are edge-detected**, and the first frame after a reset only arms the
  detector. Level-triggering would re-fire a cue on every frame a lighting desk sends.
- **Cues are addressed by number everywhere except DMX**, which can only count and therefore
  uses list position (`ControlAction::cueIndex`).

## 5. How to verify changes — the part people get wrong

**Extend `Tests/EngineTests.cpp`. Do not verify playback by listening.**

The test stimulus is a **ramp whose sample values encode their own index**. That is the
whole trick: it makes "played the right region", "played the wrong region" and "looped one
sample early" three *different numbers* instead of three identical-sounding waveforms.

**Measure timing with a step, not a ramp.** JUCE's `WindowedSinc` interpolator has 100 input
samples of latency *and* about 1% passband gain error. On a ramp those two are
indistinguishable — you cannot tell a timing error from a gain error. (`SampleSource::load`
primes that latency away so resampled cues stay aligned with cues that already matched the
device rate. The gain error is the filter, not a bug.)

For the control layer, extend `Tests/ControlTests.cpp` and **build packets byte by byte**
rather than reusing the parser's own layout constants — otherwise a bug in the parser
cancels out against the matching bug in the test. `Tests/e2e/` holds two scripts that drive
a running app over real sockets; run them by hand after touching OSC or DMX.

## 6. Conventions

- **No non-ASCII characters in string literals.** JUCE's `String(const char*)` asserts on
  them and mangles the text. Em dashes are fine in comments, never in literals.
- macOS universal builds: set `CMAKE_OSX_ARCHITECTURES` **before** `project()` or you
  silently ship arm64-only. Verify with `lipo`/`file`, not the build log.
- CI builds macOS x86_64 by cross-compiling on `macos-14`; Intel runners are retired.
- Public repo — ships a user-facing AI-assisted disclaimer.

## 7. State of play

380 checks pass, including real-socket end-to-end runs, and CI is green on macOS, Linux and
Windows.

What that does **not** cover, and should not be claimed: **SimpleCue has never been run on a
live show.** No MIDI, lighting or streaming hardware has ever been connected to it, and only
the macOS/CoreAudio build has been exercised against real audio hardware. Phase 3 streaming
adapters are unstarted.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
