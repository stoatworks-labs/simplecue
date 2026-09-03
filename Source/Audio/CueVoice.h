#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "Audio/SampleSource.h"
// The audio-thread types only. Cue.h carries file paths, juce::var persistence
// and streaming settings that nothing on this thread should be able to reach.
#include "Model/CueTypes.h"
#include "Model/FadeCurve.h"

namespace cp
{

static constexpr int maxRoutesPerVoice = 128;

/** Everything a voice needs to play, resolved to device samples on the message thread.

    A spec is written into an *idle* voice and only then handed over via the command
    queue, so the audio thread never reads a half-written one and never allocates.
*/
struct VoiceSpec
{
    juce::Uuid cueId;

    /** Decoded audio at the device rate. Null when the voice takes device inputs instead.
        Lifetime is guaranteed by AudioEngine, which holds a shared_ptr for as long as the
        voice is not idle — the audio thread never touches a reference count. */
    const SampleSource* source { nullptr };

    /** True for streaming cues captured from a loopback device: audio arrives on the
        device's inputs, so there is nothing to seek and no length to run out of. */
    bool fromDeviceInput { false };
    int  inputFirstChannel { 0 };
    int  inputNumChannels { 2 };

    juce::int64 regionStart { 0 };      ///< In point, device samples.
    juce::int64 regionEnd { 0 };        ///< Out point, device samples (exclusive).
    juce::int64 preWaitSamples { 0 };

    bool loopEnabled { false };
    int  loopCount { 0 };               ///< Total passes; 0 = forever.

    bool        vampEnabled { false };
    juce::int64 vampStart { 0 };
    juce::int64 vampEnd { 0 };
    VampRelease vampRelease { VampRelease::atEndOfPass };

    float gain { 1.0f };                ///< Linear, from the cue's gainDb.

    juce::int64 fadeInSamples { 0 };
    FadeShape   fadeInShape { FadeShape::equalPower };
    juce::int64 fadeOutSamples { 0 };
    FadeShape   fadeOutShape { FadeShape::equalPower };

    int        numRoutes { 0 };
    RoutePoint routes[maxRoutesPerVoice] {};
};

//==============================================================================
/** One sounding instance of a cue.

    Voices are preallocated and reused. Firing the same cue twice gives two voices, so a
    cue can overlap itself without the second GO cutting the first short.
*/
class CueVoice
{
public:
    CueVoice() = default;

    enum class State
    {
        idle = 0,   ///< Free for reuse.
        reserved,   ///< Claimed and loaded by the message thread; start command in flight.
        preWait,    ///< Started, counting down its pre-wait, silent.
        playing,
        stopping,   ///< Running an action fade that ends in silence.
        finished    ///< Done; waiting for the message thread to reclaim it.
    };

    //== Message thread ========================================================
    void prepare (double deviceSampleRate, int maxBlockSize);

    /** Writes a spec into an idle voice and claims it.

        Claiming matters: a start command does not take effect until the audio thread next
        runs, and in that window the message thread may well be scheduling the next cue in
        a link chain. Without the reservation, findFreeVoice() would hand out this same
        voice twice and the first cue would never be heard. */
    void setSpec (const VoiceSpec& newSpec);

    State getState() const noexcept              { return state.load (std::memory_order_acquire); }
    bool  isActive() const noexcept              { return getState() != State::idle; }
    bool  isFinished() const noexcept            { return getState() == State::finished; }

    juce::Uuid getCueID() const noexcept         { return spec.cueId; }

    /** Marks a finished voice free again. Message thread only. */
    void recycle() noexcept                      { state.store (State::idle, std::memory_order_release); }

    /** Position inside the file, in device samples. Safe to read from any thread. */
    juce::int64 getPositionSamples() const noexcept  { return reportedPosition.load (std::memory_order_relaxed); }
    juce::int64 getRegionStart() const noexcept      { return spec.regionStart; }
    juce::int64 getRegionEnd() const noexcept        { return spec.regionEnd; }

    /** True while the play head is inside an armed, unreleased vamp region — not merely
        while a vamp is armed somewhere later in the cue. */
    bool isVamping() const noexcept              { return vampingNow.load (std::memory_order_relaxed); }
    int  getVampPassCount() const noexcept       { return vampPasses.load (std::memory_order_relaxed); }
    int  getPlayPassCount() const noexcept       { return playPasses.load (std::memory_order_relaxed); }

