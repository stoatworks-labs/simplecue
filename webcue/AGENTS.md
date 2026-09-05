# webcue — the mental model

Commands are in [README.md](README.md). This is the *why*, so you can tell which
rules are load-bearing.

## 1. The one fact everything follows from

There are two layers, split along the thread boundary the C++ already draws.

**Below the line** is `Source/Audio/CueVoice.cpp`, compiled to WebAssembly
**unmodified** and run inside an `AudioWorkletProcessor`. Loop wraps, vamp
boundaries, fades, scheduled stops, routing, the action envelope. It is not
ported, translated or reimplemented — it is the same file the desktop compiles,
and `build.sh verify` proves the two builds agree sample by sample.

**Above the line** is everything else: which cue, which voice, what follows it.
That is `AudioEngine`'s bookkeeping and `MainComponent`'s sequencing, rewritten
in TypeScript because they depend on JUCE classes that cannot be compiled.

Everything risky lives above the line. That is where the tests are.

## 2. Load-bearing rules

**`packages/core` must never import `packages/engine`.** Core defines the
`VoiceHost` interface; engine implements it. That inversion is the only reason
the sequencer can be driven by a fake with a sample clock instead of an
`AudioContext`, and it is what makes the link tests possible at all.

**There are two clocks, and they are one line apart.** A link target's offset is
measured from GO and **includes** the pre-wait. A `scheduleStop` offset is
measured from the voice's first *sounding* sample, **excludes** it, and is not
reset by loops. Swap them and every crossfade in a show with a pre-wait is late
by exactly the pre-wait — which sounds like a slightly different performance,
not like a bug. `links.test.ts` has a test named for this.

**Voice allocation is the main thread's, never the worklet's.** `scheduleLink`
recurses synchronously and must know a slot before it can name the next cue's
parent — the same reason `CueVoice` has a `reserved` state. The worklet is an
executor: every command names its slot and carries a generation.

**A finish must be reported before it is recycled.** A voice goes
`finished → idle` inside one render quantum, so anything that merely recycled
would leave nobody able to observe a finish — and an open-ended auto-follow
fires exactly when its source finishes. `wc_drain_finished` does both halves in
the right order. An early version did not, and every such follow would silently
never have fired.

**The codec preserves keys it does not know.** The desktop refuses to open a
show from a newer version; a browser tab that silently ate its fields would be
worse, because the operator finds out when the show runs differently. Paths stay
opaque for the same reason — a Windows-authored show holds `audio\cue1.wav`, and
normalising it would stop the file opening on the machine that wrote it.

**Never fold routing silently.** `effectiveRouting` drops routes to channels
that do not exist and `buildSpec` then refuses a cue with none left, so a show
authored for eight outputs does not degrade in a stereo tab — it refuses, cue by
cue. Folding without asking would make webcue quietly disagree with the desktop
about what the show sounds like, which is worse than refusing. Hence the prompt
on load.

## 3. Traps that have actually bitten

**`height: 100vh` is wrong on iOS Safari.** It is the viewport with the browser
chrome ignored, so the app is taller than what you can see and scrolls — the
title bar goes off the top and the status bar below the fold. On a cue player
GO can leave the screen mid-show. Use `100dvh`.

**`AudioContext.resume()` never settles on WebKit without a gesture.** It does
not reject. An unguarded `await` hangs the whole page, with no error to find.
The app is fine because it starts from a button; anything that starts a context
on load is not.

**`-ffp-contract=off` or the parity check is meaningless.** Without it the host
compiler fuses the envelope multiply-add into an FMA that wasm has no
instruction for, and the comparison reports the compiler's differences as the
port's.

**Clicking a disabled button is silent** in both WebDriver and CDP — no error,
no event — so a test that does it fails somewhere unrelated. The platform
drivers wait for a button to be enabled, and verify the click's *effect*.

**The context sample rate is not always 48 kHz.** Windows Edge and WebKitGTK
both came up at 44100. Nothing depends on it, but code that assumes 48000 is
wrong on two of the configurations tested.

## 4. Verified vs assumed

**Verified.** Native/wasm engine parity, sample by sample. 98 tests over the
model, codec, standby, links, cancellation and the sequencer. The engine running
and rendering audio on macOS, Linux, Windows, iPadOS and Android across Blink,
Gecko, WebKit and Chrome-on-Android. The whole app driven with trusted clicks on
Linux, Windows and Safari. `.cueshow` round trip in both directions against the
real desktop app.

**Assumed.** That it behaves on a long show — the largest thing tested is
seconds of audio, against a ceiling of roughly 23 MB per stereo minute resident.
That simulators represent real devices; no physical iPad or Android handset has
run it. That headless runs on virtual audio devices sound like anything — only
macOS has been listened to by a human. And, as with the desktop app, it has
never been near a live show.

## Notes

`docs/NOTES.md` carries this repo's working notes. Cross-cutting fleet knowledge
lives in [fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
