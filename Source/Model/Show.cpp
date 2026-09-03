#include "Model/Show.h"

namespace cp
{

namespace
{
    constexpr int showFormatVersion = 1;
}

Show::Show()
{
    cueList.addChangeListener (this);
}

Show::~Show()
{
    cueList.removeChangeListener (this);
}

void Show::changeListenerCallback (juce::ChangeBroadcaster*)
{
    dirty = true;
    sendChangeMessage();
}

juce::String Show::getTitle() const
{
    return showFile.existsAsFile() ? showFile.getFileNameWithoutExtension()
                                   : juce::String ("Untitled show");
}

void Show::markClean()
{
    dirty = false;
    sendChangeMessage();
}

void Show::setMasterGainDb (double db)
{
    const auto clamped = juce::jlimit (-100.0, 12.0, db);

    if (std::abs (clamped - masterGainDb) < 1.0e-9)
        return;

    masterGainDb = clamped;
    dirty = true;
    sendChangeMessage();
}

void Show::setDefaultFadeInTime (double seconds)
{
    const auto clamped = juce::jlimit (0.0, 120.0, seconds);

    if (std::abs (clamped - defaultFadeInTime) < 1.0e-9)
        return;

    defaultFadeInTime = clamped;
    dirty = true;
    sendChangeMessage();
}

void Show::setDefaultFadeOutTime (double seconds)
{
    const auto clamped = juce::jlimit (0.0, 120.0, seconds);

    if (std::abs (clamped - defaultFadeOutTime) < 1.0e-9)
        return;

    defaultFadeOutTime = clamped;
    dirty = true;
    sendChangeMessage();
}

void Show::setDefaultFadeShape (FadeShape shape)
{
    if (shape == defaultFadeShape)
        return;

    defaultFadeShape = shape;
    dirty = true;
    sendChangeMessage();
}

void Show::applyDefaultsTo (Cue& cue) const
{
    cue.fadeInTime   = defaultFadeInTime;
    cue.fadeOutTime  = defaultFadeOutTime;
    cue.fadeInShape  = defaultFadeShape;
    cue.fadeOutShape = defaultFadeShape;
}

void Show::createNewShow()
{
    cueList.clear();
    showFile = juce::File();
    masterGainDb = 0.0;
    defaultFadeInTime = 0.0;
    defaultFadeOutTime = 0.0;
    defaultFadeShape = FadeShape::equalPower;
    dirty = false;
    sendChangeMessage();
}

juce::String Show::save (const juce::File& file)
{
    const auto target = file != juce::File() ? file : showFile;

    if (target == juce::File())
        return "No file to save to.";

    auto* root = new juce::DynamicObject();
    root->setProperty ("format",       "simplecue-show");
    root->setProperty ("version",      showFormatVersion);
    root->setProperty ("masterGainDb", masterGainDb);
    root->setProperty ("defaultFadeInTime",  defaultFadeInTime);
    root->setProperty ("defaultFadeOutTime", defaultFadeOutTime);
    root->setProperty ("defaultFadeShape",   toString (defaultFadeShape));
    root->setProperty ("cues",         cueList.toVar (target.getParentDirectory()));

    const auto json = juce::JSON::toString (juce::var (root), false);

    // Write to a sibling first so a failure part-way through cannot destroy the show
    // that is already on disk — this file is often the only copy at a venue.
    //
    // replaceFileIn, NOT moveFileTo. juce::File::moveFileTo unlinks the destination
    // before it moves anything (`if (! newFile.deleteFile()) return false;` then
    // moveInternal), so between those two calls the show does not exist on any
    // platform — which is exactly the window this comment claims does not exist.
    // replaceFileIn goes through replaceInternal: ReplaceFile on Windows, rename(2)
    // on POSIX, both of which put the new file over the old one in one step and
    // leave the old one intact if they fail.
    auto temp = target.getSiblingFile (target.getFileName() + ".tmp");
    temp.deleteFile();

    if (! temp.replaceWithText (json))
        return "Could not write to " + temp.getFullPathName();

    if (! temp.replaceFileIn (target))
    {
        // The temp is deliberately left behind. The old show is still on disk —
        // nothing has been unlinked — so the operator has both the original and
        // the show they just tried to save, and deleting the replacement here is
        // how a failed save used to destroy the second one.
        return "Could not replace " + target.getFullPathName()
             + " — the show you saved is in " + temp.getFullPathName();
    }

    showFile = target;
    dirty = false;
    sendChangeMessage();
    return {};
}

juce::String Show::load (const juce::File& file)
{
    if (! file.existsAsFile())
        return "Show file not found: " + file.getFullPathName();

    juce::var parsed;
    const auto result = juce::JSON::parse (file.loadFileAsString(), parsed);

    if (result.failed())
        return "Could not read show: " + result.getErrorMessage();

    // "cue-player-show" is what the format was called before the app was renamed. Shows
    // written then are otherwise identical, so there is no reason to refuse them.
    const auto format = parsed.getProperty ("format", {}).toString();

    if (format != "simplecue-show" && format != "cue-player-show")
        return "That does not look like a SimpleCue show file.";

    if ((int) parsed.getProperty ("version", 0) > showFormatVersion)
        return "That show was saved by a newer version of SimpleCue.";

    masterGainDb = juce::jlimit (-100.0, 12.0, (double) parsed.getProperty ("masterGainDb", 0.0));
    defaultFadeInTime  = juce::jlimit (0.0, 120.0, (double) parsed.getProperty ("defaultFadeInTime", 0.0));
    defaultFadeOutTime = juce::jlimit (0.0, 120.0, (double) parsed.getProperty ("defaultFadeOutTime", 0.0));
    defaultFadeShape   = fadeShapeFromString (parsed.getProperty ("defaultFadeShape", {}).toString());

    cueList.removeChangeListener (this);
    cueList.restoreFromVar (parsed.getProperty ("cues", {}), file.getParentDirectory());
    cueList.addChangeListener (this);

    showFile = file;
    dirty = false;
    sendChangeMessage();
    return {};
}

juce::Array<juce::File> Show::collectAudioFiles() const
{
    juce::Array<juce::File> files;

    for (const auto& cue : cueList.all())
        if (cue.type == CueType::audioFile && cue.audioFile != juce::File())
            files.addIfNotAlreadyThere (cue.audioFile);

    return files;
}

juce::Array<juce::Uuid> Show::findMissingFiles() const
{
    juce::Array<juce::Uuid> missing;

    for (const auto& cue : cueList.all())
        if (cue.type == CueType::audioFile && ! cue.audioFile.existsAsFile())
            missing.add (cue.id);

    return missing;
}

} // namespace cp
