// ---------------------------------------------------------------------------
// webcue: the C boundary between SimpleCue's CueVoice and an AudioWorklet.
//
// Everything below is plumbing. No playback logic lives here — the voices are
// the real cp::CueVoice, compiled from Source/Audio/CueVoice.cpp unmodified.
//
// Threading maps onto SimpleCue's existing contract almost exactly. The
// AudioWorklet's process() callback is the audio thread: it must not allocate
// and must not block, which is what CueVoice::render already guarantees.
// Commands arrive from the main thread over the worklet port and are applied
// at the top of process(), which is the same shape as the desktop app's
// drainCommands() — a queue drained once per block, before rendering.
// ---------------------------------------------------------------------------

#include "Audio/CueVoice.h"

#include <cstdint>
#include <cstring>
#include <new>

using namespace cp;

namespace
{

constexpr int kMaxVoices   = limits::maxVoices;
constexpr int kMaxSources  = 64;
constexpr int kMaxChannels = limits::maxSourceChannels;

struct SourceSlot
{
    const float*  channels[kMaxChannels] {};
    SampleSource  source;
    bool          used { false };
};

struct Engine
{
    CueVoice     voices[kMaxVoices];
    SourceSlot   sources[kMaxSources];
    juce::AudioBuffer<float> output;

    double sampleRate { 48000.0 };
    int    blockSize { 128 };
    int    numOutputs { 2 };
    float  masterGain { 1.0f };
    bool   ready { false };
};

Engine g;

/** The spec JS fills in before calling wc_voice_set_spec. A flat POD so the
    JS side can write it with a DataView at fixed offsets rather than needing a
    function call per field. */
struct WcSpec
{
    std::int32_t sourceIndex;
    std::int32_t fromDeviceInput;
    std::int32_t inputFirstChannel;
    std::int32_t inputNumChannels;

    double regionStart;
    double regionEnd;
    double preWaitSamples;

    std::int32_t loopEnabled;
    std::int32_t loopCount;

    std::int32_t vampEnabled;
    double       vampStart;
    double       vampEnd;
    std::int32_t vampRelease;

    float gain;

    double       fadeInSamples;
    std::int32_t fadeInShape;
    double       fadeOutSamples;
    std::int32_t fadeOutShape;

    std::int32_t numRoutes;
    std::int32_t routeSource[maxRoutesPerVoice];
    std::int32_t routeOutput[maxRoutesPerVoice];
    float        routeGain[maxRoutesPerVoice];
};

WcSpec g_spec;

FadeShape toShape (std::int32_t v)
{
    return (v >= 0 && v <= 4) ? (FadeShape) v : FadeShape::equalPower;
}

} // namespace

