/*
    Numerical tests for the playback engine.

    The stimulus is a ramp whose value encodes its own sample index: channel 0 holds
    index/rampScale and channel 1 holds the negative of it. That matters. A tone would
    make "played the right region", "played the wrong region" and "looped a sample early"
    produce byte-identical output; a ramp makes every one of those a different number, so
    the test can actually tell right from wrong. Every position assertion below reads the
    output value and converts it straight back into a source sample index.
*/

#include <juce_audio_formats/juce_audio_formats.h>

#include "TestHarness.h"

#include "Audio/CueVoice.h"
#include "Audio/SampleSource.h"
#include "Model/Show.h"

#include <cmath>
#include <cstdio>
#include <vector>

using namespace cp;

namespace
{

constexpr double testRate = 48000.0;
constexpr double rampScale = 1.0e6;   // Keeps values well inside float precision.

using cptest::check;
using cptest::checkNear;

/** Sample index encoded in a channel-0 value produced by the ramp. */
double indexFromValue (float value)
{
    return (double) value * rampScale;
}

/** Writes a ramp WAV and returns the file. Kept in a temp folder and deleted at the end. */
juce::File writeRampFile (const juce::File& directory, int numFrames, int numChannels)
{
    auto file = directory.getChildFile ("ramp_" + juce::String (numChannels) + "ch.wav");
    file.deleteFile();

    juce::AudioBuffer<float> buffer (numChannels, numFrames);

    for (int i = 0; i < numFrames; ++i)
    {
        buffer.setSample (0, i, (float) ((double) i / rampScale));

        if (numChannels > 1)
            buffer.setSample (1, i, (float) (-(double) i / rampScale));
    }

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::FileOutputStream> stream (file.createOutputStream());

    // 32-bit float so the ramp survives the round trip exactly; a 16-bit file would
    // quantise the index right back out of the sample values the tests read.
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (stream.release(), testRate, (unsigned int) numChannels, 32,
                             {}, 0));

    jassert (writer != nullptr);
    writer->writeFromAudioSampleBuffer (buffer, 0, numFrames);
    writer.reset();

    return file;
}

/** Runs a voice to completion (or to @p maxFrames) and returns everything it produced.

    The returned buffer is block-aligned, so its length is *not* the length of the cue —
    the final block is only partly filled. Use voice.getSoundedSamples() for that; the
    trailing samples are silence and are harmless to index into. */
juce::AudioBuffer<float> renderVoice (CueVoice& voice, int numOutputChannels,
                                      int maxFrames, int blockSize = 256)
{
    juce::AudioBuffer<float> captured (numOutputChannels, maxFrames);
    captured.clear();

    juce::AudioBuffer<float> block (numOutputChannels, blockSize);
    int written = 0;

    while (written < maxFrames && voice.getState() != CueVoice::State::finished)
    {
        const auto frames = juce::jmin (blockSize, maxFrames - written);
        block.clear();

        juce::AudioBuffer<float> view (block.getArrayOfWritePointers(), numOutputChannels, frames);
        voice.render (view, nullptr, 0, frames);

        for (int ch = 0; ch < numOutputChannels; ++ch)
            captured.copyFrom (ch, written, block, ch, 0, frames);

        written += frames;
    }

    captured.setSize (numOutputChannels, written, true, true, true);
    return captured;
}

VoiceSpec baseSpec (const SampleSource& source, int numOutputChannels)
{
    VoiceSpec spec;
    spec.cueId = juce::Uuid();
    spec.source = &source;
    spec.regionStart = 0;
    spec.regionEnd = source.getNumFrames();
    spec.gain = 1.0f;
    spec.numRoutes = juce::jmin (source.getNumChannels(), numOutputChannels);

    for (int i = 0; i < spec.numRoutes; ++i)
        spec.routes[i] = { i, i, 1.0f };

    return spec;
}

//==============================================================================
void testInAndOutPoints (const SampleSource& source)
{
    cptest::section ("in / out points");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (source, 2);
    spec.regionStart = 48000;    // 1.0 s
    spec.regionEnd   = 96000;    // 2.0 s

    voice.setSpec (spec);
    voice.triggerStart();

    const auto out = renderVoice (voice, 2, 200000);

    check (voice.getSoundedSamples() == 48000,
           "played exactly the trimmed region (got " + juce::String (voice.getSoundedSamples()) + " frames)");
    checkNear (indexFromValue (out.getSample (0, 0)), 48000.0, 0.5, "first sample is the in point");
    checkNear (indexFromValue (out.getSample (0, 47999)), 95999.0, 0.5, "last sample is one before the out point");
    checkNear (indexFromValue (out.getSample (0, 12345)), 60345.0, 0.5, "mid-region sample index is continuous");
    check (voice.getState() == CueVoice::State::finished, "voice finished at the out point");
}

