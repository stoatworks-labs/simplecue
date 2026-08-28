#pragma once

// ---------------------------------------------------------------------------
// webcue: SampleSource as a non-owning view over already-decoded audio.
//
// The desktop SampleSource decodes and resamples a file with JUCE on a
// background thread. In the browser that job belongs to decodeAudioData, which
// hands back planar Float32Arrays already at the AudioContext's rate — the
// same guarantee the desktop cache provides ("resident in RAM at the device's
// own rate"), reached by a different route.
//
// So the browser build keeps the *contract* CueVoice depends on — integer
// indexing into resident, device-rate, planar float channels — and drops only
// the decoding, which the platform now does for us.
// ---------------------------------------------------------------------------

#include <juce_core/juce_core.h>

namespace cp
{

class SampleSource
{
public:
    SampleSource() = default;

    /** @p channelData must outlive the source, and hold @p numChannels planar
        blocks of @p numFrames floats at the AudioContext sample rate. */
    SampleSource (const float* const* channelData, int numChannels, juce::int64 numFrames, double rate)
        : channels (channelData), channelCount (numChannels), frames (numFrames), sampleRate (rate)
    {
    }

    double getSampleRate() const noexcept     { return sampleRate; }
    int    getNumChannels() const noexcept    { return channelCount; }
    juce::int64 getNumFrames() const noexcept { return frames; }

    double getLengthSeconds() const noexcept
    {
        return sampleRate > 0.0 ? (double) frames / sampleRate : 0.0;
    }

    juce::int64 getMemoryUsage() const noexcept
    {
        return (juce::int64) channelCount * frames * (juce::int64) sizeof (float);
    }

    /** Read pointer for @p channel. Never null for a channel in range. */
    const float* getReadPointer (int channel) const noexcept
    {
        return channels[juce::jlimit (0, channelCount - 1, channel)];
    }

private:
    const float* const* channels { nullptr };
    int channelCount { 0 };
    juce::int64 frames { 0 };
    double sampleRate { 0.0 };
};

} // namespace cp
