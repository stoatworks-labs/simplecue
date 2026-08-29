# Cross-platform checks

Two harnesses, answering two different questions.

**`selftest.html` — does the engine work here?** Runs the wasm engine and its
AudioWorklet and reports whether audio actually rendered. It deliberately does
not touch the React UI: the UI is ordinary DOM and is not what varies between
platforms. What varies is WebAssembly on a different CPU, AudioWorklet on a
different audio backend, and each engine's autoplay policy. It needs no
automation — the page runs itself and POSTs its result, so it works anywhere a
browser can be pointed at a URL.

**`drive-app.mjs` / `drive-app-webdriver.mjs` — is the app usable here?** Drives
the real application with *trusted* clicks: start the engine, open a show, load
audio, press GO, watch the play head move, hold a vamp. The CDP version drives
Chromium and Edge; the WebDriver version drives Safari. A real click matters
because it is what satisfies an autoplay policy, which a synthetic event does
not.

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

## Driving the whole app

The app is served from here and reached the same way. Chromium and Edge take a
second tunnel for the debugger:

```bash
npm run build --prefix webcue
node webcue/test-platform/server.mjs 8124 webcue/packages/app/dist &

# Linux, then drive it from this machine
ssh -R 8124:127.0.0.1:8124 -L 9222:127.0.0.1:9222 kdelab \
  "chromium --headless=new --no-sandbox --disable-gpu \
   --autoplay-policy=no-user-gesture-required \
   --remote-debugging-port=9222 --remote-allow-origins='*' \
   --user-data-dir=/tmp/wc-app about:blank & sleep 120"

node webcue/test-platform/drive-app.mjs 9222 http://localhost:8124/
```

Safari is local, so it needs no tunnel — but it does need **Allow Remote
Automation** ticked in Safari Settings, Developer tab, and `safaridriver
--enable` run once:

```bash
safaridriver -p 4444 &
node webcue/test-platform/drive-app-webdriver.mjs 4444 http://localhost:8124/
```

## What it found

Recorded on 2026-08-29, engine at 72,712 bytes. `results.example.json` is an
engine-check run.

### Engine

| Platform | Engine | Result | Context rate |
|---|---|---|---|
| macOS 15 | Chromium 148 | all passed | 48000 |
| macOS 15 | **Safari 26.4** | wasm + worklet passed, rendering needs a gesture | 48000 |
| Ubuntu 24.04 x86_64 | Chromium 151 | all passed | 48000 |
| Ubuntu 24.04 x86_64 | Firefox 154 (Gecko) | all passed | 48000 |
| Ubuntu 24.04 x86_64 | WebKitGTK 605.1.15 | wasm + worklet passed, rendering needs a gesture | 44100 |
| Windows 11 Pro x64 | Edge 151 | all passed | 44100 |

### The whole app, driven with real clicks

| Platform | Engine | Result |
|---|---|---|
| Ubuntu 24.04 x86_64 | Chromium 151 | 10 of 10 |
| Windows 11 Pro x64 | Edge 151 | 10 of 10 |
| macOS 15 | Safari 26.4 | not run — needs Allow Remote Automation |

Both app runs got all the way through: the engine started from a click, a show
opened, its audio loaded, GO fired a cue and moved standby past the Play step,
the play head advanced while it played, and a second cue vamped and held.

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

**The window is small in headless mode** — 780 px wide by default — and the
layout is tight there: the transport wraps and the cue list columns squeeze.
Nothing breaks, and a cue player is a desktop-width tool, but it is worth
knowing that nobody has looked at this below about 1000 px.

## What this does not cover

**Safari rendering, and the app in Safari.** The engine reaches every step short
of rendering, which needs a gesture the self-test cannot make. Finishing that
needs one manual toggle — Allow Remote Automation — after which
`drive-app-webdriver.mjs` runs the full app test with trusted clicks.

**iPadOS.** A plausible machine to run a show from, and completely untested.
Touch, the on-screen keyboard, and Safari's stricter memory limits are all
unknowns.

**Real audio hardware.** Every run here is on a virtual or headless audio
device. Nothing has been heard by anyone, on any platform, and the desktop app
carries the same caveat.

**Long shows.** The test audio is seconds long. Memory pressure at
~23 MB per stereo minute is untested anywhere.
