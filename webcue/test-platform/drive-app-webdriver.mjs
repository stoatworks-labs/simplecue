// The same app run as drive-app.mjs, but over W3C WebDriver instead of CDP, so
// it can drive Safari.
//
// Safari matters more than its market share suggests here: it is the one engine
// where AudioContext.resume() hangs rather than rejects without a user gesture,
// and it is the only way to reach iPadOS, which is a plausible machine to run a
// show from. A WebDriver click is a TRUSTED gesture, so unlike the headless
// self-test this can get all the way to audio actually rendering.
//
//   safaridriver -p 4444 &
//   node drive-app-webdriver.mjs 4444 http://localhost:8124/
//
// Safari needs "Allow Remote Automation" enabled in its Develop menu, and
// safaridriver --enable run once with admin rights.

const port = Number(process.argv[2] ?? 4444);
const appUrl = process.argv[3] ?? 'http://localhost:8124/';
const base = `http://127.0.0.1:${port}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = await res.json();

  if (!res.ok || json.value?.error) {
    throw new Error(`${method} ${path}: ${json.value?.message ?? res.status}`);
  }

  return json.value;
}

const session = await call('POST', '/session', {
  capabilities: { alwaysMatch: {} },
});

const sid = session.sessionId;
const at = (p) => `/session/${sid}${p}`;

const cleanUp = async () => {
  try {
    await call('DELETE', at(''));
  } catch {
    // The window may already be gone.
  }
};

process.on('uncaughtException', async (e) => {
  console.error('ERROR:', e.message);
  await cleanUp();
  process.exit(2);
});

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** Synchronous JS. Returns the value, or a web-element reference. */
const exec = (script, args = []) => call('POST', at('/execute/sync'), { script, args });

/** Async JS: the script gets a callback as its final argument. */
const execAsync = (script, args = []) =>
  call('POST', at('/execute/async'), { script, args });

/** Waits for a button to exist AND be enabled before clicking it.

    Clicking a disabled button is silent in WebDriver: no error, no event, and
    the test then fails somewhere unrelated. GO is disabled until the show has
    loaded and standby has a cue, so clicking it the instant the file input
    settles is a race — one that Safari lost and Chromium happened to win. */
async function clickButton(text, timeoutMs = 8000) {
  const started = Date.now();

  for (;;) {
    const el = await exec(
      `const b = [...document.querySelectorAll('button')]
         .find((x) => x.textContent.trim().startsWith(arguments[0]));
       return b && !b.disabled ? b : null;`,
      [text],
    );

    if (el && el[ELEMENT_KEY]) {
      // A real WebDriver click, which the autoplay policy accepts as a gesture.
      await call('POST', at(`/element/${el[ELEMENT_KEY]}/click`), {});
      return;
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`button "${text}" never became enabled`);
    }

    await sleep(200);
  }
}

await call('POST', at('/timeouts'), { script: 30000 });

// Size the window like a laptop. Safari's automation window opens small enough
// to trip webcue's narrow layout, which is not what a desktop user sees — and
// testing the phone layout by accident tells you nothing about either.
try {
  await call('POST', at('/window/rect'), { x: 40, y: 40, width: 1440, height: 900 });
} catch {
  // Not fatal; some drivers refuse to move a window.
}

// Bring it to the front. A background window can drop synthetic input in
// Safari, which is the other candidate for a click that lands nowhere.
try {
  await call('POST', at('/window/maximize'), {});
} catch {
  // Equally optional.
}

await call('POST', at('/url'), { url: appUrl });
await sleep(2500);

const title = await exec('return document.title;');
check('app loaded', title === 'webcue', `title=${title}`);

const version = await exec("return document.querySelector('.titlebar h1')?.textContent?.trim();");
check('app rendered', !!version, version ?? 'no titlebar');

/** Clicks, then waits for the click to have DONE something, retrying if not.

    Safari's automation window does not always have focus when it is first
    driven, and a click into an unfocused window can be dropped silently. That
    is indistinguishable from a click that landed on a button which did nothing,
    so the only reliable test is the effect, not the click. */
async function clickUntil(text, conditionScript, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    await clickButton(text);

    for (let waited = 0; waited < 3000; waited += 250) {
      await sleep(250);
      if (await exec(`return ${conditionScript};`)) return true;
    }
  }

  return false;
}

const started = await clickUntil('Start audio', "!document.querySelector('.start-strip')");
const ctxNote = await exec("return document.querySelector('.statusbar span')?.textContent?.trim();");
check('engine started from a click', started, ctxNote ?? '');

const setup = await execAsync(`
  const done = arguments[arguments.length - 1];

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
    cue({ number: '1', name: 'Opening', audioFile: 'one.wav', fileDuration: 14, endTime: 14, fadeInTime: 1 }),
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

  setTimeout(() => {
    feed(inputs[1], [
      new File([wav(14, 220, rate)], 'one.wav', { type: 'audio/wav' }),
      new File([wav(8, 330, rate)], 'two.wav', { type: 'audio/wav' }),
    ]);

    setTimeout(() => done({
      cues: document.querySelectorAll('tr.cue-row').length,
      missing: document.querySelector('.warning-strip')?.textContent?.trim() ?? null,
    }), 2000);
  }, 600);
