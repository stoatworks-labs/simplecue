// The AudioWorkletProcessor that hosts SimpleCue's CueVoice.
//
// Deliberately plain JavaScript, not TypeScript: a worklet is loaded by URL
// through addModule(), so making it a bundler entry point buys nothing and
// costs a class of build problems. It is the single copy — build.sh puts it
// next to the wasm for anything that wants it.
//
// TWO RULES SHAPE THIS FILE.
//
// 1. It does not allocate voices. The sequencer's scheduleLink recurses
//    synchronously and must know a slot before it can fill in the next cue's
//    parent, so allocation cannot live behind a postMessage. The main thread
//    allocates; every command names its slot.
//
// 2. It reports finishes before recycling them. A voice goes finished -> idle
//    inside one render quantum, so a finish that is not reported is a finish
//    nobody can observe — and an open-ended auto-follow fires exactly when its
//    source finishes. wc_drain_finished does both halves in the right order.
//
// process() is the audio thread. It drains commands, reports finishes, then
// renders — the same order as the desktop's audio callback.

const SPEC_OFFSETS = {
  sourceIndex: 0,
  fromDeviceInput: 4,
  inputFirstChannel: 8,
  inputNumChannels: 12,
  regionStart: 16,
  regionEnd: 24,
  preWaitSamples: 32,
  loopEnabled: 40,
  loopCount: 44,
  vampEnabled: 48,
  vampStart: 56,
  vampEnd: 64,
  vampRelease: 72,
  gain: 76,
  fadeInSamples: 80,
  fadeInShape: 88,
  fadeOutSamples: 96,
  fadeOutShape: 104,
  numRoutes: 108,
  routeSource: 112,
};

const MAX_ROUTES = 128;
const RENDER_QUANTUM = 128;

/** Snapshots are for meters and read-outs, so they go at a human rate rather
    than every block. 16 blocks is ~43 ms at 48 kHz. */
const SNAPSHOT_EVERY = 16;

class WebCueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.commands = [];
    this.wasm = null;
    this.heapF32 = null;
    this.heapI32 = null;
    this.view = null;
    this.blocksSinceSnapshot = 0;

    /** Generation per slot, so a command that raced a finish is dropped rather
        than applied to whoever holds the slot now. */
    this.generations = new Int32Array(64);

    this.port.onmessage = (e) => this.onMessage(e.data);

    const bytes = options?.processorOptions?.wasmBytes;
    const numOutputs = options?.processorOptions?.numOutputs ?? 2;

    if (bytes) {
      try {
        // Synchronous compilation is allowed off the main thread, which keeps
        // the processor usable from its first render quantum.
        this.instantiate(new WebAssembly.Module(bytes), numOutputs);
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    }
  }

  instantiate(module, numOutputs) {
    const imports = {
      env: {
        emscripten_notify_memory_growth: () => this.refreshViews(),
      },
      wasi_snapshot_preview1: {
        // The engine does no file IO; these exist only because the standalone
        // runtime links a stdio it never calls.
        fd_close: () => 0,
        fd_seek: () => 0,
        fd_write: () => 0,
      },
    };

    const instance = new WebAssembly.Instance(module, imports);
    this.wasm = instance.exports;

    this.refreshViews();
    this.wasm.wc_init(sampleRate, RENDER_QUANTUM, numOutputs);

    this.numOutputs = this.wasm.wc_num_outputs();
    this.blockSize = this.wasm.wc_block_size();
    this.outputPtr = this.wasm.wc_output_ptr();
    this.specPtr = this.wasm.wc_spec_ptr();
    this.finishedPtr = this.wasm.wc_finished_ptr();
    this.maxVoices = this.wasm.wc_max_voices();
    this.ready = true;

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      blockSize: this.blockSize,
      numOutputs: this.numOutputs,
      maxVoices: this.maxVoices,
    });

    // Commands that arrived before instantiation finished are still honoured.
    if (this.commands.length > 0) this.drain();
  }

  refreshViews() {
    const buffer = this.wasm.memory.buffer;
    this.heapF32 = new Float32Array(buffer);
    this.heapI32 = new Int32Array(buffer);
    this.view = new DataView(buffer);
  }

  onMessage(msg) {
    if (msg.type === 'loadSource' && this.ready) {
      this.loadSource(msg);
      return;
    }

    this.commands.push(msg);
  }

  /** Copies decoded planar audio into the wasm heap and registers it. Runs
      between blocks, never inside a render. */
  loadSource({ index, channels, numFrames, rate }) {
    const numChannels = channels.length;
    const ptr = this.wasm.malloc(numChannels * numFrames * 4);

    if (!ptr) {
      this.port.postMessage({ type: 'error', message: 'out of wasm memory', index });
      return;
    }

    // malloc can grow memory, which detaches every view.
    this.refreshViews();

    for (let c = 0; c < numChannels; c++) {
      this.heapF32.set(channels[c], ptr / 4 + c * numFrames);
    }

    this.wasm.wc_source_set(index, ptr, numChannels, numFrames, rate);
    this.port.postMessage({ type: 'sourceLoaded', index, numFrames, numChannels });
  }

  writeSpec(spec) {
    const v = this.view;
    const p = this.specPtr;
    const o = SPEC_OFFSETS;
    const LE = true;

    v.setInt32(p + o.sourceIndex, spec.sourceIndex ?? 0, LE);
    v.setInt32(p + o.fromDeviceInput, spec.fromDeviceInput ? 1 : 0, LE);
    v.setInt32(p + o.inputFirstChannel, spec.inputFirstChannel ?? 0, LE);
    v.setInt32(p + o.inputNumChannels, spec.inputNumChannels ?? 2, LE);

    v.setFloat64(p + o.regionStart, spec.regionStart ?? 0, LE);
    v.setFloat64(p + o.regionEnd, spec.regionEnd ?? 0, LE);
    v.setFloat64(p + o.preWaitSamples, spec.preWaitSamples ?? 0, LE);

    v.setInt32(p + o.loopEnabled, spec.loopEnabled ? 1 : 0, LE);
    v.setInt32(p + o.loopCount, spec.loopCount ?? 0, LE);

    v.setInt32(p + o.vampEnabled, spec.vampEnabled ? 1 : 0, LE);
    v.setFloat64(p + o.vampStart, spec.vampStart ?? 0, LE);
    v.setFloat64(p + o.vampEnd, spec.vampEnd ?? 0, LE);
    v.setInt32(p + o.vampRelease, spec.vampRelease ?? 0, LE);

    v.setFloat32(p + o.gain, spec.gain ?? 1, LE);

    v.setFloat64(p + o.fadeInSamples, spec.fadeInSamples ?? 0, LE);
    v.setInt32(p + o.fadeInShape, spec.fadeInShape ?? 1, LE);
    v.setFloat64(p + o.fadeOutSamples, spec.fadeOutSamples ?? 0, LE);
    v.setInt32(p + o.fadeOutShape, spec.fadeOutShape ?? 1, LE);

    const routes = spec.routes ?? [];
    const n = Math.min(routes.length, MAX_ROUTES);
    v.setInt32(p + o.numRoutes, n, LE);

    const srcBase = p + o.routeSource;
    const outBase = srcBase + MAX_ROUTES * 4;
    const gainBase = outBase + MAX_ROUTES * 4;

    for (let i = 0; i < n; i++) {
      v.setInt32(srcBase + i * 4, routes[i].source, LE);
      v.setInt32(outBase + i * 4, routes[i].output, LE);
      v.setFloat32(gainBase + i * 4, routes[i].gain, LE);
    }
  }

  /** True when this command is for the voice that currently holds the slot. A
      stop racing a finish is the normal case and is harmless to drop. */
  current(cmd) {
    return cmd.generation === undefined || this.generations[cmd.slot] === cmd.generation;
  }

  applyCommand(cmd) {
    const w = this.wasm;

    switch (cmd.type) {
      case 'start':
        // The slot was chosen by the main thread; this only applies the spec.
        this.generations[cmd.slot] = cmd.generation;
        this.writeSpec(cmd.spec);

        if (w.wc_voice_set_spec(cmd.slot)) {
          w.wc_voice_start(cmd.slot);
        } else {
          this.port.postMessage({
            type: 'error',
            message: `slot ${cmd.slot} was not free`,
            slot: cmd.slot,
          });
        }
        break;

      case 'stop':
        if (this.current(cmd)) w.wc_voice_stop(cmd.slot, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        break;

      case 'scheduleStop':
        if (this.current(cmd)) {
          w.wc_voice_schedule_stop(cmd.slot, cmd.atSounded, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        }
        break;

      case 'releaseVamp':
        if (this.current(cmd)) w.wc_voice_release_vamp(cmd.slot);
        break;

      case 'gainRamp':
        if (this.current(cmd)) {
          w.wc_voice_gain_ramp(cmd.slot, cmd.target, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        }
        break;

      case 'setPaused':
        if (this.current(cmd)) w.wc_voice_set_paused(cmd.slot, cmd.paused ? 1 : 0);
        break;

      case 'masterGain':
        w.wc_set_master_gain(cmd.gain);
        break;

      default:
        break;
    }
  }

  drain() {
    for (const cmd of this.commands) this.applyCommand(cmd);
    this.commands.length = 0;
  }

  /** Reports finished slots with the generation that was running in them, so
      the main thread can discard an event for an occupant it has already
      forgotten. */
  reportFinished() {
    const count = this.wasm.wc_drain_finished();
    if (count === 0) return;

    const base = this.finishedPtr / 4;
    const finished = [];

    for (let i = 0; i < count; i++) {
      const slot = this.heapI32[base + i];
      finished.push({ slot, generation: this.generations[slot] });
    }

    this.port.postMessage({ type: 'finished', voices: finished });
  }

  snapshot() {
    const w = this.wasm;
    const voices = [];

    for (let i = 0; i < this.maxVoices; i++) {
      const state = w.wc_voice_state(i);
      if (state === 0) continue;

      voices.push({
        slot: i,
        generation: this.generations[i],
        state,
        position: w.wc_voice_position(i),
        sounded: w.wc_voice_sounded(i),
        vamping: w.wc_voice_is_vamping(i) === 1,
        gain: w.wc_voice_gain(i),
        playPasses: w.wc_voice_play_passes(i),
        vampPasses: w.wc_voice_vamp_passes(i),
      });
    }

    this.port.postMessage({ type: 'snapshot', voices });
  }

  process(inputs, outputs, parameters) {
    if (!this.ready) return true;

    if (this.commands.length > 0) this.drain();

    this.reportFinished();
    this.wasm.wc_render(RENDER_QUANTUM);

    const out = outputs[0];
    const base = this.outputPtr / 4;
    const stride = this.blockSize;
    const n = Math.min(out.length, this.numOutputs);

    for (let c = 0; c < n; c++) {
      out[c].set(this.heapF32.subarray(base + c * stride, base + c * stride + RENDER_QUANTUM));
    }

    for (let c = n; c < out.length; c++) out[c].fill(0);

    if (++this.blocksSinceSnapshot >= SNAPSHOT_EVERY) {
      this.blocksSinceSnapshot = 0;
      this.snapshot();
    }

    return true;
  }
}

registerProcessor('webcue-processor', WebCueProcessor);