void testPreWait (const SampleSource& source)
{
    cptest::section ("pre-wait");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (source, 2);
    spec.regionStart = 24000;
    spec.regionEnd   = 48000;
    spec.preWaitSamples = 12000;   // 0.25 s

    voice.setSpec (spec);
    voice.triggerStart();

    const auto out = renderVoice (voice, 2, 200000);

    check (voice.getSoundedSamples() == 24000, "the region still plays in full after a pre-wait");
    checkNear (out.getMagnitude (0, 0, 12000), 0.0, 1.0e-9, "pre-wait is silent");
    checkNear (indexFromValue (out.getSample (0, 12000)), 24000.0, 0.5,
               "audio starts at the in point on the first sample after the pre-wait");
    checkNear ((double) voice.getSoundedSamples(), 24000.0, 0.5,
               "sounded-sample count excludes the pre-wait");
}

void testFades (const SampleSource& source)
{
    cptest::section ("fade in / fade out");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (source, 2);
    spec.regionStart    = 0;
    spec.regionEnd      = 48000;
    spec.fadeInSamples  = 4800;    // 0.1 s
    spec.fadeInShape    = FadeShape::equalPower;
    spec.fadeOutSamples = 4800;
    spec.fadeOutShape   = FadeShape::linear;

    voice.setSpec (spec);
    voice.triggerStart();

    const auto out = renderVoice (voice, 2, 200000);

    check (voice.getSoundedSamples() == 48000, "fades do not change the length of the cue");
    checkNear (out.getSample (0, 0), 0.0, 1.0e-9, "fade-in starts at silence");

    // Divide the output back by the ramp value to recover the envelope at that sample.
    const auto envelopeAt = [&out] (int frame)
    {
        const auto dry = (double) frame / rampScale;
        return dry > 0.0 ? (double) out.getSample (0, frame) / dry : 0.0;
    };

    checkNear (envelopeAt (2400), std::sin (0.5 * juce::MathConstants<double>::halfPi), 0.002,
               "equal-power fade-in is at sin(pi/4) halfway through");
    checkNear (envelopeAt (4800), 1.0, 0.002, "fade-in reaches unity at its end");
    checkNear (envelopeAt (24000), 1.0, 0.002, "gain is unity between the fades");

    // Linear fade-out: 4800 samples before the end the envelope is 1, halfway it is 0.5.
    checkNear (envelopeAt (48000 - 2400), 0.5, 0.002, "linear fade-out is at 0.5 halfway through");
    checkNear (envelopeAt (48000 - 1), 1.0 / 4800.0, 0.002, "fade-out reaches silence at the out point");
}

void testLooping (const SampleSource& source)
{
    cptest::section ("looping");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (source, 2);
    spec.regionStart = 10000;
    spec.regionEnd   = 20000;      // 10000-sample region
    spec.loopEnabled = true;
    spec.loopCount   = 3;

    voice.setSpec (spec);
    voice.triggerStart();

    const auto out = renderVoice (voice, 2, 200000);

    check (voice.getSoundedSamples() == 30000, "a 3-pass loop plays the region three times");
    checkNear (indexFromValue (out.getSample (0, 0)), 10000.0, 0.5, "pass 1 starts at the in point");
    checkNear (indexFromValue (out.getSample (0, 9999)), 19999.0, 0.5, "pass 1 ends at the out point");
    checkNear (indexFromValue (out.getSample (0, 10000)), 10000.0, 0.5,
               "pass 2 begins on the very next sample - the loop has no gap");
    checkNear (indexFromValue (out.getSample (0, 20000)), 10000.0, 0.5, "pass 3 begins at the in point");
    check (voice.getPlayPassCount() == 3, "three passes were counted");

    // Infinite loop: should still be running well past three passes.
    CueVoice endless;
    endless.prepare (testRate, 256);
    spec.loopCount = 0;
    endless.setSpec (spec);
    endless.triggerStart();

    const auto forever = renderVoice (endless, 2, 100000);
    check (endless.getSoundedSamples() == 100000, "loopCount 0 loops forever");
    check (endless.getState() != CueVoice::State::finished, "an endless loop never finishes on its own");
    checkNear (indexFromValue (forever.getSample (0, 95000)), 10000.0 + (95000 % 10000), 0.5,
               "position stays correct deep into an endless loop");
}

