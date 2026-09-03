#pragma once

#include <juce_core/juce_core.h>

#include "Model/ControlMessage.h"
#include "Model/CueTypes.h"
#include "Model/FadeCurve.h"
#include "Model/StreamingSettings.h"

namespace cp
{

//==============================================================================
/** How a cue hands over to the cue it is linked to.

    A link always has a target (an explicit cue, or "the next cue in the list" when the
    target id is null), a delay, and — for crossfade — a duration.
*/
enum class LinkMode
{
    none = 0,       ///< Nothing follows automatically.
    autoContinue,   ///< Fire the target when this cue *starts*, after `delay` seconds.
    autoFollow,     ///< Fire the target when this cue *finishes*, after `delay` seconds.
    crossfade       ///< Start the target `duration` seconds before this cue's out point,
                    ///< fading this cue out across the overlap.
};

juce::String toString (LinkMode mode);
LinkMode linkModeFromString (const juce::String& s);
juce::StringArray linkModeNames();

struct Link
{
    LinkMode  mode { LinkMode::none };
    juce::Uuid target { juce::Uuid::null() };   ///< Null means "the next cue in the list".
    double    delay { 0.0 };                    ///< Seconds. Ignored by crossfade.
    double    duration { 3.0 };                 ///< Crossfade length in seconds.
    FadeShape shape { FadeShape::equalPower };  ///< Curve used for the crossfade.

    bool targetsNextCue() const noexcept { return target.isNull(); }
};

juce::String toString (VampRelease r);
VampRelease vampReleaseFromString (const juce::String& s);

//==============================================================================
/** What the End step of a cue does when it is reached. */
enum class EndAction
{
    fadeOut = 0,   ///< Fade over endFadeTime.
    hardStop       ///< Cut immediately.
};

juce::String toString (EndAction);
EndAction endActionFromString (const juce::String&);
juce::StringArray endActionNames();

//==============================================================================
/** What a cue actually plays. */
enum class CueType
{
    audioFile = 0,  ///< A file on disk, decoded and mixed by our own engine.
    streaming,      ///< A track/album/playlist on a streaming service. See StreamingRef.
    control         ///< No audio at all: only the MIDI/OSC messages in outputMessages.
};

juce::String toString (CueType t);
CueType cueTypeFromString (const juce::String& s);

/** A reference to something playable on a streaming service.

    Only what genuinely belongs to *this cue*. Which service the account is on, which
    developer application it authenticates as and which loopback input the audio arrives on
    are properties of the installation, not of a cue, and live in StreamingSettings.
*/
struct StreamingRef
{
    /** Provider-native URI or a pasted share link — "spotify:playlist:37i9...", a TIDAL
        playlist uuid, a music.youtube.com URL. Normalised by the provider adapter. */
    juce::String uri;

    /** Cached human-readable label so the cue list reads sensibly offline. */
    juce::String displayName;

    bool shuffle { false };
    bool repeat  { false };
};

//==============================================================================
/** A cue: an audio file plus everything that decides how it plays and what follows it.

    Times are in seconds *within the source file*, not within the trimmed region, so
    moving the in point never invalidates the vamp markers.
*/
class Cue
{
public:
    Cue();

    //== Identity ==============================================================
    juce::Uuid   id;
    juce::String number;     ///< Operator-facing cue number. Free text: "12", "12.5", "PRE".
    juce::String name;
    juce::String notes;

    CueType      type { CueType::audioFile };

    //== Source ================================================================
    juce::File   audioFile;      ///< Used when type == audioFile.
    StreamingRef streaming;      ///< Used when type == streaming.

    /** In point, in seconds from the start of the file. */
    double startTime { 0.0 };

    /** Out point, in seconds from the start of the file. A value <= 0 means "end of file".
        Use resolvedEndTime() rather than reading this directly. */
    double endTime { 0.0 };

    /** File duration in seconds, cached when the file is scanned. 0 if not yet known. */
    double fileDuration { 0.0 };
    int    fileChannels { 0 };
    double fileSampleRate { 0.0 };

    //== Level =================================================================
    double gainDb { 0.0 };

    //== Timing ================================================================
    /** Silence inserted between GO and the first sample. Fades start after the pre-wait. */
    double preWait { 0.0 };

    //== Fades =================================================================
    double    fadeInTime { 0.0 };
    FadeShape fadeInShape { FadeShape::equalPower };
    double    fadeOutTime { 0.0 };
    FadeShape fadeOutShape { FadeShape::equalPower };

    //== Loop ==================================================================
    /** Repeats the whole in..out region. */
    bool loopEnabled { false };
    /** Number of times the region plays in total. 0 means loop forever until stopped. */
    int  loopCount { 0 };

    //== Vamp ==================================================================
    /** Loops the sub-region [vampStart, vampEnd] until the operator releases it, then
        carries on to the out point. */
    bool        vampEnabled { false };
    double      vampStart { 0.0 };
    double      vampEnd { 0.0 };
    VampRelease vampRelease { VampRelease::atEndOfPass };

    //== End of life ===========================================================
    /** How this cue's Fade/Stop sub-cue stops it. Every cue has one, because even a cue
        that would end by itself can be wanted out early. */
    EndAction endAction { EndAction::fadeOut };
    double    endFadeTime { 3.0 };

    /** Whether firing the cue itself also fires its Play sub-cue. On by default, which is
        what anyone expects of a cue. Turn it off to make the cue a container that does
        nothing until one of its sub-cues is fired. */
    bool firePlayWithCue { true };

    //== Link ==================================================================
    Link link;

    //== Outgoing control =====================================================
    /** MIDI and OSC messages sent when this cue fires. Available on every cue, so a sound
        cue can fly a lighting cue without a separate control cue beside it in the list;
        a cue of type `control` is simply one that has these and nothing else. */
    std::vector<ControlMessage> outputMessages;

    //== Routing ===============================================================
    /** Sparse source-channel -> output-channel matrix. Empty means "use the default",
        which is a straight 1:1 map of file channels onto the first device outputs. */
    std::vector<RoutePoint> routing;

    //==========================================================================
    /** Out point in seconds, resolving "<= 0 means end of file" against fileDuration. */
    double resolvedEndTime() const noexcept;

    /** Length of the trimmed region in seconds, before any looping or vamping. */
    double trimmedLength() const noexcept;

    /** Whether the vamp markers describe a usable region inside the trimmed range. */
    bool hasUsableVamp() const noexcept;

    /** Playing length in seconds *ignoring* vamp repeats (which are open-ended), including
        loop repeats when the loop count is finite. Returns 0 for an endless cue and for a
        control cue, which has no duration at all — check isOpenEnded() to tell them apart. */
    double playbackLength() const noexcept;

    /** True when nothing can predict when this cue finishes: a streaming cue, an armed
        vamp, or an infinite loop. Links from an open-ended cue cannot be pre-scheduled. */
    bool isOpenEnded() const noexcept;

    /** Builds the effective routing: `routing` when non-empty, otherwise a 1:1 default
        for @p numFileChannels onto @p numDeviceOutputs. */
    std::vector<RoutePoint> effectiveRouting (int numFileChannels, int numDeviceOutputs) const;

    /** True when the cue points at a file that exists and has been scanned. */
    bool isPlayable() const noexcept;

    //== Persistence ===========================================================
    /** Serialises to a JSON object. @p showDirectory, when valid, is used to store the
        audio path relative to the show file so shows stay portable. */
    juce::var toVar (const juce::File& showDirectory) const;

    /** Restores from a JSON object written by toVar(). */
    static Cue fromVar (const juce::var& v, const juce::File& showDirectory);
};

} // namespace cp
