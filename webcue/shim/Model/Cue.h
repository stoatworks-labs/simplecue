#pragma once

// ---------------------------------------------------------------------------
// webcue: the audio-thread slice of Model/Cue.h.
//
// The real Cue.h carries the whole editable model — juce::File, juce::var
// persistence, ControlMessage, StreamingRef — none of which the audio thread
// can see. VoiceSpec needs exactly three things from it: RoutePoint,
// VampRelease and the `limits` ceilings.
//
// That this file is enough to compile CueVoice.cpp verbatim is the finding:
// the audio-thread types are already separable from the model. Upstream, this
// wants to become Source/Model/CueTypes.h, included by both.
//
// FadeShape is NOT shimmed. Model/FadeCurve.h resolves to the real header in
// Source/, and FadeCurve.cpp is compiled into the engine, so the five curve
// shapes are the shipping ones rather than a copy.
// ---------------------------------------------------------------------------

#include <juce_core/juce_core.h>

#include "Model/FadeCurve.h"

namespace cp
{

namespace limits
{
    static constexpr int maxSourceChannels = 16;
    static constexpr int maxOutputChannels = 64;
    static constexpr int maxVoices         = 32;
}

/** When a vamp lets go of its loop after the operator calls for it. */
enum class VampRelease
{
    atEndOfPass = 0,
    immediately
};

/** One routed connection: source channel -> device output channel, at a linear gain. */
struct RoutePoint
{
    int   sourceChannel { 0 };
    int   outputChannel { 0 };
    float gain { 1.0f };
};

} // namespace cp
