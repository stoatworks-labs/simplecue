// The browser implementation of VoiceHost.
//
// Deliberately thin: it translates calls into messages and keeps a mirror of
// the voice state the worklet reports. Every DECISION lives in @webcue/core,
// which is what makes the decisions testable — nothing in this file can be
// unit-tested without an AudioContext, so nothing in it should need to be.

import type {
  FadeShape,
  SourceInfo,
  SourceRegistry,
  VoiceHost,
  VoiceRef,
  VoiceSpec,
  VoiceState,
} from '@webcue/core';
import { VoiceState as State, fadeShapeIndex } from '@webcue/core';

interface SnapshotVoice {
  slot: number;
  generation: number;
  state: VoiceState;
  position: number;
  sounded: number;
  vamping: boolean;
  gain: number;
  playPasses: number;
  vampPasses: number;
}

export interface EngineOptions {
  /** URL of webcue-engine.wasm. */
  wasmUrl: string | URL;
  /** URL of webcue-processor.js. */
  workletUrl: string | URL;
  numOutputs?: number;
  context?: AudioContext;
}

export interface EngineEvents {
  /** A voice finished. This is what fires an open-ended auto-follow, so it must
      reach the sequencer promptly — which is why it is a message and not a
      timer. A backgrounded tab throttles timers to 1 Hz; messages still land. */
  onVoiceFinished?: (ref: VoiceRef) => void;
  onSnapshot?: () => void;
  onError?: (message: string) => void;
}

export class WebCueEngine implements VoiceHost, SourceRegistry {
  readonly context: AudioContext;

  private node: AudioWorkletNode | null = null;
  private readonly snapshot = new Map<number, SnapshotVoice>();
  private readonly sources = new Map<string, SourceInfo>();
  private nextSourceIndex = 0;
  private events: EngineEvents = {};

  private _maxVoices = 32;
  private _numOutputs = 2;

  private constructor(context: AudioContext) {
    this.context = context;
  }

  static async create(options: EngineOptions): Promise<WebCueEngine> {
    const context = options.context ?? new AudioContext();
    const engine = new WebCueEngine(context);

    // AudioWorkletGlobalScope has no fetch, so the bytes are fetched here and
    // handed across in processorOptions.
    const [wasmBytes] = await Promise.all([
      fetch(String(options.wasmUrl)).then((r) => r.arrayBuffer()),
      context.audioWorklet.addModule(String(options.workletUrl)),
    ]);

    const numOutputs = options.numOutputs ?? 2;

    const node = new AudioWorkletNode(context, 'webcue-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [numOutputs],
      processorOptions: { wasmBytes, numOutputs },
    });

