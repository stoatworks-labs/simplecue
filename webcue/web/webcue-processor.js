// ---------------------------------------------------------------------------
// webcue: the AudioWorkletProcessor that hosts SimpleCue's CueVoice.
//
// The wasm module is instantiated here, inside the worklet, not on the main
// thread — AudioWorkletGlobalScope has no fetch, so the bytes arrive through
// processorOptions and are compiled in place. There is no Emscripten JS glue:
// the module is built with -sSTANDALONE_WASM and needs only four stub imports.
//
// process() is the audio thread. It drains the command queue and calls
// wc_render, which is the same order the desktop app's audio callback uses
// (drainCommands, then render). Nothing here allocates once running.
// ---------------------------------------------------------------------------

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

class WebCueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.commands = [];
    this.wasm = null;
    this.heapF32 = null;
    this.heapU8 = null;
    this.view = null;

    this.port.onmessage = (e) => this.onMessage(e.data);

    const bytes = options?.processorOptions?.wasmBytes;
    const numOutputs = options?.processorOptions?.numOutputs ?? 2;

    if (bytes) {
      try {
        // Synchronous compilation is permitted off the main thread, which keeps
        // the processor usable from its very first render quantum.
        const module = new WebAssembly.Module(bytes);
        this.instantiate(module, numOutputs);
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String(err) });
      }
    }
  }

  instantiate(module, numOutputs) {
    const imports = {
      env: {
        // ALLOW_MEMORY_GROWTH tells us when to rebuild our typed-array views.
        emscripten_notify_memory_growth: () => this.refreshViews(),
      },
      wasi_snapshot_preview1: {
        // The engine never does file IO; these exist only because the standalone
        // runtime links a stdio it does not use.
        fd_close: () => 0,
        fd_seek: () => 0,
        fd_write: () => 0,
      },
    };

    const instance = new WebAssembly.Instance(module, imports);
    this.wasm = instance.exports;

    this.refreshViews();
    this.wasm.wc_init(sampleRate, 128, numOutputs);

    this.numOutputs = this.wasm.wc_num_outputs();
    this.blockSize = this.wasm.wc_block_size();
    this.outputPtr = this.wasm.wc_output_ptr();
    this.specPtr = this.wasm.wc_spec_ptr();
    this.ready = true;

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      blockSize: this.blockSize,
      numOutputs: this.numOutputs,
      maxVoices: this.wasm.wc_max_voices(),
    });
  }

  refreshViews() {
    const buffer = this.wasm.memory.buffer;
    this.heapF32 = new Float32Array(buffer);
    this.heapU8 = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  onMessage(msg) {
    if (!this.ready) {
      // Commands that arrive before instantiation completes are still honoured.
      this.commands.push(msg);
      return;
    }

    switch (msg.type) {
      case 'loadSource':
        this.loadSource(msg);
        break;

      case 'query':
        this.reportState();
        break;

      default:
        this.commands.push(msg);
        break;
    }
  }

  /** Copies decoded planar audio into the wasm heap and registers it. Main
      thread work in spirit — it runs on the worklet thread but only ever
      between blocks, never inside a render. */
  loadSource({ index, channels, numFrames, rate }) {
    const numChannels = channels.length;
    const bytes = numChannels * numFrames * 4;
    const ptr = this.wasm.malloc(bytes);

    if (!ptr) {
      this.port.postMessage({ type: 'error', message: 'out of wasm memory' });
      return;
    }

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
    const little = true;

    v.setInt32(p + o.sourceIndex, spec.sourceIndex ?? 0, little);
    v.setInt32(p + o.fromDeviceInput, spec.fromDeviceInput ? 1 : 0, little);
    v.setInt32(p + o.inputFirstChannel, spec.inputFirstChannel ?? 0, little);
    v.setInt32(p + o.inputNumChannels, spec.inputNumChannels ?? 2, little);

    v.setFloat64(p + o.regionStart, spec.regionStart ?? 0, little);
    v.setFloat64(p + o.regionEnd, spec.regionEnd ?? 0, little);
    v.setFloat64(p + o.preWaitSamples, spec.preWaitSamples ?? 0, little);

    v.setInt32(p + o.loopEnabled, spec.loopEnabled ? 1 : 0, little);
    v.setInt32(p + o.loopCount, spec.loopCount ?? 0, little);

    v.setInt32(p + o.vampEnabled, spec.vampEnabled ? 1 : 0, little);
    v.setFloat64(p + o.vampStart, spec.vampStart ?? 0, little);
    v.setFloat64(p + o.vampEnd, spec.vampEnd ?? 0, little);
    v.setInt32(p + o.vampRelease, spec.vampRelease ?? 0, little);

    v.setFloat32(p + o.gain, spec.gain ?? 1, little);

    v.setFloat64(p + o.fadeInSamples, spec.fadeInSamples ?? 0, little);
    v.setInt32(p + o.fadeInShape, spec.fadeInShape ?? 1, little);
    v.setFloat64(p + o.fadeOutSamples, spec.fadeOutSamples ?? 0, little);
    v.setInt32(p + o.fadeOutShape, spec.fadeOutShape ?? 1, little);

    const routes = spec.routes ?? [];
    const n = Math.min(routes.length, MAX_ROUTES);
    v.setInt32(p + o.numRoutes, n, little);

    const srcBase = p + o.routeSource;
    const outBase = srcBase + MAX_ROUTES * 4;
    const gainBase = outBase + MAX_ROUTES * 4;

    for (let i = 0; i < n; i++) {
      v.setInt32(srcBase + i * 4, routes[i].source, little);
      v.setInt32(outBase + i * 4, routes[i].output, little);
      v.setFloat32(gainBase + i * 4, routes[i].gain, little);
    }
  }

  applyCommand(cmd) {
    const w = this.wasm;

    switch (cmd.type) {
      case 'fire': {
        const voice = w.wc_find_free_voice();

        if (voice < 0) {
          this.port.postMessage({ type: 'error', message: 'no free voice' });
          return;
        }

        this.writeSpec(cmd.spec);

        if (w.wc_voice_set_spec(voice)) {
          w.wc_voice_start(voice);
          this.port.postMessage({ type: 'fired', cueId: cmd.cueId, voice });
        }
        break;
      }

      case 'stop':
        w.wc_voice_stop(cmd.voice, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        break;

      case 'stopAll':
        for (let i = 0; i < w.wc_max_voices(); i++) {
          if (w.wc_voice_state(i) !== 0) w.wc_voice_stop(i, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        }
        break;

      case 'releaseVamp':
        w.wc_voice_release_vamp(cmd.voice);
        break;

      case 'releaseAllVamps':
        for (let i = 0; i < w.wc_max_voices(); i++) {
          if (w.wc_voice_is_vamping(i)) w.wc_voice_release_vamp(i);
        }
        break;

      case 'gainRamp':
        w.wc_voice_gain_ramp(cmd.voice, cmd.target, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        break;

      case 'scheduleStop':
        w.wc_voice_schedule_stop(cmd.voice, cmd.atSounded, cmd.fadeSamples ?? 0, cmd.shape ?? 1);
        break;

      case 'setPaused':
        w.wc_voice_set_paused(cmd.voice, cmd.paused ? 1 : 0);
        break;

      case 'masterGain':
        w.wc_set_master_gain(cmd.gain);
        break;

      default:
        break;
    }
  }

  reportState() {
    const w = this.wasm;
    const voices = [];

    for (let i = 0; i < w.wc_max_voices(); i++) {
      const state = w.wc_voice_state(i);
      if (state === 0) continue;

      voices.push({
        voice: i,
        state,
        position: w.wc_voice_position(i),
        sounded: w.wc_voice_sounded(i),
        vamping: w.wc_voice_is_vamping(i) === 1,
        gain: w.wc_voice_gain(i),
        playPasses: w.wc_voice_play_passes(i),
        vampPasses: w.wc_voice_vamp_passes(i),
      });
    }

    this.port.postMessage({ type: 'state', voices });
  }

  process(inputs, outputs, parameters) {
    if (!this.ready) return true;

    const w = this.wasm;

    // Drain first, render second — the desktop callback's order.
    if (this.commands.length > 0) {
      for (const cmd of this.commands) this.applyCommand(cmd);
      this.commands.length = 0;
    }

    w.wc_recycle_finished();
    w.wc_render(128);

    const out = outputs[0];
    const base = this.outputPtr / 4;
    const stride = this.blockSize;
    const n = Math.min(out.length, this.numOutputs);

    for (let c = 0; c < n; c++) {
      out[c].set(this.heapF32.subarray(base + c * stride, base + c * stride + 128));
    }

    // Any output channels the engine does not drive stay silent.
    for (let c = n; c < out.length; c++) out[c].fill(0);

    return true;
  }
}

registerProcessor('webcue-processor', WebCueProcessor);
