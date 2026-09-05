# webcue

A browser build of SimpleCue: cues, fades, links, loops and vamps, in a tab,
with nothing to install.

> **AI-assisted project.** This is part of [SimpleCue](../README.md) and was
> created with [Claude Code](https://claude.com/claude-code) (Anthropic),
> directed and reviewed by a human author. The playback engine is not a
> reimplementation — `Source/Audio/CueVoice.cpp` is compiled to WebAssembly
> unmodified, and a harness pushes identical scenarios through the native and
> wasm builds and compares them sample by sample. The sequencing above it is
> covered by 98 tests, and the `.cueshow` round trip is proven in both
> directions against the desktop app rather than against itself. The engine has
> been run and heard on macOS, and run on Linux, Windows, iPadOS and Android.
> It has **not** been run on a live show, no real iPad or Android handset has
> been used (both were simulators), and nobody has listened to it on Linux or
> Windows — those runs are headless and verified by counting rendered samples.

**[webcue.stoatworks-labs.com](https://webcue.stoatworks-labs.com)**

## What it is

`Source/Audio/CueVoice.cpp` — the part of SimpleCue that is verified sample by
sample — is compiled to WebAssembly **unmodified** and runs inside an
`AudioWorkletProcessor`. No fork, no `#ifdef`, no second implementation to keep
in step. The engine touches six JUCE names, which a ~200-line shim supplies.

What could not come across is everything above the audio thread: `AudioEngine`'s
link scheduling and `MainComponent`'s sequencing depend on JUCE classes that
cannot be compiled, and `Source/GUI/` is 4,753 lines that do not port at all. So
those are rebuilt in TypeScript and React, and tested.

Shows move between the two builds. A `.cueshow` written here opens on the
desktop with its free-text cue numbers, links, vamps, loops, routing and
relative audio paths intact, and one written there round-trips through here
losslessly.

## Building

```bash
./webcue/build.sh              # engine to wasm, plus the native/wasm parity checks
npm install --prefix webcue
npm test --prefix webcue       # 98 tests over @webcue/core
npm run build --prefix webcue  # the app, into packages/app/dist
```

`webcue/build.sh` is where the engine comes from; the npm build will not produce
it. See `test-platform/README.md` for running it on other machines.

## Layout

```
webcue/
  build.sh          engine -> wasm, and the checks that keep it honest
  shim/             the JUCE surface CueVoice needs, and nothing more
  engine/           the C boundary between CueVoice and the worklet
  packages/core/    isomorphic TS: model, .cueshow codec, sequencer. ALL the tests
  packages/engine/  browser-only: the wasm, the worklet, the VoiceHost
  packages/app/     React UI
  test-platform/    cross-platform and cross-browser harnesses
  wrangler.toml     Cloudflare Worker, static assets only
```

`packages/core` never imports `packages/engine`. That is what lets the
sequencer — the riskiest logic here — be tested without an `AudioContext`.

## What it cannot do

Named here rather than discovered later.

- **No OSC, Art-Net or sACN.** All three are UDP, and a browser cannot open a
  UDP socket. This is physics, not a to-do: it will not arrive in a later
  version. Those need the desktop app.
- **No MIDI, MSC or MMC yet.** Web MIDI could carry these in Chrome and Edge and
  is the obvious next phase. It does not exist in Safari.
- **Stereo, in practice.** The routing matrix works, but a browser gives you the
  default output device — almost always two channels — where the desktop
  addresses up to 64. A show routed beyond what the browser has would refuse to
  play every affected cue, so webcue asks on load whether to fold it.
- **No streaming cues.** They need a loopback input a browser cannot open.
- **No atomic save.** The desktop writes a temp file and moves it into place so
  a pulled USB stick cannot destroy a show. Chromium commits on close, which is
  close; the download fallback has no atomicity at all.
- **Memory is the real ceiling.** Audio is resident and decoded, about 23 MB per
  stereo minute. A long show in a tab is untested.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