    engine.node = node;
    node.connect(context.destination);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('engine did not start')), 10_000);

      node.port.onmessage = (e) => {
        if (e.data?.type === 'ready') {
          clearTimeout(timeout);
          engine._maxVoices = e.data.maxVoices;
          engine._numOutputs = e.data.numOutputs;
          node.port.onmessage = (ev) => engine.onMessage(ev.data);
          resolve();
        } else if (e.data?.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(e.data.message));
        }
      };
    });

    return engine;
  }

  setEvents(events: EngineEvents): void {
    this.events = events;
  }

  //== VoiceHost ============================================================

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get maxVoices(): number {
    return this._maxVoices;
  }

  get numOutputChannels(): number {
    return this._numOutputs;
  }

  startVoice(ref: VoiceRef, spec: VoiceSpec): void {
    this.post({
      type: 'start',
      slot: ref.slot,
      generation: ref.generation,
      spec: { ...spec, fadeInShape: fadeShapeIndex(spec.fadeInShape), fadeOutShape: fadeShapeIndex(spec.fadeOutShape) },
    });

    // Mirror it immediately: the sequencer may ask for this voice's state
    // before the worklet has run a single block, and a voice it has just
    // started must not read back as idle.
    this.snapshot.set(ref.slot, {
      slot: ref.slot,
      generation: ref.generation,
      state: spec.preWaitSamples > 0 ? State.preWait : State.playing,
      position: spec.regionStart,
      sounded: 0,
      vamping: false,
      gain: 0,
      playPasses: 0,
      vampPasses: 0,
    });
  }

  stopVoice(ref: VoiceRef, fadeSamples: number, shape: FadeShape): void {
    this.post({ type: 'stop', slot: ref.slot, generation: ref.generation, fadeSamples, shape: fadeShapeIndex(shape) });
  }

  scheduleStop(ref: VoiceRef, atSounded: number, fadeSamples: number, shape: FadeShape): void {
    this.post({
      type: 'scheduleStop',
      slot: ref.slot,
      generation: ref.generation,
      atSounded,
      fadeSamples,
      shape: fadeShapeIndex(shape),
    });
  }

  releaseVamp(ref: VoiceRef): void {
    this.post({ type: 'releaseVamp', slot: ref.slot, generation: ref.generation });
  }

  setPaused(ref: VoiceRef, paused: boolean): void {
    this.post({ type: 'setPaused', slot: ref.slot, generation: ref.generation, paused });
  }

  setMasterGain(linear: number): void {
    this.post({ type: 'masterGain', gain: linear });
  }

  voiceState(ref: VoiceRef): VoiceState {
    return this.live(ref)?.state ?? State.idle;
  }

  voicePosition(ref: VoiceRef): number {
    return this.live(ref)?.position ?? 0;
  }

  voiceSounded(ref: VoiceRef): number {
    return this.live(ref)?.sounded ?? 0;
  }

  voiceIsVamping(ref: VoiceRef): boolean {
    return this.live(ref)?.vamping ?? false;
  }

  voiceGain(ref: VoiceRef): number {
    return this.live(ref)?.gain ?? 0;
  }

  voicePlayPasses(ref: VoiceRef): number {
    return this.live(ref)?.playPasses ?? 0;
  }

  voiceVampPasses(ref: VoiceRef): number {
    return this.live(ref)?.vampPasses ?? 0;
  }

  //== SourceRegistry =======================================================

  get(audioFile: string): SourceInfo | null {
    return this.sources.get(audioFile) ?? null;
  }

  /** Decodes a file and hands the planar audio to the worklet.

      decodeAudioData resamples to the context rate for us, which is the same
      guarantee the desktop SampleCache provides by resampling at load time —
      loops and vamps then land on the same sample every pass. */
  async loadSource(audioFile: string, data: ArrayBuffer): Promise<SourceInfo> {
    const existing = this.sources.get(audioFile);
    if (existing) return existing;

    const buffer = await this.context.decodeAudioData(data);

    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      // Copied, not referenced: the arrays are transferred to the worklet.
      channels.push(new Float32Array(buffer.getChannelData(c)));
    }

    const info: SourceInfo = {
      index: this.nextSourceIndex++,
      numFrames: buffer.length,
      numChannels: buffer.numberOfChannels,
    };

    this.node?.port.postMessage(
      {
        type: 'loadSource',
        index: info.index,
        channels,
        numFrames: info.numFrames,
        rate: buffer.sampleRate,
      },
      channels.map((c) => c.buffer),
    );

    this.sources.set(audioFile, info);
    return info;
  }

  hasSource(audioFile: string): boolean {
    return this.sources.has(audioFile);
  }

  //== Internals ============================================================

  private live(ref: VoiceRef): SnapshotVoice | undefined {
    const v = this.snapshot.get(ref.slot);
    return v && v.generation === ref.generation ? v : undefined;
  }

  private post(message: unknown): void {
    this.node?.port.postMessage(message);
  }

  private onMessage(msg: {
    type: string;
    voices?: SnapshotVoice[] | VoiceRef[];
    message?: string;
  }): void {
    switch (msg.type) {
      case 'snapshot': {
        this.snapshot.clear();
        for (const v of (msg.voices ?? []) as SnapshotVoice[]) this.snapshot.set(v.slot, v);
        this.events.onSnapshot?.();
        break;
      }

      case 'finished': {
        for (const ref of (msg.voices ?? []) as VoiceRef[]) {
          this.snapshot.delete(ref.slot);
          this.events.onVoiceFinished?.(ref);
        }
        break;
      }

      case 'error':
        this.events.onError?.(msg.message ?? 'engine error');
        break;
    }
  }
}