`);

check('show opened', setup.cues === 2, `${setup.cues} cue rows`);
check('audio loaded', setup.missing === null, setup.missing ?? 'all present');

await clickUntil('GO', "document.querySelectorAll('.active-row').length > 0");
await sleep(1400);

const afterGo = await exec(`
  return {
    running: document.querySelectorAll('.active-row').length,
    badge: document.querySelector('.badge')?.textContent ?? null,
    elapsed: document.querySelector('.active-times')?.textContent?.trim() ?? null,
    standby: document.querySelector('.standby-readout')?.textContent?.trim() ?? null,
  };
`);

check('GO started a cue', afterGo.running > 0, `badge=${afterGo.badge}, ${afterGo.elapsed}`);
check('standby advanced past Play', /Fade\/Stop/.test(afterGo.standby ?? ''), afterGo.standby ?? '');

await sleep(1600);
const later = await exec("return document.querySelector('.active-times')?.textContent?.trim() ?? '';");

// Must still be RUNNING and showing a different time. An empty string would
// mean the row vanished, which happens when the cue ends -- and would also
// happen if the app fell over, so it must not count as progress.
check('play head advanced', later !== '' && later !== afterGo.elapsed,
  `${afterGo.elapsed} -> ${later || '(row gone)'}`);

await exec(`
  [...document.querySelectorAll('tr.cue-row')]
    .find((r) => r.textContent.includes('Scene change'))
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
`);

await clickButton('GO');
await sleep(3500);

const vamp = await exec(`
  return {
    states: [...document.querySelectorAll('.active-state')].map((e) => e.textContent).join(','),
    badges: [...document.querySelectorAll('.badge')].map((e) => e.textContent).join(','),
  };
`);

check('cue vamped and held', /VAMP/.test(vamp.states + vamp.badges), vamp.badges);

const shot = await call('GET', at('/screenshot'));
check('screenshot captured', !!shot, `${Math.round((shot?.length ?? 0) * 0.75 / 1024)} KB`);

const ua = await exec('return navigator.userAgent;');
const rate = await exec("return document.querySelector('.statusbar span')?.textContent ?? '';");

const failed = results.filter((r) => !r.ok).length;
console.log(`\n----- ${failed} failed of ${results.length} -----`);
console.log(ua);
console.log(rate);

if (process.env.SHOT_PATH && shot) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.SHOT_PATH, Buffer.from(shot, 'base64'));
  console.log(`screenshot written to ${process.env.SHOT_PATH}`);
}

await cleanUp();
process.exit(failed === 0 ? 0 : 1);
