# Cross-platform engine check

Runs the wasm engine and its AudioWorklet in a real browser on another machine
and reports whether audio actually rendered. It deliberately does not touch the
React UI: the UI is ordinary DOM and is not what varies between platforms. What
varies is WebAssembly on a different CPU, AudioWorklet on a different audio
backend, and each engine's autoplay policy.

## Running it

The engine assets have to be beside the harness first:

```bash
./webcue/build.sh engine
cp webcue/web/webcue-engine.wasm webcue/packages/engine/worklet/webcue-processor.js webcue/test-platform/
node webcue/test-platform/server.mjs 8123
```

Then, for each machine, open a browser at `http://localhost:8123/` **through an
SSH reverse tunnel**:

```bash
ssh -R 8123:127.0.0.1:8123 kdelab "timeout 40 chromium --headless=new --no-sandbox --disable-gpu --autoplay-policy=no-user-gesture-required --user-data-dir=/tmp/wc-chr http://localhost:8123/"
ssh -R 8123:127.0.0.1:8123 kdelab "timeout 45 firefox --headless --profile ~/webcue-ff http://localhost:8123/"
ssh -R 8123:127.0.0.1:8123 kdelab "timeout 55 xvfb-run -a epiphany-browser --profile=/home/lab/webcue-epi http://localhost:8123/"
```

Results accumulate in `results.json` beside the server, and the server logs each
request, which is how you tell "the page never loaded" from "the page loaded and
failed".

**The reverse tunnel is the point, not a convenience.** AudioWorklet needs a
secure context, and a plain-http origin on another machine is not one —
`http://localhost` is. Tunnelling makes the host's server look like localhost to
the guest, so nothing has to be installed in any VM: no node, no web server, no
copy of the build.

Firefox needs a profile that permits autoplay, or its context stays suspended:

```
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
```

## What it found

Recorded on 2026-08-29, engine at 72,712 bytes. `results.example.json` is that run.

| Platform | Engine | Result | Context rate |
|---|---|---|---|
| macOS 15 | Chromium 148 | all passed | 48000 |
| Ubuntu 24.04 x86_64 | Chromium 151 | all passed | 48000 |
| Ubuntu 24.04 x86_64 | Firefox 154 (Gecko) | all passed | 48000 |
| Ubuntu 24.04 x86_64 | WebKitGTK 605.1.15 | wasm + worklet passed, rendering skipped | 44100 |
| Windows 11 Pro x64 | Edge 151 | all passed | 44100 |

Two findings worth keeping.

**WebKit leaves `AudioContext.resume()` pending forever when there has been no
user gesture.** It does not reject and it does not resolve. An unguarded `await
ctx.resume()` therefore hangs the whole page — which is exactly what happened to
the first version of this harness, and why it reported nothing at all rather
than reporting a failure. The app is already correct here, because it starts its
engine from a button, but anything that starts a context on load will simply
stop dead on Safari with no error to find. The harness now races the resume
against a timeout and says so.

**The context sample rate is not always 48 kHz.** Windows Edge and WebKitGTK both
came up at 44100 on these machines. Nothing depends on 48 kHz — audio is
resampled to the context rate when it is decoded, which is the browser's
equivalent of the desktop app resampling at load — but any code that assumes
48000 would be wrong on two of the five configurations tested here.

## What this does not cover

**Safari itself.** WebKitGTK is the same engine core, so it catches engine-level
problems, but it is a different platform with a different audio backend and it
is not what anyone will actually run. Real Safari on macOS and on iPadOS remains
untested.

**The UI.** Nothing here clicks a button, opens a show or drags a marker. It
proves the engine runs; it does not prove the app is usable on that machine.
