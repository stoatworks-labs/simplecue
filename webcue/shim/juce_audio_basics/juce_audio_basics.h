#pragma once

// ---------------------------------------------------------------------------
// webcue: AudioBuffer<float> and HeapBlock<float>, to the extent CueVoice uses
// them. CueVoice only ever asks an AudioBuffer for its channel count and a
// write pointer, and only ever asks a HeapBlock to allocate and hand back a
// raw pointer.
// ---------------------------------------------------------------------------

#include <juce_core/juce_core.h>

#include <cstring>
#include <memory>

namespace juce
{

template <typename Type>
class HeapBlock
{
public:
    HeapBlock() = default;

    void allocate (size_t numElements, bool initialiseToZero)
    {
        data = std::make_unique<Type[]> (numElements);

        if (initialiseToZero)
            std::memset (data.get(), 0, numElements * sizeof (Type));
    }

    Type* get() const noexcept { return data.get(); }
    Type* operator+ (int i) const noexcept { return data.get() + i; }
    operator Type*() const noexcept { return data.get(); }

private:
    std::unique_ptr<Type[]> data;
};

template <typename Type>
class AudioBuffer
{
public:
    AudioBuffer() = default;

    AudioBuffer (int numChannelsToUse, int numSamplesToUse)
    {
        setSize (numChannelsToUse, numSamplesToUse);
    }

    void setSize (int numChannelsToUse, int numSamplesToUse)
    {
        numChannels = numChannelsToUse;
        numSamples  = numSamplesToUse;

        storage.assign ((size_t) (numChannels * numSamples), Type());
        channels.resize ((size_t) numChannels);

        for (int c = 0; c < numChannels; ++c)
            channels[(size_t) c] = storage.data() + (size_t) c * (size_t) numSamples;
    }

    int getNumChannels() const noexcept { return numChannels; }
    int getNumSamples() const noexcept  { return numSamples; }

    Type*       getWritePointer (int channel) noexcept      { return channels[(size_t) channel]; }
    const Type* getReadPointer (int channel) const noexcept { return channels[(size_t) channel]; }

    Type* const* getArrayOfWritePointers() noexcept { return channels.data(); }

    void clear()
    {
        std::fill (storage.begin(), storage.end(), Type());
    }

private:
    int numChannels { 0 };
    int numSamples { 0 };
    std::vector<Type>  storage;
    std::vector<Type*> channels;
};

} // namespace juce
