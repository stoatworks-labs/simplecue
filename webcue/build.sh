#!/usr/bin/env bash
#
# webcue spike build + verification.
#
#   ./webcue/build.sh          build the engine and run every check
#   ./webcue/build.sh engine   build only the wasm engine
#   ./webcue/build.sh verify   build only the parity/offset checks and run them
#
# Run from the repository root. Needs emscripten (brew install emscripten),
# a C++20 host compiler, and node.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD="webcue/build"
WEB="webcue/web"
mkdir -p "$BUILD"

# webcue/package.json declares "type": "module" for the workspace, which Node
# then applies to every .js file beneath it — including Emscripten's generated
# harness glue, which is CommonJS and calls require(). Scoping the build
# directory back to CommonJS is the smallest fix; renaming the outputs to .cjs
# would mean fighting emcc, which picks its output format by extension.
echo '{ "type": "commonjs" }' > "$BUILD/package.json"

# The engine sources: SimpleCue's own audio-thread code, unmodified, plus the
# C boundary. The include order puts webcue/shim ahead of Source so that
# Model/Cue.h and Audio/SampleSource.h resolve to the browser versions while
# everything else — CueVoice.h/.cpp, FadeCurve.h/.cpp — comes from Source.
ENGINE_SRC=(Source/Audio/CueVoice.cpp Source/Model/FadeCurve.cpp)
INCLUDES=(-Iwebcue/shim -ISource)

# -ffp-contract=off matters: without it the host compiler fuses the envelope
# multiply-add into an FMA that wasm has no instruction for, and the parity
# check then reports differences that are the compiler's, not the port's.
CXXFLAGS=(-std=c++20 -O2 -ffp-contract=off)

EXPORTS=_wc_init,_wc_render,_wc_source_set,_wc_voice_set_spec,_wc_voice_start
EXPORTS=$EXPORTS,_wc_voice_stop,_wc_voice_release_vamp,_wc_voice_gain_ramp
EXPORTS=$EXPORTS,_wc_voice_schedule_stop,_wc_voice_set_paused,_wc_voice_state
EXPORTS=$EXPORTS,_wc_voice_position,_wc_voice_sounded,_wc_voice_is_vamping
EXPORTS=$EXPORTS,_wc_voice_gain,_wc_voice_play_passes,_wc_voice_vamp_passes
EXPORTS=$EXPORTS,_wc_drain_finished,_wc_finished_ptr,_wc_set_master_gain
EXPORTS=$EXPORTS,_wc_output_ptr,_wc_spec_ptr,_wc_spec_size,_wc_block_size
EXPORTS=$EXPORTS,_wc_max_voices,_wc_num_outputs,_malloc,_free

WORKLET="webcue/packages/engine/worklet/webcue-processor.js"

build_engine() {
  echo "==> engine -> $WEB/webcue-engine.wasm"
  em++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" \
    "${ENGINE_SRC[@]}" webcue/engine/webcue_engine.cpp \
    -sSTANDALONE_WASM=1 --no-entry -sALLOW_MEMORY_GROWTH=1 \
    -sEXPORTED_FUNCTIONS="$EXPORTS" \
    -o "$WEB/webcue-engine.wasm"
  ls -la "$WEB/webcue-engine.wasm"

  # The worklet has ONE copy, in packages/engine. The demo gets a build-time
  # copy rather than its own edition, because two hand-maintained versions of a
  # real-time file is how they drift.
  cp "$WORKLET" "$WEB/webcue-processor.js"
}

build_verify() {
  echo "==> parity harness (native)"
  clang++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" -Iwebcue/test \
    "${ENGINE_SRC[@]}" webcue/test/parity_main.cpp -o "$BUILD/parity-native"

  echo "==> parity harness (wasm)"
  em++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" -Iwebcue/test \
    "${ENGINE_SRC[@]}" webcue/test/parity_main.cpp \
    -sNODERAWFS=1 -sENVIRONMENT=node -o "$BUILD/parity-wasm.js"

  echo "==> fade curves in isolation"
  clang++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" \
    Source/Model/FadeCurve.cpp webcue/test/curves_main.cpp -o "$BUILD/curves-native"
  em++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" \
    Source/Model/FadeCurve.cpp webcue/test/curves_main.cpp \
    -sENVIRONMENT=node -o "$BUILD/curves-wasm.js"

  echo "==> WcSpec offsets (wasm32 ABI)"
  em++ -std=c++20 -O0 "${INCLUDES[@]}" \
    "${ENGINE_SRC[@]}" webcue/test/offsets_main.cpp \
    -sENVIRONMENT=node -o "$BUILD/offsets-wasm.js"
}

run_verify() {
  echo
  echo "--- voice parity: native vs wasm ------------------------------------"
  "./$BUILD/parity-native" "$BUILD/native.f32"
  node "$BUILD/parity-wasm.js" "$BUILD/wasm.f32"
  echo
  node webcue/test/compare.mjs "$BUILD/native.f32" "$BUILD/wasm.f32"

  echo
  echo "--- fade curves ------------------------------------------------------"
  echo "native:"; "./$BUILD/curves-native"
  echo "wasm:";   node "$BUILD/curves-wasm.js"

  echo
  echo "--- WcSpec offsets (must match webcue-processor.js) -------------------"
  node "$BUILD/offsets-wasm.js"
}

case "${1:-all}" in
  engine) build_engine ;;
  verify) build_verify; run_verify ;;
  all)    build_engine; build_verify; run_verify ;;
  *)      echo "usage: $0 [engine|verify|all]"; exit 1 ;;
esac
