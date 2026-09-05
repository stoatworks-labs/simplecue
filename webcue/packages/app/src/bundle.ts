// A show and its audio in one file.
//
// A browser cannot hold a folder the way the desktop does, so a bundle is the
// answer to the problem that actually bites: an operator sends a show to
// someone else and the audio does not go with it.
//
// THE FORMAT IS DELIBERATELY BORING. A .cueshowpack is a plain zip with
// show.cueshow at the root and every audio file stored at exactly the relative
// path the show already records:
//
//   show.cueshow
//   audio/act-one/rain.wav
//   audio/act-one/door.wav
//
// So opening one on the desktop is "unzip it and open show.cueshow" — no new
// parser, no format version, nothing to keep in step. That matters, because a
// bundle the desktop cannot read is a one-way door: a show packed in a browser
// could never go home again. Teaching Show.cpp to open one is a small, separate
// change, and this format is shaped so that it stays small.
//
// Audio is STORED, not deflated. Compressed audio does not compress again, and
// spending seconds of CPU to save a fraction of a percent on a several-hundred
// megabyte show is a poor trade at the moment someone is trying to leave.

import { unzipSync, zipSync } from 'fflate';

import type { ShowData } from '@webcue/core';
import { parseShow, serialiseShow } from '@webcue/core';

export const bundleExtension = '.cueshowpack';
const SHOW_ENTRY = 'show.cueshow';

export interface BundleContents {
  show: ShowData;
  /** Keyed by the path the show records, so it drops straight into the loader. */
  audio: Map<string, ArrayBuffer>;
  missing: string[];
}

/** Which audio paths a show refers to, deduplicated. */
export function audioPathsOf(show: ShowData): string[] {
  const paths = new Set<string>();

  for (const cue of show.cues) {
    if (cue.type === 'audioFile' && cue.audioFile.length > 0) paths.add(cue.audioFile);
  }

  return [...paths];
}

/** Zip entry names use forward slashes by convention, whatever the show holds.
    The show file itself is untouched — its paths stay exactly as written, so a
    Windows-authored show still opens on the machine that wrote it. */
function entryName(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function buildBundle(show: ShowData, audio: Map<string, ArrayBuffer>): Blob {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};

  entries[SHOW_ENTRY] = [new TextEncoder().encode(serialiseShow(show)), { level: 6 }];

  for (const path of audioPathsOf(show)) {
    const bytes = audio.get(path);
    if (!bytes) continue;

    entries[entryName(path)] = [new Uint8Array(bytes), { level: 0 }];
  }

  const zipped = zipSync(entries);

  // Copied into a fresh ArrayBuffer: fflate may hand back a view over a larger
  // pooled buffer, and Blob would then carry the slack with it.
  return new Blob([zipped.slice()], { type: 'application/zip' });
}

export async function readBundle(file: File): Promise<BundleContents> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  let files: Record<string, Uint8Array>;

  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new Error(`That is not a readable ${bundleExtension} file: ${(e as Error).message}`);
  }

  const showBytes = files[SHOW_ENTRY];

  if (!showBytes) {
    throw new Error(`No ${SHOW_ENTRY} inside that bundle.`);
  }

  const show = parseShow(new TextDecoder().decode(showBytes));
  const audio = new Map<string, ArrayBuffer>();
  const missing: string[] = [];

  for (const path of audioPathsOf(show)) {
    const stored = files[entryName(path)];

    if (!stored) {
      missing.push(path);
      continue;
    }

    const copy = new ArrayBuffer(stored.byteLength);
    new Uint8Array(copy).set(stored);
    audio.set(path, copy);
  }

  return { show, audio, missing };
}