void testVamp (const SampleSource& source)
{
    cptest::section ("vamp");

    // --- circles the vamp region until released ------------------------------
    {
        CueVoice voice;
        voice.prepare (testRate, 256);

        auto spec = baseSpec (source, 2);
        spec.regionStart = 0;
        spec.regionEnd   = 48000;
        spec.vampEnabled = true;
        spec.vampStart   = 10000;
        spec.vampEnd     = 14000;      // 4000-sample vamp
        spec.vampRelease = VampRelease::atEndOfPass;

        voice.setSpec (spec);
        voice.triggerStart();

        const auto out = renderVoice (voice, 2, 60000);

        check (voice.getSoundedSamples() == 60000, "an unreleased vamp keeps playing");
        check (voice.isVamping(), "voice reports that it is vamping");

        checkNear (indexFromValue (out.getSample (0, 9999)), 9999.0, 0.5, "plays up to the vamp out point");
        checkNear (indexFromValue (out.getSample (0, 14000)), 10000.0, 0.5,
                   "wraps back to the vamp in point with no gap");
        checkNear (indexFromValue (out.getSample (0, 18000)), 10000.0, 0.5, "second vamp pass wraps again");
        check (voice.getVampPassCount() >= 10, "vamp pass counter advances");
    }

    // --- "vamping" means circling, not merely armed --------------------------
    {
        CueVoice voice;
        voice.prepare (testRate, 256);

        auto spec = baseSpec (source, 2);
        spec.regionStart = 0;
        spec.regionEnd   = 48000;
        spec.vampEnabled = true;
        spec.vampStart   = 20000;
        spec.vampEnd     = 24000;

        voice.setSpec (spec);
        voice.triggerStart();

        // The vamp is armed from the first sample, but the play head is nowhere near it.
        // Reporting VAMP here would tell the operator the cue is holding when it is not.
        check (! voice.isVamping(), "a vamp that has not been reached yet is not reported");

        juce::AudioBuffer<float> warmup (2, 10000);
        warmup.clear();
        voice.render (warmup, nullptr, 0, 10000);
        check (! voice.isVamping(), "still not vamping half way to the vamp in point");

        warmup.clear();
        voice.render (warmup, nullptr, 0, 10000);   // now at sample 20000
        check (voice.isVamping(), "reports vamping once the play head reaches the region");
    }

    // --- release at end of pass ----------------------------------------------
    {
        CueVoice voice;
        voice.prepare (testRate, 256);

        auto spec = baseSpec (source, 2);
        spec.regionStart = 0;
        spec.regionEnd   = 48000;
        spec.vampEnabled = true;
        spec.vampStart   = 10000;
        spec.vampEnd     = 14000;
        spec.vampRelease = VampRelease::atEndOfPass;

        voice.setSpec (spec);
        voice.triggerStart();

        // Render 16000 frames: into the second vamp pass, at source index 12000.
        juce::AudioBuffer<float> warmup (2, 16000);
        warmup.clear();
        voice.render (warmup, nullptr, 0, 16000);
        checkNear (indexFromValue (warmup.getSample (0, 15999)), 11999.0, 0.5,
                   "mid-pass position before release");

        voice.requestVampRelease();

        const auto out = renderVoice (voice, 2, 60000);

        // It should finish the pass (reach 14000) and only then carry on past it.
        checkNear (indexFromValue (out.getSample (0, 0)), 12000.0, 0.5, "release does not jump the position");
        checkNear (indexFromValue (out.getSample (0, 1999)), 13999.0, 0.5, "plays out the rest of the pass");
        checkNear (indexFromValue (out.getSample (0, 2000)), 14000.0, 0.5,
                   "continues past the vamp out point instead of wrapping");
        check (! voice.isVamping(), "voice is no longer vamping after release");
        check (voice.getSoundedSamples() == 16000 + (48000 - 12000),
               "runs on to the cue's out point and stops");
    }

    // --- release immediately --------------------------------------------------
    {
        CueVoice voice;
        voice.prepare (testRate, 256);

        auto spec = baseSpec (source, 2);
        spec.regionStart = 0;
        spec.regionEnd   = 48000;
        spec.vampEnabled = true;
        spec.vampStart   = 10000;
        spec.vampEnd     = 14000;
        spec.vampRelease = VampRelease::immediately;

        voice.setSpec (spec);
        voice.triggerStart();

        juce::AudioBuffer<float> warmup (2, 16000);
        warmup.clear();
        voice.render (warmup, nullptr, 0, 16000);

        voice.requestVampRelease();

        const auto out = renderVoice (voice, 2, 60000);

        checkNear (indexFromValue (out.getSample (0, 0)), 12000.0, 0.5,
                   "immediate release carries straight on from where it was");
        checkNear (indexFromValue (out.getSample (0, 2500)), 14500.0, 0.5,
                   "runs through the vamp out point without wrapping");
        check (! voice.isVamping(), "immediate release clears the vamp at once");
    }
}