    /** Current overall gain including fades, for meters and fader read-out. */
    float getCurrentGain() const noexcept        { return reportedGain.load (std::memory_order_relaxed); }

    //== Audio thread (driven by AudioEngine's command queue) ==================
    void triggerStart() noexcept;

    /** Fades to silence over @p fadeSamples and then finishes. Zero is an instant stop. */
    void requestStop (juce::int64 fadeSamples, FadeShape shape) noexcept;

    /** Lets the vamp go, per the cue's VampRelease setting. */
    void requestVampRelease() noexcept;

    /** Ramps to @p targetGain over @p fadeSamples without stopping. Used by crossfades
        and by the operator's live fader. */
    void requestGainRamp (float targetGain, juce::int64 fadeSamples, FadeShape shape) noexcept;

    /** Arms a stop that begins exactly at @p atSoundedSample — counted in device samples
        from this voice's first *sounding* sample, so the pre-wait is excluded and loops
        do not reset it. This is how a crossfade link stays sample-accurate instead of
        landing wherever a message-thread timer happens to tick. Pass -1 to cancel. */
    void scheduleStop (juce::int64 atSoundedSample, juce::int64 fadeSamples, FadeShape shape) noexcept;

    /** Freezes the voice where it is. A paused voice holds its position and outputs
        nothing; scheduled stops and fades hold with it. */
    void setPaused (bool shouldBePaused) noexcept { paused.store (shouldBePaused, std::memory_order_relaxed); }
    bool isPaused() const noexcept                { return paused.load (std::memory_order_relaxed); }

    /** Device samples this voice has actually sounded for, ignoring the pre-wait. */
    juce::int64 getSoundedSamples() const noexcept { return reportedSounded.load (std::memory_order_relaxed); }

    /** True once the voice has left its pre-wait, i.e. audio has begun. */
    bool hasStartedSounding() const noexcept
    {
        const auto s = getState();
        return s == State::playing || s == State::stopping;
    }

    /** Adds this voice's contribution into @p output. @p inputs may be null. */
    void render (juce::AudioBuffer<float>& output,
                 const float* const* inputs,
                 int numInputChannels,
                 int numSamples) noexcept;

private:
    void renderRun (juce::AudioBuffer<float>& output,
                    const float* const* inputs,
                    int numInputChannels,
                    int outOffset,
                    int numSamples) noexcept;
    void handleBoundary() noexcept;
    bool isFinalPass() const noexcept;
    bool isCirclingVamp() const noexcept;
    void finish() noexcept;

    VoiceSpec spec;
    std::atomic<State> state { State::idle };

    double sampleRate { 48000.0 };

    juce::int64 position { 0 };          ///< Read position in device samples.
    juce::int64 preWaitRemaining { 0 };
    juce::int64 samplesPlayed { 0 };     ///< Since the current pass began; drives the fade-in.
    juce::int64 soundedSamples { 0 };    ///< Monotonic since audio began; never reset by loops.
    int  passIndex { 0 };                ///< Completed passes of the whole region.

    juce::int64 pendingStopAt { -1 };    ///< Sounded-sample position of an armed stop.
    juce::int64 pendingStopFade { 0 };
    FadeShape   pendingStopShape { FadeShape::equalPower };

    bool vampActive { false };
    bool vampReleaseRequested { false };
    int  vampPassIndex { 0 };

    // Action envelope: the ramp driven by stops, crossfades and the live fader. Runs on
    // top of the cue's own fade-in/fade-out rather than replacing them.
    float actionFrom { 1.0f };
    float actionTo { 1.0f };
    float actionCurrent { 1.0f };
    juce::int64 actionPos { 0 };
    juce::int64 actionLen { 0 };
    FadeShape actionShape { FadeShape::equalPower };
    bool stopWhenActionCompletes { false };

    // Pending requests, posted by the audio thread's command drain just before render().
    std::atomic<bool> vampReleaseFlag { false };

    std::atomic<bool> paused { false };

    std::atomic<juce::int64> reportedPosition { 0 };
    std::atomic<juce::int64> reportedSounded { 0 };
    std::atomic<bool>  vampingNow { false };
    std::atomic<int>   vampPasses { 0 };
    std::atomic<int>   playPasses { 0 };
    std::atomic<float> reportedGain { 0.0f };

    juce::HeapBlock<float> envelopeScratch;
    int scratchSize { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CueVoice)
};

} // namespace cp
