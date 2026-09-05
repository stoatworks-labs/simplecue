#pragma once

// ---------------------------------------------------------------------------
// webcue parity harness.
//
// Drives the real CueVoice through the paths that are hard to get right, and
// dumps every rendered sample. Built twice from this one file — once natively,
// once to WASM — so the two dumps can be compared bit for bit. Anything the
// port broke shows up as a differing sample.
//
// Signal convention follows SimpleCue's own engine tests: the source is a ramp
// whose sample values encode their own index, so a wrong seek, a missed loop
// wrap or an off-by-one at a vamp boundary is visible in the output value
// itself rather than only in a level.
//
// Block size is 128 frames — the AudioWorklet render quantum, so the native
// run exercises exactly the block structure the browser will impose.
// ---------------------------------------------------------------------------

#include "Audio/CueVoice.h"

#include <cstdio>
#include <vector>

namespace webcue
{

static constexpr int    kBlockSize   = 128;
static constexpr double kSampleRate  = 48000.0;
static constexpr int    kNumOutputs  = 4;
static constexpr int    kSourceFrames = 24000;
static constexpr int    kSourceChans  = 2;

/** A ramp source: channel 0 counts up, channel 1 counts down from zero. Both are
    exactly representable in float32 at these lengths, so any difference between
    two builds is arithmetic, never quantisation of the input. */
struct RampSource
{
    RampSource()
    {
        storage.resize ((size_t) kSourceChans * kSourceFrames);
        pointers.resize ((size_t) kSourceChans);

        for (int c = 0; c < kSourceChans; ++c)
        {
            auto* p = storage.data() + (size_t) c * kSourceFrames;
            pointers[(size_t) c] = p;

            for (int i = 0; i < kSourceFrames; ++i)
                p[i] = c == 0 ? (float) i : -(float) i;
        }

        source = cp::SampleSource (pointers.data(), kSourceChans, kSourceFrames, kSampleRate);
    }

    std::vector<float>  storage;
    std::vector<float*> pointers;
    cp::SampleSource    source;
};

/** Something done to the voice partway through a run. */
struct Action
{
    enum class Type { none, stop, vampRelease, gainRamp, scheduleStop, pause, unpause };

