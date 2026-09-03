// Voice bookkeeping, ported from AudioEngine's VoiceRecord array
// (AudioEngine.h:161-171, AudioEngine.cpp:146-153).
//
// A slot is owned by this thread from allocate() until the sequencer handles the
// voiceFinished event carrying that slot's current generation. The engine may
// recycle its own wasm voice as soon as it is finished, but must never hand a
// slot to anyone — that is what keeps allocation synchronous, which is what a
// link chain needs.

import type { VoiceRef } from './voicehost.js';

export interface VoiceRecord {
  ref: VoiceRef;
  cueId: string;
  cueIndex: number;
  /** The voice this one was scheduled by. Null for a GO, an audition, or a
      follow fired after its source finished — the desktop's (-1, 0) sentinel. */
  parent: VoiceRef | null;
  sourceIndex: number;
  /** An audition never links onward. Replaces the desktop's write-only
      linkScheduled flag, which nothing ever read. */
  linksOnward: boolean;
}

export class VoicePool {
  private readonly records: (VoiceRecord | null)[];
  private nextGeneration = 1;

  constructor(readonly capacity: number) {
    this.records = new Array<VoiceRecord | null>(capacity).fill(null);
  }

  /** First-fit, matching findFreeVoice(). Returns null when the pool is full —
      the desktop's "All 32 voices are in use." */
  allocate(init: Omit<VoiceRecord, 'ref'>): VoiceRecord | null {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.records[slot] !== null) continue;

      const record: VoiceRecord = { ...init, ref: { slot, generation: this.nextGeneration++ } };
      this.records[slot] = record;
      return record;
    }

    return null;
  }

  /** Only ever called when a finish is observed. Generation-checked so a stale
      event from a previous occupant cannot free the current one. */
  release(ref: VoiceRef): boolean {
    const record = this.records[ref.slot];

    if (!record || record.ref.generation !== ref.generation) return false;

    this.records[ref.slot] = null;
    return true;
  }

  /** Undefined when the generation is stale, which is the point. */
  get(ref: VoiceRef): VoiceRecord | undefined {
    const record = this.records[ref.slot];
    return record && record.ref.generation === ref.generation ? record : undefined;
  }

  bySlot(slot: number): VoiceRecord | undefined {
    return this.records[slot] ?? undefined;
  }

  all(): VoiceRecord[] {
    return this.records.filter((r): r is VoiceRecord => r !== null);
  }

  forCue(cueId: string): VoiceRecord[] {
    return this.all().filter((r) => r.cueId === cueId);
  }

  childrenOf(ref: VoiceRef): VoiceRecord[] {
    return this.all().filter(
      (r) =>
        r.parent !== null &&
        r.parent.slot === ref.slot &&
        r.parent.generation === ref.generation,
    );
  }

  get busy(): number {
    return this.all().length;
  }

  clear(): void {
    this.records.fill(null);
  }
}