void testRouting (const SampleSource& stereo)
{
    cptest::section ("routing");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (stereo, 4);
    spec.regionStart = 0;
    spec.regionEnd   = 4800;

    // Deliberately crossed and trimmed: source L -> out 2 at -6 dB, source R -> out 0.
    spec.numRoutes = 2;
    spec.routes[0] = { 0, 2, 0.5f };
    spec.routes[1] = { 1, 0, 1.0f };

    voice.setSpec (spec);
    voice.triggerStart();

    const auto out = renderVoice (voice, 4, 10000);

    checkNear ((double) out.getSample (2, 1000), 1000.0 / rampScale * 0.5, 1.0e-9,
               "source L lands on output 2 at half gain");
    checkNear ((double) out.getSample (0, 1000), -1000.0 / rampScale, 1.0e-9,
               "source R lands on output 0 at unity");
    checkNear (out.getMagnitude (1, 0, out.getNumSamples()), 0.0, 1.0e-9, "output 1 stays silent");
    checkNear (out.getMagnitude (3, 0, out.getNumSamples()), 0.0, 1.0e-9, "output 3 stays silent");
}

void testScheduledStop (const SampleSource& source)
{
    cptest::section ("scheduled stop (crossfade timing)");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (source, 2);
    spec.regionStart = 0;
    spec.regionEnd   = 48000;

    voice.setSpec (spec);
    voice.triggerStart();

    // Begin a 2000-sample fade exactly at sounded sample 10000. Blocks are 256 samples,
    // so 10000 falls mid-block: this only passes if the run is split at the exact sample.
    voice.scheduleStop (10000, 2000, FadeShape::linear);

    const auto out = renderVoice (voice, 2, 60000);

    const auto envelopeAt = [&out] (int frame)
    {
        const auto dry = (double) frame / rampScale;
        return dry > 0.0 ? (double) out.getSample (0, frame) / dry : 0.0;
    };

    checkNear (envelopeAt (9999), 1.0, 0.002, "full gain right up to the scheduled sample");
    checkNear (envelopeAt (10000), 1.0, 0.002, "fade begins exactly at the scheduled sample");
    checkNear (envelopeAt (11000), 0.5, 0.003, "linear fade is halfway after half its length");
    check (voice.getSoundedSamples() == 12000, "voice finishes when the fade completes");
    check (voice.getState() == CueVoice::State::finished, "voice ends in the finished state");
}

void testReservedVoiceIsSilent (const SampleSource& source)
{
    cptest::section ("reserved voice does not leak stale audio");

    CueVoice voice;
    voice.prepare (testRate, 256);

    auto spec = baseSpec (source, 2);
    spec.regionStart = 20000;
    spec.regionEnd   = 24000;
    voice.setSpec (spec);
    voice.triggerStart();

    juce::AudioBuffer<float> first (2, 2000);
    first.clear();
    voice.render (first, nullptr, 0, 2000);
    voice.requestStop (0, FadeShape::linear);
    voice.recycle();

    // Claimed again but not started: it must contribute nothing, even though its old
    // position and envelope are still sitting in the object.
    voice.setSpec (spec);
    check (voice.getState() == CueVoice::State::reserved, "setSpec claims the voice");

    juce::AudioBuffer<float> second (2, 2000);
    second.clear();
    voice.render (second, nullptr, 0, 2000);

    checkNear (second.getMagnitude (0, 0, 2000), 0.0, 1.0e-9, "a reserved voice is silent");
}

