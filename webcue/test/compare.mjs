// Compares two raw float32 dumps from the parity harness and reports where and
// by how much they diverge, in ulps as well as absolute error.

import { readFileSync } from 'node:fs';

const [, , pathA, pathB] = process.argv;

const load = (p) => {
  const buf = readFileSync(p);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

const a = load(pathA);
const b = load(pathB);

if (a.length !== b.length) {
  console.log(`length differs: ${a.length} vs ${b.length}`);
  process.exit(1);
}

// ulp distance between two floats, via their integer bit patterns
const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
const bits = (x) => { f32[0] = x; return i32[0]; };
const ulps = (x, y) => {
  let bx = bits(x), by = bits(y);
  if (bx < 0) bx = 0x80000000 - bx;
  if (by < 0) by = 0x80000000 - by;
  return Math.abs(bx - by);
};

let differing = 0;
let maxUlp = 0;
let maxAbs = 0;
let firstIndex = -1;
const histogram = new Map();

for (let i = 0; i < a.length; i++) {
  if (a[i] === b[i]) continue;
  differing++;
  if (firstIndex < 0) firstIndex = i;
  const u = ulps(a[i], b[i]);
  const d = Math.abs(a[i] - b[i]);
  if (u > maxUlp) maxUlp = u;
  if (d > maxAbs) maxAbs = d;
  histogram.set(u, (histogram.get(u) ?? 0) + 1);
}

console.log(`samples        ${a.length}`);
console.log(`differing      ${differing}  (${((differing / a.length) * 100).toFixed(4)}%)`);
console.log(`first index    ${firstIndex}`);
console.log(`max ulp        ${maxUlp}`);
console.log(`max abs error  ${maxAbs.toExponential(3)}`);
console.log('ulp histogram  ' + [...histogram.entries()].sort((x, y) => x[0] - y[0]).map(([u, n]) => `${u}:${n}`).join('  '));

if (firstIndex >= 0) {
  console.log('\nfirst few differences:');
  let shown = 0;
  for (let i = firstIndex; i < a.length && shown < 8; i++) {
    if (a[i] === b[i]) continue;
    console.log(`  [${i}]  native ${a[i]}  wasm ${b[i]}  ulp ${ulps(a[i], b[i])}`);
    shown++;
  }
}