extern "C"
{

int wc_block_size()      { return g.blockSize; }
int wc_max_voices()      { return kMaxVoices; }
int wc_num_outputs()     { return g.numOutputs; }

/** Pointer to the shared spec struct, for JS to write through a DataView. */
WcSpec* wc_spec_ptr()    { return &g_spec; }
int     wc_spec_size()   { return (int) sizeof (WcSpec); }

void wc_init (double sampleRate, int blockSize, int numOutputs)
{
    g.sampleRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    g.blockSize  = blockSize > 0 ? blockSize : 128;
    g.numOutputs = numOutputs > 0 ? numOutputs : 2;

    g.output.setSize (g.numOutputs, g.blockSize);

    for (auto& v : g.voices)
        v.prepare (g.sampleRate, g.blockSize);

    for (auto& s : g.sources)
        s.used = false;

    g.masterGain = 1.0f;
    g.ready = true;
}

/** Registers already-decoded planar audio. @p base points at numChannels
    consecutive blocks of numFrames floats, which JS has copied into the wasm
    heap — the same residency guarantee the desktop SampleCache provides. */
int wc_source_set (int index, const float* base, int numChannels, int numFrames, double rate)
{
    if (index < 0 || index >= kMaxSources || base == nullptr)
        return 0;

    if (numChannels < 1) numChannels = 1;
    if (numChannels > kMaxChannels) numChannels = kMaxChannels;

    auto& slot = g.sources[index];

    for (int c = 0; c < numChannels; ++c)
        slot.channels[c] = base + (std::size_t) c * (std::size_t) numFrames;

    slot.source = SampleSource (slot.channels, numChannels, numFrames, rate);
    slot.used = true;
    return 1;
}

/** Applies the staged spec to a voice. Mirrors AudioEngine's rule that a spec
    is written into an idle voice and only then handed over. */
int wc_voice_set_spec (int voiceIndex)
{
    if (voiceIndex < 0 || voiceIndex >= kMaxVoices)
        return 0;

    auto& voice = g.voices[voiceIndex];

    if (voice.getState() != CueVoice::State::idle)
        return 0;

    VoiceSpec spec;

    const auto si = g_spec.sourceIndex;

    if (si >= 0 && si < kMaxSources && g.sources[si].used)
        spec.source = &g.sources[si].source;

    spec.fromDeviceInput   = g_spec.fromDeviceInput != 0;
    spec.inputFirstChannel = g_spec.inputFirstChannel;
    spec.inputNumChannels  = g_spec.inputNumChannels;

    spec.regionStart    = (juce::int64) g_spec.regionStart;
    spec.regionEnd      = (juce::int64) g_spec.regionEnd;
    spec.preWaitSamples = (juce::int64) g_spec.preWaitSamples;

    spec.loopEnabled = g_spec.loopEnabled != 0;
    spec.loopCount   = g_spec.loopCount;

    spec.vampEnabled = g_spec.vampEnabled != 0;
    spec.vampStart   = (juce::int64) g_spec.vampStart;
    spec.vampEnd     = (juce::int64) g_spec.vampEnd;
    spec.vampRelease = g_spec.vampRelease != 0 ? VampRelease::immediately
                                               : VampRelease::atEndOfPass;

    spec.gain = g_spec.gain;

    spec.fadeInSamples  = (juce::int64) g_spec.fadeInSamples;
    spec.fadeInShape    = toShape (g_spec.fadeInShape);
    spec.fadeOutSamples = (juce::int64) g_spec.fadeOutSamples;
    spec.fadeOutShape   = toShape (g_spec.fadeOutShape);

    auto n = g_spec.numRoutes;
    if (n < 0) n = 0;
    if (n > maxRoutesPerVoice) n = maxRoutesPerVoice;
    spec.numRoutes = n;

    for (int r = 0; r < n; ++r)
        spec.routes[r] = { g_spec.routeSource[r], g_spec.routeOutput[r], g_spec.routeGain[r] };

    voice.setSpec (spec);
    return 1;
}

void wc_voice_start (int i)
{
    if (i >= 0 && i < kMaxVoices)
        g.voices[i].triggerStart();
}

void wc_voice_stop (int i, double fadeSamples, int shape)
{
    if (i >= 0 && i < kMaxVoices)
        g.voices[i].requestStop ((juce::int64) fadeSamples, toShape (shape));
}

void wc_voice_release_vamp (int i)
{
    if (i >= 0 && i < kMaxVoices)
        g.voices[i].requestVampRelease();
}

void wc_voice_gain_ramp (int i, float target, double fadeSamples, int shape)
{
    if (i >= 0 && i < kMaxVoices)
        g.voices[i].requestGainRamp (target, (juce::int64) fadeSamples, toShape (shape));
}

void wc_voice_schedule_stop (int i, double atSounded, double fadeSamples, int shape)
{
    if (i >= 0 && i < kMaxVoices)
        g.voices[i].scheduleStop ((juce::int64) atSounded, (juce::int64) fadeSamples, toShape (shape));
}

void wc_voice_set_paused (int i, int paused)
{
    if (i >= 0 && i < kMaxVoices)
        g.voices[i].setPaused (paused != 0);
}

int wc_voice_state (int i)
{
    return (i >= 0 && i < kMaxVoices) ? (int) g.voices[i].getState() : 0;
}

double wc_voice_position (int i)
{
    return (i >= 0 && i < kMaxVoices) ? (double) g.voices[i].getPositionSamples() : 0.0;
}

double wc_voice_sounded (int i)
{
    return (i >= 0 && i < kMaxVoices) ? (double) g.voices[i].getSoundedSamples() : 0.0;
}

int wc_voice_is_vamping (int i)
{
    return (i >= 0 && i < kMaxVoices && g.voices[i].isVamping()) ? 1 : 0;
}

float wc_voice_gain (int i)
{
    return (i >= 0 && i < kMaxVoices) ? g.voices[i].getCurrentGain() : 0.0f;
}

int wc_voice_play_passes (int i)
{
    return (i >= 0 && i < kMaxVoices) ? g.voices[i].getPlayPassCount() : 0;
}

int wc_voice_vamp_passes (int i)
{
    return (i >= 0 && i < kMaxVoices) ? g.voices[i].getVampPassCount() : 0;
}

/** Reclaims finished voices. On the desktop this is the message thread's job;
    here it runs at the top of process(), which is cheap and keeps the JS side
    from having to poll for it. */
int wc_recycle_finished()
{
    int reclaimed = 0;

    for (auto& v : g.voices)
    {
        if (v.isFinished())
        {
            v.recycle();
            ++reclaimed;
        }
    }

    return reclaimed;
}

int wc_find_free_voice()
{
    for (int i = 0; i < kMaxVoices; ++i)
        if (g.voices[i].getState() == CueVoice::State::idle)
            return i;

    return -1;
}

void wc_set_master_gain (float g_) { g.masterGain = g_; }

/** Planar output block: channel c starts at wc_output_ptr() + c * blockSize. */
const float* wc_output_ptr() { return g.output.getReadPointer (0); }

/** Renders one block. This is the audio thread. */
int wc_render (int numSamples)
{
    if (! g.ready)
        return 0;

    if (numSamples > g.blockSize)
        numSamples = g.blockSize;

    g.output.clear();

    int active = 0;

    for (auto& v : g.voices)
    {
        if (! v.isActive())
            continue;

        v.render (g.output, nullptr, 0, numSamples);
        ++active;
    }

    if (g.masterGain != 1.0f)
    {
        for (int c = 0; c < g.numOutputs; ++c)
        {
            auto* p = g.output.getWritePointer (c);

            for (int i = 0; i < numSamples; ++i)
                p[i] *= g.masterGain;
        }
    }

    return active;
}

} // extern "C"
