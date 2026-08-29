// Drives the real webcue app in a browser on another machine and checks it is
// actually usable there — not just that the engine loads.
//
// The engine self-test answers "does WebAssembly and AudioWorklet work on this
// platform". This answers a different question: can someone open a show, press
// GO, and have a cue play. It clicks with real input events rather than
// dispatching synthetic ones, so the browser's autoplay policy is satisfied the
// same way an operator would satisfy it.
//
// Two tunnels are in play, and both are needed:
//   ssh -R <appPort>  so the guest can reach the app served from here
//   ssh -L 9222       so this script can reach the guest's debugger
//
// Usage: node drive-app.mjs [cdpPort] [appUrl]

const cdpPort = Number(process.argv[2] ?? 9222);
const appUrl = process.argv[3] ?? 'http://localhost:8124/';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  return res.json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30_000);
    });
  }

  /** Returns the evaluated value, unwrapping CDP's envelope. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw');
    }

    return r.result.value;
  }

  /** A real trusted click, which is what an autoplay policy wants to see. */
  async clickAt(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1,
      });
    }
  }

  async clickText(text) {
    const box = await this.evaluate(`
      (() => {
        const el = [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);

    if (!box) throw new Error(`no button starting with ${JSON.stringify(text)}`);
    await this.clickAt(box.x, box.y);
  }
}

const targets = await cdpTargets();
const page = targets.find((t) => t.type === 'page');

if (!page) {
  console.error('no page target on the debugger; is the browser running?');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

const s = new Session(ws);
await s.send('Page.enable');
await s.send('Runtime.enable');

await s.send('Page.navigate', { url: appUrl });
await sleep(3000);

const title = await s.evaluate('document.title');
check('app loaded', title === 'webcue', `title=${title}`);

const version = await s.evaluate("document.querySelector('.titlebar h1')?.textContent?.trim()");
check('app rendered', !!version, version ?? 'no titlebar');

// A real click, so the AudioContext starts the way it does for an operator.
await s.clickText('Start audio');
await sleep(2500);

const engineLine = await s.evaluate("document.querySelector('.statusbar span')?.textContent?.trim()");
const running = await s.evaluate("!document.querySelector('.start-strip')");
check('engine started from a click', running, engineLine ?? '');

// Load a show and its audio through the app's own file inputs.
const setup = await s.evaluate(`
  (async () => {
    function wav(seconds, freq, rate, channels = 2) {
      const frames = Math.round(seconds * rate);
      const bytes = frames * channels * 2;
      const buf = new ArrayBuffer(44 + bytes);
      const v = new DataView(buf);
      const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      s(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); s(8, 'WAVE');
      s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, channels, true); v.setUint32(24, rate, true);
      v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true);
      v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, bytes, true);
      let o = 44;
      for (let i = 0; i < frames; i++) {
        const val = Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 0.3 * 32767);
        for (let c = 0; c < channels; c++) v.setInt16(o + c * 2, val, true);
        o += channels * 2;
      }
      return buf;
    }

    const rate = 48000;
    const cue = (o) => Object.assign({
      id: crypto.randomUUID(), type: 'audioFile', number: '', name: '', notes: '',
      audioFile: '', fileDuration: 0, fileChannels: 2, fileSampleRate: rate,
      startTime: 0, endTime: 0, gainDb: 0, preWait: 0,
      fadeInTime: 0, fadeInShape: 'equalPower', fadeOutTime: 0, fadeOutShape: 'equalPower',
      loopEnabled: false, loopCount: 0,
      vampEnabled: false, vampStart: 0, vampEnd: 0, vampRelease: 'atEndOfPass',
      endAction: 'fadeOut', endFadeTime: 3, firePlayWithCue: true,
      link: { mode: 'none', target: '', delay: 0, duration: 3, shape: 'equalPower' },
      outputMessages: [], routing: [],
    }, o);

    const cues = [
      cue({ number: '1', name: 'Opening', audioFile: 'one.wav', fileDuration: 6, endTime: 6, fadeInTime: 1 }),
      cue({ number: '2', name: 'Scene change', audioFile: 'two.wav', fileDuration: 8, endTime: 8,
            vampEnabled: true, vampStart: 2, vampEnd: 4 }),
    ];

    const show = { format: 'simplecue-show', version: 1, masterGainDb: 0,
      defaultFadeInTime: 0, defaultFadeOutTime: 0, defaultFadeShape: 'equalPower', cues };

    const inputs = [...document.querySelectorAll('input[type=file]')];
    const feed = (input, files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    feed(inputs[0], [new File([JSON.stringify(show)], 'Platform test.cueshow', { type: 'application/json' })]);
    await new Promise((r) => setTimeout(r, 500));
    feed(inputs[1], [
      new File([wav(6, 220, rate)], 'one.wav', { type: 'audio/wav' }),
      new File([wav(8, 330, rate)], 'two.wav', { type: 'audio/wav' }),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    return {
      cues: document.querySelectorAll('tr.cue-row').length,
      missing: document.querySelector('.warning-strip')?.textContent?.trim() ?? null,
    };
  })()
`);

check('show opened', setup.cues === 2, `${setup.cues} cue rows`);
check('audio loaded', setup.missing === null, setup.missing ?? 'all present');

// GO, with a real click on the real button.
await s.clickText('GO');
await sleep(1200);

const afterGo = await s.evaluate(`
  ({
    running: document.querySelectorAll('.active-row').length,
    badge: document.querySelector('.badge')?.textContent ?? null,
    elapsed: document.querySelector('.active-times')?.textContent?.trim() ?? null,
    standby: document.querySelector('.standby-readout')?.textContent?.trim() ?? null,
  })
`);

check('GO started a cue', afterGo.running > 0, `badge=${afterGo.badge}, ${afterGo.elapsed}`);
check('standby advanced past Play', /Fade\/Stop/.test(afterGo.standby ?? ''), afterGo.standby ?? '');

// Let it run, then confirm the play head actually moved: proof the audio thread
// is running on this machine, through the whole app rather than a test page.
await sleep(1500);
const later = await s.evaluate("document.querySelector('.active-times')?.textContent?.trim() ?? ''");
check('play head advanced', later !== afterGo.elapsed, `${afterGo.elapsed} -> ${later}`);

// The vamp: fire cue 2 and confirm it holds.
await s.evaluate(`
  [...document.querySelectorAll('tr.cue-row')]
    .find((r) => r.textContent.includes('Scene change'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
`);
await s.clickText('GO');
await sleep(3500);

const vamp = await s.evaluate(`
  ({
    vamping: [...document.querySelectorAll('.active-state')].map((e) => e.textContent).join(','),
    badges: [...document.querySelectorAll('.badge')].map((e) => e.textContent).join(','),
  })
`);

check('cue vamped and held', /VAMP/.test(vamp.vamping + vamp.badges), `${vamp.badges}`);

const shot = await s.send('Page.captureScreenshot', { format: 'png' });
check('screenshot captured', !!shot.data, `${Math.round(shot.data.length * 0.75 / 1024)} KB`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n----- ${failed} failed of ${results.length} -----`);

const ua = await s.evaluate('navigator.userAgent');
console.log(ua);

if (process.env.SHOT_PATH && shot.data) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.SHOT_PATH, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot written to ${process.env.SHOT_PATH}`);
}

ws.close();
process.exit(failed === 0 ? 0 : 1);
