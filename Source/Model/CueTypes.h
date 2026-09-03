#pragma once

namespace cp
{

/** The parts of a cue the audio thread needs, and nothing else.

    `Cue.h` describes a cue as the editor and the file format see it: file paths,
    `juce::var` persistence, control messages, streaming settings. The audio thread
    needs almost none of that — `CueVoice` reads three things from it, and pulling the
    whole model in to get them meant every audio-thread translation unit recompiled
    when an unrelated part of the editable model changed, and could reach for state it
    has no business touching.

    Deliberately free of JUCE, and of every other header: this is plain data. The
    `juce::String` conversions for `VampRelease` stay in `Cue.h`, where the strings
    they exist for are also written.
*/

/** Hard ceilings used to size the lock-free structures the audio thread reads.
    Raising these costs only memory; nothing in the engine iterates to the limit. */
namespace limits
{
    static constexpr int maxSourceChannels = 16;  ///< Channels read from one audio file.
    static constexpr int maxOutputChannels = 64;  ///< Device outputs a cue can be routed to.
    static constexpr int maxVoices         = 32;  ///< Simultaneously sounding cue instances.
}

//==============================================================================
/** When a vamp lets go of its loop after the operator calls for it. */
enum class VampRelease
{
    atEndOfPass = 0,  ///< Finish the current pass, then continue past the vamp out point.
    immediately       ///< Leave the loop at the next sample. Can click on tonal material.
};

//==============================================================================
/** One routed connection: source channel -> device output channel, at a linear gain. */
struct RoutePoint
{
    int   sourceChannel { 0 };
    int   outputChannel { 0 };
    float gain { 1.0f };
};

} // namespace cp
