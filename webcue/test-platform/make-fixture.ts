// Writes a .cueshow using webcue's own codec, so the desktop app can be asked
// to open it.
//
// This is the direction that matters for the compatibility claim. A show
// written in a browser has to open on the rig, or the browser build is a
// one-way door — you could build a show in it and never get the show back.
//
//   node webcue/test-platform/make-fixture.mjs ~/Desktop/webcue-roundtrip
//
// It writes <dir>/Roundtrip.cueshow plus the audio it refers to, so the desktop
// app resolves the relative paths the same way it would for its own show.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { makeCue, makeShow, serialiseShow } from '../packages/core/src/index.ts';

const outDir = resolve(process.argv[2] ?? './webcue-roundtrip');
mkdirSync(join(outDir, 'audio'), { recursive: true });

function wav(seconds, freq, rate = 48000, channels = 2) {
  const frames = Math.round(seconds * rate);
  const bytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + bytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.3 * 32767);
    for (let c = 0; c < channels; c++) {
      buf.writeInt16LE(v, o + c * 2);
    }
    o += channels * 2;
  }

  return buf;
}

writeFileSync(join(outDir, 'audio', 'one.wav'), wav(8, 220));
writeFileSync(join(outDir, 'audio', 'two.wav'), wav(6, 330));

// Deliberately exercises the awkward parts: a free-text cue number, a decimal
// one, every link mode, a vamp, a finite loop, an explicit routing matrix, a
// hard stop, and a container cue whose Play sub-cue is not fired with it.
const cues = [
  makeCue({
    number: 'PRE',
    name: 'Preshow',
    audioFile: 'audio/one.wav',
    fileDuration: 8,
    endTime: 8,
    fileChannels: 2,
    fileSampleRate: 48000,
    gainDb: -6.5,
    preWait: 1.25,
    fadeInTime: 2,
    fadeInShape: 'sCurve',
    fadeOutTime: 1.5,
    fadeOutShape: 'logarithmic',
    notes: 'Under the house open. Free-text cue number on purpose.',
  }),
  makeCue({
    number: '1',
    name: 'Storm builds',
    audioFile: 'audio/two.wav',
    fileDuration: 6,
    endTime: 6,
    fileChannels: 2,
    fileSampleRate: 48000,
    loopEnabled: true,
    loopCount: 3,
    vampEnabled: true,
    vampStart: 1.5,
    vampEnd: 4,
    vampRelease: 'immediately',
    endAction: 'hardStop',
  }),
  makeCue({
    number: '1.5',
    name: 'Handover',
    audioFile: 'audio/one.wav',
    fileDuration: 8,
    endTime: 8,
    fileChannels: 2,
    fileSampleRate: 48000,
    firePlayWithCue: false,
    routing: [
      { sourceChannel: 0, outputChannel: 0, gain: 1 },
      { sourceChannel: 1, outputChannel: 1, gain: 0.5 },
    ],
  }),
  makeCue({
    number: '2',
    name: 'Arrival',
    audioFile: 'audio/two.wav',
    fileDuration: 6,
    endTime: 6,
    fileChannels: 2,
    fileSampleRate: 48000,
  }),
];

// Link them: instantly, at end, and a crossfade, so every mode is present.
cues[0].link = { mode: 'autoContinue', target: null, delay: 0.5, duration: 3, shape: 'equalPower' };
cues[1].link = { mode: 'autoFollow', target: null, delay: 1, duration: 3, shape: 'equalPower' };
cues[2].link = { mode: 'crossfade', target: cues[3].id, delay: 0, duration: 2.5, shape: 'sCurve' };

const show = makeShow({
  masterGainDb: -3,
  defaultFadeInTime: 1,
  defaultFadeOutTime: 2,
  defaultFadeShape: 'equalPower',
  cues,
});

const showPath = join(outDir, 'Roundtrip.cueshow');
writeFileSync(showPath, serialiseShow(show));

console.log(`wrote ${showPath}`);
console.log(`  ${cues.length} cues, audio in ${join(outDir, 'audio')}`);
console.log('\nOpen it in SimpleCue to check a browser-written show loads on the rig.');