void testResampledLoad (const juce::File& directory, juce::AudioFormatManager& formats)
{
    cptest::section ("sample-rate conversion on load");

    // A step, not a ramp, for this one. The windowed-sinc filter has about 1% of passband
    // gain error, so a ramp's amplitude and its timing are indistinguishable: an output
    // 1% low reads exactly like an output arriving 1% late. A step separates them --
    // where it lands measures time, how tall it settles measures gain.
    auto file = directory.getChildFile ("step_44k.wav");
    file.deleteFile();

    constexpr int frames = 44100;
    constexpr int stepAt = 22050;
    constexpr float stepLevel = 0.5f;

    juce::AudioBuffer<float> buffer (1, frames);
    buffer.clear();

    for (int i = stepAt; i < frames; ++i)
        buffer.setSample (0, i, stepLevel);

    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (file.createOutputStream().release(), 44100.0, 1, 32, {}, 0));
    writer->writeFromAudioSampleBuffer (buffer, 0, frames);
    writer.reset();

    juce::String error;
    auto source = SampleSource::load (file, 48000.0, formats, error);

    check (source != nullptr, "44.1 kHz file loads for a 48 kHz device (" + error + ")");

    if (source == nullptr)
        return;

    checkNear (source->getSampleRate(), 48000.0, 0.001, "resident buffer is at the device rate");
    checkNear ((double) source->getNumFrames(), 48000.0, 2.0, "one second stays one second");
    checkNear (source->getLengthSeconds(), 1.0, 0.001, "duration is preserved through conversion");
    checkNear (source->getOriginalSampleRate(), 44100.0, 0.001, "original rate is remembered");

    const auto* data = source->getReadPointer (0);
    const auto numFrames = (int) source->getNumFrames();

    // Where the step crosses half its height is its midpoint, and a linear-phase filter
    // puts that at exactly the original transition time.
    int crossing = -1;

    for (int i = 1; i < numFrames; ++i)
    {
        if (data[i] >= stepLevel * 0.5f)
        {
            crossing = i;
            break;
        }
    }

    const auto expectedCrossing = (double) stepAt * 48000.0 / 44100.0;   // 24000

    check (crossing > 0, "the step survives the conversion");
    checkNear ((double) crossing, expectedCrossing, 2.0,
               "the step lands at the right time - latency compensation is correct");

    // Settled level well past the transition. The tolerance is the filter's own passband
    // error (about 0.09 dB), not slack: tightening it would only make the test brittle.
    checkNear ((double) data[40000], (double) stepLevel, stepLevel * 0.02,
               "settled level is preserved to within the filter's passband error");
    checkNear ((double) data[4000], 0.0, 0.02,
               "silence before the step stays silent");

    file.deleteFile();
}


//==============================================================================
void testCueListEditing()
{
    cptest::section ("cue list editing");

    CueList list;

    Cue a; a.number = "1"; a.name = "Opening";
    Cue b; b.number = "2"; b.name = "Middle";
    Cue c; c.number = "3"; c.name = "Closing";

    const auto idA = a.id, idB = b.id, idC = c.id;

    list.insert (a);
    list.insert (b);
    list.insert (c);

    check (list.size() == 3, "three cues inserted");
    check (list.indexOfID (idB) == 1, "cue B is second");

    list.setSelectedIndex (2);
    list.setStandbyIndex (1);

    // Inserting above the cursors must not move them onto different cues.
    Cue inserted; inserted.name = "Inserted";
    list.insert (inserted, 0);

    check (list.size() == 4, "insert at the head grows the list");
    check (list.indexOfID (idC) == 3, "cue C shifted down");
    check (list.getSelectedIndex() == 3, "selection followed its cue");
    check (list.getStandbyIndex() == 2, "standby followed its cue");
    check (list.getStandbyCue() != nullptr && list.getStandbyCue()->id == idB,
           "standby still points at cue B");

    // Reordering must likewise keep the cursors on the same cues.
    list.setSelectedIndex (list.indexOfID (idA));
    list.move (list.indexOfID (idC), 0);

    check (list.indexOfID (idC) == 0, "cue C moved to the top");
    check (list.get (list.getSelectedIndex()) != nullptr
           && list.get (list.getSelectedIndex())->id == idA,
           "selection stayed on cue A across a reorder");

    list.removeByID (idC);
    check (list.size() == 3, "remove drops one cue");
    check (list.indexOfID (idC) == -1, "removed cue is gone");

    // Link resolution: a null target means "the next cue in the list".
    list.modifyByID (idA, [] (Cue& cue) { cue.link.mode = LinkMode::autoFollow; });
    const auto indexA = list.indexOfID (idA);
    const auto* target = list.resolveLinkTarget (indexA);
    check (target != nullptr && target->id == list.get (indexA + 1)->id,
           "a null link target resolves to the next cue");

    list.modifyByID (idA, [idB] (Cue& cue) { cue.link.target = idB; });
    target = list.resolveLinkTarget (indexA);
    check (target != nullptr && target->id == idB, "an explicit link target resolves to that cue");

    // Cue "3" was just removed, so the highest number still in the list is 2.
    check (list.suggestNextNumber() == "3", "next cue number follows the highest still in use");
}