    int          atBlock { 0 };
    Type         type { Type::none };
    juce::int64  i0 { 0 };
    float        f0 { 0.0f };
    cp::FadeShape shape { cp::FadeShape::equalPower };
};

struct Scenario
{
    const char*         name;
    cp::VoiceSpec       spec;
    std::vector<Action> actions;
    int                 numBlocks;
};

/** Renders one scenario, appending every output sample to @p out. */
inline void runScenario (const Scenario& scenario, const RampSource& ramp, std::vector<float>& out)
{
    cp::CueVoice voice;
    voice.prepare (kSampleRate, kBlockSize);

    auto spec = scenario.spec;
    spec.source = &ramp.source;
    voice.setSpec (spec);
    voice.triggerStart();

    juce::AudioBuffer<float> buffer (kNumOutputs, kBlockSize);

    for (int block = 0; block < scenario.numBlocks; ++block)
    {
        for (const auto& action : scenario.actions)
        {
            if (action.atBlock != block)
                continue;

            switch (action.type)
            {
                case Action::Type::stop:         voice.requestStop (action.i0, action.shape); break;
                case Action::Type::vampRelease:  voice.requestVampRelease(); break;
                case Action::Type::gainRamp:     voice.requestGainRamp (action.f0, action.i0, action.shape); break;
                case Action::Type::scheduleStop: voice.scheduleStop (action.i0, (juce::int64) action.f0, action.shape); break;
                case Action::Type::pause:        voice.setPaused (true); break;
                case Action::Type::unpause:      voice.setPaused (false); break;
                case Action::Type::none:         break;
            }
        }

        buffer.clear();
        voice.render (buffer, nullptr, 0, kBlockSize);

        for (int c = 0; c < kNumOutputs; ++c)
        {
            const auto* p = buffer.getReadPointer (c);

            for (int i = 0; i < kBlockSize; ++i)
                out.push_back (p[i]);
        }

        // State is part of the observable behaviour, not just the audio: a voice
        // that finishes a block late would still produce matching samples here.
        out.push_back ((float) (int) voice.getState());
        out.push_back ((float) voice.getPositionSamples());
        out.push_back ((float) voice.getSoundedSamples());
        out.push_back ((float) voice.getVampPassCount());
        out.push_back ((float) voice.getPlayPassCount());
        out.push_back (voice.isVamping() ? 1.0f : 0.0f);
        out.push_back (voice.getCurrentGain());
    }
}

/** Default 1:1 routing of the two source channels onto outputs 0 and 1. */
inline void setStereoRouting (cp::VoiceSpec& spec, float gain = 1.0f)
{
    spec.numRoutes = 2;
    spec.routes[0] = { 0, 0, gain };
    spec.routes[1] = { 1, 1, gain };
}

inline std::vector<Scenario> buildScenarios()
{
    std::vector<Scenario> list;

    // 1 — pre-wait, trimmed region, equal-power fade-in.
    {
        Scenario s { "prewait+trim+fadein", {}, {}, 40 };
        s.spec.regionStart    = 500;
        s.spec.regionEnd      = 4000;
        s.spec.preWaitSamples = 300;
        s.spec.fadeInSamples  = 1000;
        s.spec.fadeInShape    = cp::FadeShape::equalPower;
        s.spec.gain           = 0.5f;
        setStereoRouting (s.spec);
        list.push_back (s);
    }

    // 2 — finite loop; the fade-in re-runs on every pass, the fade-out only on the last.
    {
        Scenario s { "loop x3 + fades", {}, {}, 60 };
        s.spec.regionStart   = 0;
        s.spec.regionEnd     = 2000;
        s.spec.loopEnabled   = true;
        s.spec.loopCount     = 3;
        s.spec.fadeInSamples = 400;
        s.spec.fadeInShape   = cp::FadeShape::sCurve;
        s.spec.fadeOutSamples = 600;
        s.spec.fadeOutShape  = cp::FadeShape::logarithmic;
        setStereoRouting (s.spec);
        list.push_back (s);
    }

    // 3 — vamp released at the end of a pass: it must finish the circle, then run on.
    {
        Scenario s { "vamp release atEndOfPass", {}, {}, 80 };
        s.spec.regionStart  = 0;
        s.spec.regionEnd    = 6000;
        s.spec.vampEnabled  = true;
        s.spec.vampStart    = 1000;
        s.spec.vampEnd      = 2500;
        s.spec.vampRelease  = cp::VampRelease::atEndOfPass;
        setStereoRouting (s.spec);
        s.actions.push_back ({ 30, Action::Type::vampRelease, 0, 0.0f, {} });
        list.push_back (s);
    }

    // 4 — the same vamp released immediately: it must leave the loop mid-pass.
    {
        Scenario s { "vamp release immediately", {}, {}, 80 };
        s.spec.regionStart  = 0;
        s.spec.regionEnd    = 6000;
        s.spec.vampEnabled  = true;
        s.spec.vampStart    = 1000;
        s.spec.vampEnd      = 2500;
        s.spec.vampRelease  = cp::VampRelease::immediately;
        setStereoRouting (s.spec);
        s.actions.push_back ({ 30, Action::Type::vampRelease, 0, 0.0f, {} });
        list.push_back (s);
    }

    // 5 — the crossfade path: a stop armed at an exact sounded-sample offset that
    //     deliberately falls mid-block, where a block-granular implementation drifts.
    {
        Scenario s { "scheduled stop mid-block", {}, {}, 60 };
        s.spec.regionStart = 0;
        s.spec.regionEnd   = 8000;
        setStereoRouting (s.spec);
        s.actions.push_back ({ 2, Action::Type::scheduleStop, 3011, 1500.0f, cp::FadeShape::equalPower });
        list.push_back (s);
    }

    // 6 — the live fader: a gain ramp that does not stop the voice.
    {
        Scenario s { "gain ramp (live fader)", {}, {}, 60 };
        s.spec.regionStart = 0;
        s.spec.regionEnd   = 8000;
        setStereoRouting (s.spec);
        s.actions.push_back ({ 5,  Action::Type::gainRamp, 900, 0.25f, cp::FadeShape::exponential });
        s.actions.push_back ({ 25, Action::Type::gainRamp, 700, 1.00f, cp::FadeShape::linear });
        list.push_back (s);
    }

    // 7 — the routing matrix: one source channel feeding several outputs at
    //     different gains, which is where an output-channel bound slip would show.
    {
        Scenario s { "crosspoint routing", {}, {}, 40 };
        s.spec.regionStart = 0;
        s.spec.regionEnd   = 5000;
        s.spec.numRoutes   = 5;
        s.spec.routes[0]   = { 0, 0, 1.00f };
        s.spec.routes[1]   = { 0, 2, 0.50f };
        s.spec.routes[2]   = { 1, 1, 0.75f };
        s.spec.routes[3]   = { 1, 3, 0.25f };
        s.spec.routes[4]   = { 1, 9, 1.00f };   // out of range: must be skipped, not crash
        list.push_back (s);
    }

    // 8 — pause holds position, fades and scheduled stops with it.
    {
        Scenario s { "pause and resume", {}, {}, 60 };
        s.spec.regionStart   = 0;
        s.spec.regionEnd     = 8000;
        s.spec.fadeInSamples = 2000;
        s.spec.fadeInShape   = cp::FadeShape::linear;
        setStereoRouting (s.spec);
        s.actions.push_back ({ 5,  Action::Type::pause,   0, 0.0f, {} });
        s.actions.push_back ({ 20, Action::Type::unpause, 0, 0.0f, {} });
        list.push_back (s);
    }

    // 9 — every fade shape, so all five curves are compared, not just the default.
    {
        const cp::FadeShape shapes[] = { cp::FadeShape::linear,
                                         cp::FadeShape::equalPower,
                                         cp::FadeShape::exponential,
                                         cp::FadeShape::logarithmic,
                                         cp::FadeShape::sCurve };

        for (auto shape : shapes)
        {
            Scenario s { "fade shape sweep", {}, {}, 40 };
            s.spec.regionStart    = 0;
            s.spec.regionEnd      = 4000;
            s.spec.fadeInSamples  = 1200;
            s.spec.fadeInShape    = shape;
            s.spec.fadeOutSamples = 1200;
            s.spec.fadeOutShape   = shape;
            setStereoRouting (s.spec);
            list.push_back (s);
        }
    }

    // 10 — an infinite loop stopped by the operator, with a fade.
    {
        Scenario s { "infinite loop + operator stop", {}, {}, 70 };
        s.spec.regionStart = 0;
        s.spec.regionEnd   = 1500;
        s.spec.loopEnabled = true;
        s.spec.loopCount   = 0;
        setStereoRouting (s.spec);
        s.actions.push_back ({ 40, Action::Type::stop, 800, 0.0f, cp::FadeShape::equalPower });
        list.push_back (s);
    }

    return list;
}

/** Runs every scenario and returns the concatenated dump. */
inline std::vector<float> runAll()
{
    RampSource ramp;
    std::vector<float> out;

    for (const auto& s : buildScenarios())
        runScenario (s, ramp, out);

    return out;
}

} // namespace webcue
