# webcue — feasibility spike

Can SimpleCue's playback engine run in a browser? Yes. This directory is the
proof, not the product.

`Source/Audio/CueVoice.cpp` — the part that is verified sample by sample — is
compiled to WebAssembly **unmodified** and runs inside an `AudioWorkletProcessor`.
No fork, no `#ifdef`, no reimplementation in TypeScript.

```bash
./webcue/build.sh          # build the engine, run every check
```

Then serve `webcue/web/` and open it. The demo fires cues that fade, loop, vamp
and take a sample-accurate scheduled stop, driven by the real engine.

## What was actually established

**CueVoice needs six JUCE names.** `jmin`, `jmax`, `jlimit`,
`isPositiveAndBelow`, `int64`, `AudioBuffer` — plus `HeapBlock` in the header.
`shim/juce_core` and `shim/juce_audio_basics` supply them in about 200 lines.
Nothing in the shim reimplements JUCE *behaviour*; it only supplies the names.

**The audio-thread types are already separable from the model.**
`shim/Model/Cue.h` is 40 lines — `RoutePoint`, `VampRelease` and the `limits`
ceilings — and that is genuinely all `VoiceSpec` takes from the 300-line real
`Cue.h`. The rest of `Cue.h` (juce::File, juce::var persistence, ControlMessage,
StreamingRef) is message-thread only. See "upstream change worth making" below.

**`FadeShape` is not shimmed.** `Model/FadeCurve.h` resolves to the real header
and `FadeCurve.cpp` is compiled in, so the five curve shapes are the shipping
ones.

**Four of the five fade curves are bit-identical** between the native and wasm
builds. Only `equalPower` differs, and it is the only curve that calls
`std::sin` — Apple's libm and Emscripten's disagree by ≤2 ulp. Everything else
is add/multiply, which wasm does bit-exactly.

**Across the whole voice, 116 of 389,250 rendered samples differ, max 2 ulp**
(~2.4e-4 absolute on a signal ranging to ±24000; the gain coefficient itself is
off by ~1e-7 relative, about -140 dB). Every difference traces to that one
`sin`. The state machine — loop wraps, vamp boundaries, pre-wait, scheduled
stops, pause, routing, the action envelope — is bit-identical.

That difference is not new to wasm: the same `sin` divergence exists in
principle between the macOS, Windows and Linux native builds, which use three
different libms. I did not measure those here, so treat that as the expected
consequence rather than a measured one. If bit-exactness across platforms is
ever wanted for testing, replacing `std::sin` in `evaluateFadeIn` with a fixed
polynomial would deliver it; nothing audible depends on it.

**`-ffp-contract=off` is required for the comparison to mean anything.**
Without it the host compiler fuses the envelope multiply-add into an FMA that
wasm has no instruction for, and the parity check reports the compiler's
differences rather than the port's.

**The wasm is 71 KB with no Emscripten JS glue.** Built `-sSTANDALONE_WASM`, it
imports four functions — `emscripten_notify_memory_growth` and three
`wasi_snapshot_preview1` stdio stubs the engine never calls. The worklet
supplies them as no-ops and instantiates the bytes directly. This matters
because `AudioWorkletGlobalScope` has no `fetch`: the main thread passes the
bytes through `processorOptions`.

**No `SharedArrayBuffer`, so no COOP/COEP headers.** Commands cross to the audio
thread via the worklet port and are drained at the top of `process()` — the same
order as the desktop callback (`drainCommands`, then render). The sample-accurate
paths are counted in samples *inside* the worklet, so message jitter does not
reach them: the demo's scheduled stop lands on sounded sample 144000 exactly.
This keeps plain static hosting (GitHub Pages) viable.

**The 128-frame render quantum is the block size**, so the parity harness runs
the same block structure the browser imposes.

## Verified in a real browser

Loaded 8 s of audio, then: a vamp circling 2–4 s (position wrapping 3.728 → 2.725 s,
vamp passes climbing while play passes stayed 0), released at end of pass
(state VAMP → playing, position running on past 4 s), and a stop armed at
sounded sample 144000 firing at 3.019 s — 19 ms into a 1.5 s fade, i.e. within
one 128-frame quantum of exact. Voices recycled cleanly. No console errors.

## What this spike did *not* touch

- **`.cueshow` loading.** The format is already JSON and parses in TS directly;
  nothing here reads one yet.
- **Multichannel output.** The engine renders `numOutputs` channels and the
  routing matrix works, but the demo asks for stereo. Browsers do not reliably
  give more, so the crosspoint matrix is the feature most at risk.
- **The control layer.** OSC, Art-Net and sACN are UDP and cannot cross into a
  browser without a relay. Web MIDI would survive in Chrome/Edge. Untested here.
- **Disk streaming.** Everything is memory-resident, as on the desktop —
  ~23 MB per stereo minute at 48 kHz.
- **Latency and glitch behaviour under load.** The demo ran clean at 5.3 ms base
  latency, but nothing here stress-tests it.

## Upstream change worth making

`shim/Model/Cue.h` should become `Source/Model/CueTypes.h`, holding `RoutePoint`,
`VampRelease` and `limits`, included by both the real `Cue.h` and `CueVoice.h`.
That is a small, self-contained tidy that benefits the desktop build on its own
merits — the audio-thread header would stop pulling in file paths, `juce::var`
persistence and streaming settings it has no business seeing — and it removes
the only genuinely shim-shaped file here.

The juce_core / juce_audio_basics shims stay shims: they exist to let a
browser build reuse the engine, and nothing on the desktop side wants them.

## Layout

```
webcue/
  shim/          the JUCE and model surface CueVoice needs, and nothing more
  engine/        the C boundary between CueVoice and the worklet
  web/           the AudioWorklet processor and a demo page
  test/          parity harness, curve isolation, struct-offset check
  build.sh
```