void testShowRoundTrip (const juce::File& directory, const juce::File& audioFile)
{
    cptest::section ("show save / load round trip");

    Show original;
    auto& list = original.getCueList();

    Cue cue;
    cue.number = "12.5";
    cue.name = "Storm builds";
    cue.notes = "Hold the vamp until the door slams";
    cue.audioFile = audioFile;
    cue.fileDuration = 10.0;
    cue.fileChannels = 2;
    cue.fileSampleRate = 48000.0;
    cue.startTime = 1.25;
    cue.endTime = 8.75;
    cue.gainDb = -3.5;
    cue.preWait = 0.5;
    cue.fadeInTime = 2.0;
    cue.fadeInShape = FadeShape::sCurve;
    cue.fadeOutTime = 4.0;
    cue.fadeOutShape = FadeShape::logarithmic;
    cue.loopEnabled = true;
    cue.loopCount = 3;
    cue.vampEnabled = true;
    cue.vampStart = 3.0;
    cue.vampEnd = 5.5;
    cue.vampRelease = VampRelease::immediately;
    cue.link.mode = LinkMode::crossfade;
    cue.link.duration = 6.0;
    cue.link.shape = FadeShape::exponential;
    cue.routing = { { 0, 4, 0.5f }, { 1, 7, 0.25f } };

    const auto cueId = cue.id;

    Cue second;
    second.number = "13";
    second.name = "Aftermath";
    second.type = CueType::streaming;
    second.streaming.uri = "tidal:playlist:abc-123";
    second.streaming.displayName = "House playlist";
    second.streaming.shuffle = true;

    const auto secondId = second.id;

    list.insert (cue);
    list.insert (second);

    // Point the first cue's link at the second, so the id survives the round trip too.
    list.modifyByID (cueId, [secondId] (Cue& c) { c.link.target = secondId; });

    original.setMasterGainDb (-4.0);

    const auto showFile = directory.getChildFile ("round trip.cueshow");
    const auto saveError = original.save (showFile);

    check (saveError.isEmpty(), "show saves without error (" + saveError + ")");
    check (showFile.existsAsFile(), "show file exists on disk");
    check (! original.hasUnsavedChanges(), "saving clears the dirty flag");

    Show reloaded;
    const auto loadError = reloaded.load (showFile);

    check (loadError.isEmpty(), "show loads without error (" + loadError + ")");
    checkNear (reloaded.getMasterGainDb(), -4.0, 1.0e-9, "master gain round trips");
    check (reloaded.getCueList().size() == 2, "both cues round trip");

    const auto* r = reloaded.getCueList().findByID (cueId);
    check (r != nullptr, "cue id round trips");

    if (r != nullptr)
    {
        check (r->number == "12.5", "cue number round trips");
        check (r->name == "Storm builds", "name round trips");
        check (r->notes == "Hold the vamp until the door slams", "notes round trip");
        check (r->audioFile == audioFile, "audio file path round trips");
        checkNear (r->startTime, 1.25, 1.0e-9, "in point round trips");
        checkNear (r->endTime, 8.75, 1.0e-9, "out point round trips");
        checkNear (r->gainDb, -3.5, 1.0e-9, "gain round trips");
        checkNear (r->preWait, 0.5, 1.0e-9, "pre-wait round trips");
        checkNear (r->fadeInTime, 2.0, 1.0e-9, "fade-in time round trips");
        check (r->fadeInShape == FadeShape::sCurve, "fade-in shape round trips");
        check (r->fadeOutShape == FadeShape::logarithmic, "fade-out shape round trips");
        check (r->loopEnabled && r->loopCount == 3, "loop settings round trip");
        check (r->vampEnabled, "vamp enabled round trips");
        checkNear (r->vampStart, 3.0, 1.0e-9, "vamp start round trips");
        checkNear (r->vampEnd, 5.5, 1.0e-9, "vamp end round trips");
        check (r->vampRelease == VampRelease::immediately, "vamp release mode round trips");
        check (r->link.mode == LinkMode::crossfade, "link mode round trips");
        check (r->link.target == secondId, "link target id round trips");
        checkNear (r->link.duration, 6.0, 1.0e-9, "crossfade duration round trips");
        check (r->link.shape == FadeShape::exponential, "crossfade curve round trips");
        check (r->routing.size() == 2, "routing point count round trips");

        if (r->routing.size() == 2)
        {
            check (r->routing[0].sourceChannel == 0 && r->routing[0].outputChannel == 4,
                   "first crosspoint round trips");
            checkNear (r->routing[0].gain, 0.5, 1.0e-6, "first crosspoint gain round trips");
            check (r->routing[1].outputChannel == 7, "second crosspoint round trips");
        }
    }

    const auto* s = reloaded.getCueList().findByID (secondId);
    check (s != nullptr, "streaming cue round trips");

    if (s != nullptr)
    {
        check (s->type == CueType::streaming, "cue type round trips");
        check (s->streaming.uri == "tidal:playlist:abc-123", "streaming uri round trips");
        check (s->streaming.displayName == "House playlist", "streaming display name round trips");
        check (s->streaming.shuffle, "shuffle round trips");
    }

    // Audio paths are stored relative to the show, so a show folder can move machines.
    const auto json = showFile.loadFileAsString();
    check (! json.contains (audioFile.getFullPathName()),
           "audio path is stored relative to the show, not absolute");

    // A file that is not a show must be refused rather than silently loading as empty.
    auto bogus = directory.getChildFile ("not a show.cueshow");
    bogus.replaceWithText ("{\"format\":\"something else\"}");
    Show third;
    check (third.load (bogus).isNotEmpty(), "a foreign file is rejected with an error");
    bogus.deleteFile();

    showFile.deleteFile();
}

/// Saving over an existing show must never leave the venue with no show file.
///
/// Show::save used to finish with juce::File::moveFileTo, which unlinks the
/// destination before it moves anything, so there was a window on every save
/// where the show did not exist — and if the move then failed, the error path
/// deleted the replacement too, losing both copies. This is the one file a
/// venue often has only one of.
///
/// Note what is and is not provable here. The defect was a RACE WINDOW, not a
/// wrong end state: after moveFileTo returns, the file is back, so the
/// behavioural checks below pass with the bug present — they were tried against
/// it and did not fail. Nor does a read-only directory discriminate the two
/// calls, because the temp write fails first and save() returns before it ever
/// reaches the move. What actually distinguishes them is WHICH API is called,
/// so that is asserted directly, against the source.
void testShowSaveIsAtomic (const juce::File& directory)
{
    cptest::section ("show save replaces in one step");

    const auto showFile = directory.getChildFile ("atomic.cueshow");
    const auto temp = showFile.getSiblingFile (showFile.getFileName() + ".tmp");

    Show first;
    first.setMasterGainDb (-1.0);
    check (first.save (showFile).isEmpty(), "first save succeeds");
    const auto firstContents = showFile.loadFileAsString();

    // Save again over the top: the destination exists, which is the case that
    // went through deleteFile() before.
    Show second;
    second.setMasterGainDb (-9.0);
    check (second.save (showFile).isEmpty(), "saving over an existing show succeeds");
    check (showFile.existsAsFile(), "the show file still exists after being replaced");
    check (showFile.loadFileAsString() != firstContents, "the replacement actually landed");
    check (! temp.existsAsFile(), "no .tmp is left beside a successful save");

    Show reloaded;
    check (reloaded.load (showFile).isEmpty(), "the replaced show loads");
    checkNear (reloaded.getMasterGainDb(), -9.0, 1.0e-9, "the replaced show is the new one");

    // A save that cannot land must leave the existing show untouched, and must
    // say so rather than reporting success. (This fails at the temp write, not
    // at the replace — it is worth having, but it is not the atomicity check.)
    const auto locked = directory.getChildFile ("locked");
    locked.createDirectory();
    const auto lockedShow = locked.getChildFile ("keep me.cueshow");

    Show original;
    original.setMasterGainDb (-2.5);
    check (original.save (lockedShow).isEmpty(), "a show exists in the directory");
    const auto before = lockedShow.loadFileAsString();

    // setReadOnly succeeding does NOT mean the directory now refuses new files.
    // On Windows the read-only attribute on a *directory* is a marker the shell
    // uses for folder customisation; it does not stop a file being created
    // inside. The temp write therefore lands, the save reports success, and
    // these two assertions fail for a reason that has nothing to do with the
    // code under test. Prove the precondition by trying to create a file rather
    // than trusting the platform to enforce the attribute.
    const auto readOnlyIsEnforced = [&locked]
    {
        if (! locked.setReadOnly (true))
            return false;

        const auto probe = locked.getChildFile ("probe.tmp");
        const auto created = probe.create().wasOk();
        probe.deleteFile();
        return ! created;
    }();

    if (readOnlyIsEnforced)
    {
        Show attempt;
        attempt.setMasterGainDb (-7.5);
        const auto error = attempt.save (lockedShow);

        check (error.isNotEmpty(), "a save that cannot land reports an error");
        check (lockedShow.existsAsFile(), "a failed save leaves the show on disk");
        cptest::checkEqual (lockedShow.loadFileAsString(), before,
                            "a failed save leaves the show unchanged");
    }

    locked.setReadOnly (false);

    // The atomicity assertion proper. moveFileTo unlinks the destination first;
    // replaceFileIn does not. Nothing observable after the fact tells them
    // apart, so the requirement is pinned where it lives.
    const juce::File showSource { juce::String (SIMPLECUE_SOURCE_DIR) + "/Model/Show.cpp" };
    check (showSource.existsAsFile(), "Show.cpp is where the test expects it");

    if (showSource.existsAsFile())
    {
        const auto source = showSource.loadFileAsString();
        const auto saveBody = source.fromFirstOccurrenceOf ("juce::String Show::save", false, false)
                                    .upToFirstOccurrenceOf ("juce::String Show::load", false, false);

        // The CALL form only, so the comment above it may keep naming
        // moveFileTo to explain why it is not used.
        check (saveBody.contains ("replaceFileIn ("),
               "Show::save replaces the show with replaceFileIn");
        check (! saveBody.contains ("moveFileTo ("),
               "Show::save does not call moveFileTo, which unlinks the show first");
    }

    locked.deleteRecursively();
    showFile.deleteFile();
}

void testCueGeometry()
{
    cptest::section ("cue timing arithmetic");

    Cue cue;
    cue.fileDuration = 100.0;
    cue.startTime = 10.0;
    cue.endTime = 0.0;   // 0 means "to the end of the file"

    checkNear (cue.resolvedEndTime(), 100.0, 1.0e-9, "an unset out point resolves to the file end");
    checkNear (cue.trimmedLength(), 90.0, 1.0e-9, "trimmed length spans in to out");
    checkNear (cue.playbackLength(), 90.0, 1.0e-9, "playback length of a one-shot is its trim");

    cue.endTime = 40.0;
    checkNear (cue.playbackLength(), 30.0, 1.0e-9, "an explicit out point shortens the cue");

    cue.loopEnabled = true;
    cue.loopCount = 4;
    checkNear (cue.playbackLength(), 120.0, 1.0e-9, "a finite loop multiplies the length");

    cue.loopCount = 0;
    checkNear (cue.playbackLength(), 0.0, 1.0e-9, "an infinite loop has no stated length");

    cue.loopEnabled = false;
    cue.vampEnabled = true;
    cue.vampStart = 15.0;
    cue.vampEnd = 25.0;
    check (cue.hasUsableVamp(), "a vamp inside the trim is usable");
    checkNear (cue.playbackLength(), 0.0, 1.0e-9, "a vamp makes the length open-ended");

    cue.vampEnd = 90.0;   // past the out point
    check (! cue.hasUsableVamp(), "a vamp reaching past the out point is rejected");

    cue.vampStart = 5.0;  // before the in point
    cue.vampEnd = 20.0;
    check (! cue.hasUsableVamp(), "a vamp starting before the in point is rejected");

    // Default routing is a straight 1:1 map, clipped to whichever side runs out first.
    Cue stereo;
    const auto defaultRouting = stereo.effectiveRouting (2, 8);
    check (defaultRouting.size() == 2, "default routing maps every source channel");
    check (defaultRouting[0].outputChannel == 0 && defaultRouting[1].outputChannel == 1,
           "default routing is 1:1");

    const auto clipped = stereo.effectiveRouting (8, 2);
    check (clipped.size() == 2, "default routing is clipped to the available outputs");

    // Explicit routing referring to channels that no longer exist must be dropped, not
    // passed through to write past the end of an output buffer.
    Cue routed;
    routed.routing = { { 0, 1, 1.0f }, { 0, 99, 1.0f }, { 5, 0, 1.0f } };
    const auto valid = routed.effectiveRouting (2, 8);
    check (valid.size() == 1, "out-of-range crosspoints are discarded");
    check (valid[0].outputChannel == 1, "the in-range crosspoint survives");
}

} // namespace

//==============================================================================
/** Defined in ControlTests.cpp. */
void runControlTests();

int main()
{
    // ChangeBroadcaster posts through the message queue, so the model classes need a
    // MessageManager even in a console run.
    juce::ScopedJuceInitialiser_GUI juceInit;

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();

    auto directory = juce::File::getSpecialLocation (juce::File::tempDirectory)
                         .getChildFile ("simplecue-tests");
    directory.createDirectory();

    const auto stereoFile = writeRampFile (directory, 480000, 2);   // 10 s

    juce::String error;
    auto source = SampleSource::load (stereoFile, testRate, formats, error);

    if (source == nullptr)
    {
        std::printf ("could not load the test file: %s\n", error.toRawUTF8());
        return 1;
    }

    std::printf ("\nSimpleCue engine tests\n======================\n");

    testInAndOutPoints (*source);
    testPreWait (*source);
    testFades (*source);
    testLooping (*source);
    testVamp (*source);
    testRouting (*source);
    testScheduledStop (*source);
    testReservedVoiceIsSilent (*source);
    testResampledLoad (directory, formats);
    testCueGeometry();
    testCueListEditing();
    testShowRoundTrip (directory, stereoFile);
    testShowSaveIsAtomic (directory);

    source.reset();
    directory.deleteRecursively();

    runControlTests();

    std::printf ("\n%d checks, %d failures\n\n", cptest::checks, cptest::failures);
    return cptest::failures == 0 ? 0 : 1;
}
