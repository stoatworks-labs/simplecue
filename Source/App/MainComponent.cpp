#include "App/MainComponent.h"

#include "App/ScreenshotMode.h"
#include "Diag/Diag.h"

namespace cp
{

namespace
{
    const char* deviceStateKey = "audioDeviceState";
    const char* lastShowDirKey = "lastShowDirectory";
    const char* lastAudioDirKey = "lastAudioDirectory";
    const char* controlSettingsKey = "controlSettings";
    const char* streamingSettingsKey = "streamingSettings";
}

MainComponent::MainComponent (juce::ApplicationProperties& props)
    : properties (props)
{
    setOpaque (true);

    // ---- audio ---------------------------------------------------------------
    audioEngine.setCueList (&show.getCueList());

    std::unique_ptr<juce::XmlElement> savedState;

    if (auto* user = properties.getUserSettings())
        savedState = user->getXmlValue (deviceStateKey);

    if (const auto error = audioEngine.initialise (savedState.get()); error.isNotEmpty())
        reportError ("Audio device could not be opened.\n\n" + error);

    // ---- UI ------------------------------------------------------------------
    addAndMakeVisible (transportBar);
    addAndMakeVisible (cueListComponent);
    addAndMakeVisible (inspector);
    addAndMakeVisible (activeCues);
    addAndMakeVisible (verticalResizer);

    verticalLayout.setItemLayout (0, 120.0, -1.0, -0.55);   // cue list
    verticalLayout.setItemLayout (1, 6.0, 6.0, 6.0);        // resizer
    verticalLayout.setItemLayout (2, 160.0, -1.0, -0.45);   // inspector

    transportBar.onGo           = [this] { commandManager.invokeDirectly (CommandIDs::go, false); };
    transportBar.onStopAll      = [this] { audioEngine.stopAll (2.0); };
    transportBar.onPanic        = [this] { audioEngine.panic(); controlHub.cancelPendingMessages(); };
    transportBar.onPauseToggle  = [this] { audioEngine.setPaused (! audioEngine.isPaused()); };
    transportBar.onReleaseVamp  = [this] { audioEngine.releaseAllVamps(); };
    transportBar.onAudioSetup   = [this] { showAudioSetup(); };

    cueListComponent.onSelectionChanged = [this] (int index) { inspector.setCueIndex (index); };
    cueListComponent.onCueTriggered     = [this] (int index) { fireCueAsWhole (index); };
    cueListComponent.onFileRequested    = [this] (int index) { chooseFileForCue (index); };
    cueListComponent.onCueDeleteRequested = [this] (int index)
    {
        show.getCueList().setSelectedIndex (index);
        deleteSelectedCue();
    };

    inspector.onCueEdited    = [this] { cueListComponent.refresh(); updateWindowTitle(); };
    inspector.onFileRequested = [this] (int index) { chooseFileForCue (index); };

    // ---- control layer -------------------------------------------------------
    controlHub.setActionHandler (this);

    {
        auto settings = ControlSettings::createDefault();

        if (auto* user = properties.getUserSettings())
        {
            juce::var stored;

            if (juce::JSON::parse (user->getValue (controlSettingsKey), stored).wasOk()
                && stored.isObject())
                settings = ControlSettings::fromVar (stored);
        }

        if (const auto problems = controlHub.applySettings (settings); problems.isNotEmpty())
            reportError ("Control setup could not be fully applied.\n\n" + problems);
    }

    {
        StreamingSettings streaming;

        if (auto* user = properties.getUserSettings())
        {
            juce::var stored;

            if (juce::JSON::parse (user->getValue (streamingSettingsKey), stored).wasOk()
                && stored.isObject())
                streaming = StreamingSettings::fromVar (stored);
        }

        audioEngine.setStreamingSettings (streaming);
    }

    controlHub.onStatusRequested = [this]
    {
        ControlHub::StatusSnapshot snapshot;

        if (const auto* standby = show.getCueList().getStandbyCue())
        {
            snapshot.standbyNumber = standby->number;
            snapshot.standbyName = standby->name;
        }

        const auto active = audioEngine.getActiveCues();
        snapshot.numPlaying = (int) active.size();
        snapshot.paused = audioEngine.isPaused();
        snapshot.vamping = audioEngine.isAnythingVamping();
        snapshot.masterDb = audioEngine.getMasterGainDb();

        for (const auto& entry : active)
            snapshot.playingCueNumbers.add (entry.number);

        return snapshot;
    };

    // A cue's outgoing messages are scheduled against its pre-wait, so they land with the
    // first sample of audio rather than at the moment GO was pressed.
    audioEngine.onCueFired = [this] (const Cue& cue, double secondsUntilAudio)
    {
        controlHub.fireCueMessages (cue.outputMessages, secondsUntilAudio);
    };

    // ---- commands ------------------------------------------------------------
    commandManager.registerAllCommandsForTarget (this);
    addKeyListener (commandManager.getKeyMappings());
    setWantsKeyboardFocus (true);

    show.addChangeListener (this);
    sampleCache.addChangeListener (this);

    updateWindowTitle();
    startTimerHz (20);
    setSize (1280, 820);
}

MainComponent::~MainComponent()
{
    stopTimer();

    // A screenshot run rearranges the control settings on purpose; writing them back would
    // leave the operator listening on ports they never asked for.
    if (auto* user = properties.getUserSettings(); user != nullptr && ! screenshotMode)
    {
        if (auto state = audioEngine.createDeviceStateXml())
            user->setValue (deviceStateKey, state.get());

        user->setValue (controlSettingsKey, juce::JSON::toString (controlHub.getSettings().toVar(), true));
        user->setValue (streamingSettingsKey,
                        juce::JSON::toString (audioEngine.getStreamingSettings().toVar(), true));
    }

    if (screenshotAudioDirectory != juce::File())
        screenshotAudioDirectory.deleteRecursively();

    controlHub.setActionHandler (nullptr);
    audioEngine.onCueFired = nullptr;
    controlSetupWindow = nullptr;

    sampleCache.removeChangeListener (this);
    show.removeChangeListener (this);
    removeKeyListener (commandManager.getKeyMappings());
    audioSetupWindow = nullptr;
    audioEngine.shutdown();
}

void MainComponent::paint (juce::Graphics& g)
{
    g.fillAll (colours::background);
}

void MainComponent::resized()
{
    auto bounds = getLocalBounds();
    transportBar.setBounds (bounds.removeFromTop (transportHeight));
    activeCues.setBounds (bounds.removeFromRight (activeCuesWidth));

    Component* items[] = { &cueListComponent, &verticalResizer, &inspector };
    verticalLayout.layOutComponents (items, 3, bounds.getX(), bounds.getY(),
                                     bounds.getWidth(), bounds.getHeight(), true, true);
}

//==============================================================================
void MainComponent::timerCallback()
{
    const auto& list = show.getCueList();

    if (const auto* standby = list.getStandbyCue())
    {
        const auto name = standby->name.isNotEmpty() ? standby->name : juce::String ("(untitled)");
        const auto step = list.getStandbyStepInfo();

        // Naming the sub-cue matters: "Storm builds" alone does not tell the operator
        // whether the next GO starts it, releases its vamp or fades it out.
        transportBar.setStandbyText (standby->number,
                                     step.has_value() ? name + "   -   " + step->label : name);
    }
    else
    {
        transportBar.setStandbyText ("--", list.isEmpty() ? "No cues" : "End of list");
    }

    juce::StringArray status;
    status.add (show.getTitle() + (show.hasUnsavedChanges() ? " *" : ""));

    if (audioEngine.getSampleRate() > 0.0)
        status.add (juce::String (audioEngine.getSampleRate() / 1000.0, 1) + " kHz  "
                    + juce::String (audioEngine.getNumOutputChannels()) + " out");
    else
        status.add ("No audio device");

    if (const auto pending = sampleCache.getNumPending(); pending > 0)
        status.add ("loading " + juce::String (pending));
    else
        status.add (juce::String (sampleCache.getMemoryUsage() / (1024 * 1024)) + " MB loaded");

    if (const auto controlSummary = controlHub.getStatusSummary(); controlSummary.isNotEmpty())
        status.add (controlSummary);

    transportBar.setShowStatus (status.joinIntoString ("   |   "));

    publishControlStatus();

    // Track the play head of the selected cue on the waveform, if it happens to be running.
    if (const auto* selected = list.get (list.getSelectedIndex()))
    {
        double playhead = -1.0;

        for (const auto& active : audioEngine.getActiveCues())
            if (active.cueId == selected->id && ! active.inPreWait)
                playhead = active.position;

        inspector.setPlayheadTime (playhead);
    }
}

void MainComponent::changeListenerCallback (juce::ChangeBroadcaster* source)
{
    if (source == &show)
        updateWindowTitle();

    cueListComponent.refresh();
}

void MainComponent::updateWindowTitle()
{
    if (auto* window = findParentComponentOfClass<juce::DocumentWindow>())
        window->setName ("SimpleCue  -  " + show.getTitle()
                         + (show.hasUnsavedChanges() ? " *" : ""));
}

void MainComponent::reportError (const juce::String& message)
{
    juce::NativeMessageBox::showAsync (
        juce::MessageBoxOptions()
            .withIconType (juce::MessageBoxIconType::WarningIcon)
            .withTitle ("SimpleCue")
            .withMessage (message)
            .withButton ("OK")
            .withAssociatedComponent (this),
        nullptr);
}

//==============================================================================
void MainComponent::confirmDiscardChanges (std::function<void (bool)> callback)
{
    if (! show.hasUnsavedChanges())
    {
        callback (true);
        return;
    }

    juce::NativeMessageBox::showAsync (
        juce::MessageBoxOptions()
            .withIconType (juce::MessageBoxIconType::QuestionIcon)
            .withTitle ("Unsaved changes")
            .withMessage ("\"" + show.getTitle() + "\" has changes that have not been saved.")
            .withButton ("Save")
            .withButton ("Discard")
            .withButton ("Cancel")
            .withAssociatedComponent (this),
        // The callback receives the *index* of the button pressed, counted from zero in the
        // order they were added above - not 1, 2, 3. Getting that wrong made Discard open
        // the Save-as dialogue and made Cancel quit the app.
        [this, callback] (int buttonIndex)
        {
            enum { saveButton = 0, discardButton = 1, cancelButton = 2 };

            switch (buttonIndex)
            {
                case saveButton:
                    // Saving may need a filename first, so it finishes asynchronously and
                    // only then reports whether it is safe to carry on.
                    saveShow (false, [callback] (bool saved) { callback (saved); });
                    break;

                case discardButton:
                    callback (true);
                    break;

                case cancelButton:
                default:
                    callback (false);
                    break;
            }
        });
}

void MainComponent::newShow()
{
    confirmDiscardChanges ([this] (bool proceed)
    {
        if (! proceed)
            return;

        audioEngine.panic();
        show.createNewShow();
        sampleCache.clear();
        inspector.setCueIndex (-1);
        cueListComponent.refresh();
        updateWindowTitle();
    });
}

void MainComponent::openShow()
{
    confirmDiscardChanges ([this] (bool proceed)
    {
        if (! proceed)
            return;

        juce::File startIn;

        if (auto* user = properties.getUserSettings())
            startIn = juce::File (user->getValue (lastShowDirKey));

        fileChooser = std::make_unique<juce::FileChooser> ("Open show", startIn, Show::fileWildcard());
        fileChooser->launchAsync (juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectFiles,
            [this] (const juce::FileChooser& chooser)
            {
                const auto file = chooser.getResult();

                if (file.existsAsFile())
                    openShowFile (file);
            });
    });
}

void MainComponent::openShowFile (const juce::File& file)
{
    audioEngine.panic();

    if (const auto error = show.load (file); error.isNotEmpty())
    {
        reportError (error);
        return;
    }

    if (auto* user = properties.getUserSettings())
        user->setValue (lastShowDirKey, file.getParentDirectory().getFullPathName());

    audioEngine.setMasterGainDb (show.getMasterGainDb());
    sampleCache.retainOnly (show.collectAudioFiles());
    preloadShowAudio();

    inspector.setCueIndex (show.getCueList().getSelectedIndex());
    cueListComponent.refresh();
    updateWindowTitle();

    if (const auto missing = show.findMissingFiles(); ! missing.isEmpty())
        reportError (juce::String (missing.size())
                     + (missing.size() == 1 ? " cue refers to an audio file that is missing."
                                            : " cues refer to audio files that are missing.")
                     + "\n\nThey are marked MISSING in the cue list. Re-point them before the show.");
}

void MainComponent::saveShow (bool forceChooseFile, std::function<void (bool)> onComplete)
{
    // Always reports the outcome, however the save finished, so callers such as the
    // quit-time prompt can wait for a Save-as to complete before letting the app close.
    const auto report = [onComplete] (bool saved)
    {
        if (onComplete != nullptr)
            onComplete (saved);
    };

    if (! forceChooseFile && show.getFile() != juce::File())
    {
        show.setMasterGainDb (audioEngine.getMasterGainDb());

        if (const auto error = show.save(); error.isNotEmpty())
        {
            reportError (error);
            updateWindowTitle();
            report (false);
            return;
        }

        updateWindowTitle();
        report (true);
        return;
    }

    juce::File startIn;

    if (auto* user = properties.getUserSettings())
        startIn = juce::File (user->getValue (lastShowDirKey));

    fileChooser = std::make_unique<juce::FileChooser> ("Save show as", startIn, Show::fileWildcard());
    fileChooser->launchAsync (juce::FileBrowserComponent::saveMode
                                  | juce::FileBrowserComponent::canSelectFiles
                                  | juce::FileBrowserComponent::warnAboutOverwriting,
        [this, report] (const juce::FileChooser& chooser)
        {
            auto file = chooser.getResult();

            // Backing out of the file chooser is a cancellation, not a save.
            if (file == juce::File())
            {
                report (false);
                return;
            }

            if (! file.hasFileExtension (Show::fileExtension()))
                file = file.withFileExtension (Show::fileExtension());

            show.setMasterGainDb (audioEngine.getMasterGainDb());

            if (const auto error = show.save (file); error.isNotEmpty())
            {
                reportError (error);
                report (false);
                return;
            }

            if (auto* user = properties.getUserSettings())
                user->setValue (lastShowDirKey, file.getParentDirectory().getFullPathName());

            updateWindowTitle();
            report (true);
        });
}

//==============================================================================
void MainComponent::scanFileInto (Cue& cue, const juce::File& file)
{
    // Only touches the source and its trim. Fades and everything else the caller may have
    // set from the show's defaults are left alone.
    cue.audioFile = file;
    cue.fileDuration = 0.0;
    cue.fileChannels = 0;
    cue.fileSampleRate = 0.0;

    std::unique_ptr<juce::AudioFormatReader> reader (
        sampleCache.getFormatManager().createReaderFor (file));

    if (reader == nullptr)
        return;

    cue.fileSampleRate = reader->sampleRate;
    cue.fileChannels   = (int) reader->numChannels;
    cue.fileDuration   = reader->sampleRate > 0.0
                             ? (double) reader->lengthInSamples / reader->sampleRate : 0.0;

    // A fresh file gets the whole of itself as its region; trims are the operator's to make.
    cue.startTime = 0.0;
    cue.endTime   = 0.0;

    if (cue.name.isEmpty())
        cue.name = file.getFileNameWithoutExtension();
}

void MainComponent::addCueFromFile (const juce::File& file, int insertAt)
{
    Cue cue;
    cue.number = show.getCueList().suggestNextNumber();
    show.applyDefaultsTo (cue);
    scanFileInto (cue, file);

    const auto index = show.getCueList().insert (std::move (cue), insertAt);
    show.getCueList().setSelectedIndex (index);

    if (show.getCueList().getStandbyIndex() < 0)
        show.getCueList().setStandbyIndex (0);

    sampleCache.request (file);
    inspector.setCueIndex (index);
    cueListComponent.selectRow (index);
}

void MainComponent::addStreamingCue()
{
    Cue cue;
    cue.type = CueType::streaming;
    cue.number = show.getCueList().suggestNextNumber();
    show.applyDefaultsTo (cue);
    cue.name = "Streaming cue";

    const auto index = show.getCueList().insert (std::move (cue));
    show.getCueList().setSelectedIndex (index);
    inspector.setCueIndex (index);
    cueListComponent.selectRow (index);

    if (! audioEngine.areInputChannelsEnabled()
        && audioEngine.getStreamingSettings().audioPath == StreamingAudioPath::localCapture)
        reportError ("Streaming cues capture the service's audio from a loopback input.\n\n"
                     "Turn inputs on in Audio setup, point the service's desktop app at a "
                     "loopback device (BlackHole, VB-Cable, or a PipeWire/JACK sink), then "
                     "choose that device's channels in Settings.");
}

void MainComponent::chooseFileForCue (int index)
{
    juce::File startIn;

    if (auto* user = properties.getUserSettings())
        startIn = juce::File (user->getValue (lastAudioDirKey));

    fileChooser = std::make_unique<juce::FileChooser> ("Choose audio for this cue", startIn,
                                                       sampleCache.getWildcardFilter());
    fileChooser->launchAsync (juce::FileBrowserComponent::openMode
                                  | juce::FileBrowserComponent::canSelectFiles,
        [this, index] (const juce::FileChooser& chooser)
        {
            const auto file = chooser.getResult();

            if (! file.existsAsFile())
                return;

            if (auto* user = properties.getUserSettings())
                user->setValue (lastAudioDirKey, file.getParentDirectory().getFullPathName());

            show.getCueList().modify (index, [this, file] (Cue& cue) { scanFileInto (cue, file); });
            sampleCache.request (file);
            inspector.refresh();
            cueListComponent.refresh();
        });
}

void MainComponent::deleteSelectedCue()
{
    auto& list = show.getCueList();
    const auto index = list.getSelectedIndex();

    if (const auto* cue = list.get (index))
    {
        audioEngine.stopCue (cue->id, 0.0);
        list.remove (index);
        inspector.setCueIndex (list.getSelectedIndex());
        cueListComponent.refresh();
    }
}

void MainComponent::duplicateSelectedCue()
{
    auto& list = show.getCueList();
    const auto index = list.getSelectedIndex();

    if (const auto* original = list.get (index))
    {
        Cue copy = *original;
        copy.id = juce::Uuid();                     // A duplicate is a different cue.
        copy.number = list.suggestNextNumber();
        copy.name = original->name + " copy";

        const auto newIndex = list.insert (std::move (copy), index + 1);
        list.setSelectedIndex (newIndex);
        inspector.setCueIndex (newIndex);
        cueListComponent.selectRow (newIndex);
    }
}

void MainComponent::moveSelectedCue (int delta)
{
    auto& list = show.getCueList();
    const auto from = list.getSelectedIndex();
    const auto to = from + delta;

    if (from < 0 || ! juce::isPositiveAndBelow (to, list.size()))
        return;

    list.move (from, to);
    list.setSelectedIndex (to);
    inspector.setCueIndex (to);
    cueListComponent.selectRow (to);
}

void MainComponent::renumberCues()
{
    auto& list = show.getCueList();

    for (int i = 0; i < list.size(); ++i)
        list.modify (i, [i] (Cue& cue) { cue.number = juce::String (i + 1); });

    cueListComponent.refresh();
    inspector.refresh();
}

void MainComponent::showAudioSetup()
{
    if (audioSetupWindow != nullptr)
    {
        audioSetupWindow->toFront (true);
        return;
    }

    audioSetupWindow = std::make_unique<AudioSetupWindow> (audioEngine);
    audioSetupWindow->onClose = [this] { audioSetupWindow = nullptr; };
}

void MainComponent::preloadShowAudio()
{
    for (const auto& file : show.collectAudioFiles())
        sampleCache.request (file);
}



//==============================================================================
void MainComponent::loadDemoShow()
{
    // Borrows the screenshot flag: both build a throwaway demo state, and neither may be
    // written back over the ports and devices the operator actually uses.
    screenshotMode = true;

    screenshotAudioDirectory = juce::File::getSpecialLocation (juce::File::tempDirectory)
                                   .getChildFile ("simplecue-demo-audio");

    const auto audioFiles = screenshots::writeDemoAudio (screenshotAudioDirectory);
    screenshots::buildDemoShow (show, audioFiles);
    controlHub.applySettings (screenshots::demoControlSettings());

    for (const auto& file : audioFiles)
        sampleCache.request (file);

    inspector.setCueIndex (show.getCueList().getSelectedIndex());
    cueListComponent.refresh();

    // Well down, but not silent. Fully muted would leave the output meters flat, and a
    // screenshot of dead meters reads as a bug rather than as a quiet moment. The demo
    // audio is synthesised at a modest level, so this lands around -20 dBFS: audible if
    // the machine's output is up, but not a shock.
    audioEngine.setMasterGainDb (-18.0);
}

//==============================================================================
void MainComponent::captureScreenshots (const juce::File& outputDir, std::function<void()> onComplete)
{
    outputDir.createDirectory();
    loadDemoShow();

    // The waveform thumbnail and the sample cache both load on background threads, so the
    // capture has to wait for them rather than photographing a half-drawn window.
    juce::Timer::callAfterDelay (2500, [this, outputDir, onComplete]
    {
        // Fire a few cues so the list and the running panel show real playback state.
        audioEngine.go (0);
        audioEngine.go (2);

        juce::Timer::callAfterDelay (3000, [this, outputDir, onComplete]
        {
            cueListComponent.refresh();
            inspector.refresh();

            screenshots::capture (*this, outputDir.getChildFile ("main-window.png"));

            showControlSetup();

            juce::Timer::callAfterDelay (900, [this, outputDir, onComplete]
            {
                if (controlSetupWindow != nullptr)
                    if (auto* content = controlSetupWindow->getContentComponent())
                        screenshots::capture (*content, outputDir.getChildFile ("control-setup.png"));

                controlSetupWindow = nullptr;
                showAudioSetup();

                juce::Timer::callAfterDelay (900, [this, outputDir, onComplete]
                {
                    if (audioSetupWindow != nullptr)
                        if (auto* content = audioSetupWindow->getContentComponent())
                            screenshots::capture (*content, outputDir.getChildFile ("audio-setup.png"));

                    audioSetupWindow = nullptr;
                    showSettings();

                    juce::Timer::callAfterDelay (900, [this, outputDir, onComplete]
                    {
                        if (settingsWindow != nullptr)
                            if (auto* content = settingsWindow->getContentComponent())
                                screenshots::capture (*content, outputDir.getChildFile ("settings.png"));

                        settingsWindow = nullptr;
                        audioEngine.panic();

                        juce::Timer::callAfterDelay (300, [onComplete]
                        {
                            if (onComplete != nullptr)
                                onComplete();
                        });
                    });
                });
            });
        });
    });
}

//==============================================================================


bool MainComponent::fireCueAsWhole (int index)
{
    const auto* cue = show.getCueList().get (index);

    if (cue == nullptr)
        return false;

    // A cue with its Play sub-cue detached is a container: triggering it from outside must
    // not sneak the audio in anyway, or the setting would only work for GO.
    if (! cue->firePlayWithCue)
    {
        show.getCueList().setStandbyIndex (index);
        cueListComponent.refresh();
        return true;
    }

    return audioEngine.go (index);
}

bool MainComponent::fireStandbyStep()
{
    auto& list = show.getCueList();
    const auto index = list.getStandbyIndex();
    const auto* cue = list.get (index);

    if (cue == nullptr)
        return false;

    const auto steps = list.stepsFor (index);
    const auto stepIndex = list.getStandbyStep();
    const auto cueId = cue->id;

    // Standby on the cue itself: firing it plays the cue, unless the operator has turned
    // that off and made the cue a container that does nothing on its own.
    if (stepIndex == cueHeaderStep)
    {
        const auto played = cue->firePlayWithCue ? audioEngine.go (index) : true;

        list.advanceStandby();
        cueListComponent.refresh();
        publishControlStatus();
        return played;
    }

    if (! juce::isPositiveAndBelow (stepIndex, (int) steps.size()))
        return false;
    const auto endAction = cue->endAction;
    const auto endFade = cue->endFadeTime;
    bool performed = true;

    switch (steps[(size_t) stepIndex].type)
    {
        case CueStepType::play:
            performed = audioEngine.go (index);
            break;

        case CueStepType::devamp:
            audioEngine.releaseVamp (cueId);
            break;

        case CueStepType::end:
            audioEngine.stopCue (cueId, endAction == EndAction::hardStop ? 0.0 : endFade);
            break;
    }

    // Standby moves on even when the step could not be performed - a missing file should
    // not wedge the operator on the same step for the rest of the show.
    list.advanceStandby();
    cueListComponent.refresh();
    publishControlStatus();
    return performed;
}

void MainComponent::publishControlStatus()
{
    if (controlHub.onStatusRequested != nullptr)
        controlHub.publishStatus (controlHub.onStatusRequested());
}

int MainComponent::resolveControlTarget (const ControlAction& action) const
{
    const auto& list = show.getCueList();

    // DMX can only count, so it addresses cues by position. Everything else uses the
    // number printed on the cue sheet, which is what an operator would quote.
    if (action.cueIndex >= 0)
        return juce::isPositiveAndBelow (action.cueIndex, list.size()) ? action.cueIndex : -1;

    if (action.cueNumber.isEmpty())
        return -1;

    const auto wanted = action.cueNumber.trim();

    // Exact first, so a show that deliberately distinguishes "a1" from "A1"
    // still resolves each to itself.
    for (int i = 0; i < list.size(); ++i)
        if (const auto* cue = list.get (i); cue != nullptr && cue->number.trim() == wanted)
            return i;

    // Then ignoring case: cue numbers are free text off a cue sheet ("PRE",
    // "A1", "Q3"), and an operator typing /cue/pre/go at a tablet should not
    // have to reproduce the capitalisation of the cue list to fire a cue.
    for (int i = 0; i < list.size(); ++i)
        if (const auto* cue = list.get (i);
            cue != nullptr && cue->number.trim().equalsIgnoreCase (wanted))
            return i;

    // Cue numbers are free text, so "12.50" from a lighting desk should still find "12.5".
    for (int i = 0; i < list.size(); ++i)
        if (const auto* cue = list.get (i);
            cue != nullptr && cue->number.trim().getDoubleValue() == wanted.getDoubleValue()
            && wanted.containsAnyOf ("0123456789"))
            return i;

    return -1;
}

void MainComponent::performControlAction (const ControlAction& action)
{
    jassert (juce::MessageManager::existsAndIsCurrentThread());

    auto& list = show.getCueList();

    const auto withTargetCue = [this, &action] (const std::function<void (int)>& fn)
    {
        const auto index = resolveControlTarget (action);

        if (index < 0)
        {
            // Worth saying out loud: a desk firing a cue number that is not in the show is
            // a cue that silently does not happen, which is the worst kind of failure.
            controlHub.getOsc().broadcast ("/status/error",
                { "No cue matching \"" + action.cueNumber + "\"" });
            return;
        }

        fn (index);
    };

    switch (action.type)
    {
        case ControlActionType::go:
            fireStandbyStep();
            break;

        case ControlActionType::goCue:
            withTargetCue ([this] (int index) { fireCueAsWhole (index); });
            break;

        case ControlActionType::stopAll:
            audioEngine.stopAll (juce::jmax (0.0, action.value));
            break;

        case ControlActionType::stopCue:
            withTargetCue ([this, &action, &list] (int index)
            {
                if (const auto* cue = list.get (index))
                    audioEngine.stopCue (cue->id, juce::jmax (0.0, action.value));
            });
            break;

        case ControlActionType::panic:
            audioEngine.panic();
            controlHub.cancelPendingMessages();
            break;

        case ControlActionType::pause:       audioEngine.setPaused (true); break;
        case ControlActionType::resume:      audioEngine.setPaused (false); break;
        case ControlActionType::pauseToggle: audioEngine.setPaused (! audioEngine.isPaused()); break;

        case ControlActionType::releaseVamp:
            audioEngine.releaseAllVamps();
            break;

        case ControlActionType::releaseVampCue:
            withTargetCue ([this, &list] (int index)
            {
                if (const auto* cue = list.get (index))
                    audioEngine.releaseVamp (cue->id);
            });
            break;

        case ControlActionType::standbyCue:
            withTargetCue ([&list] (int index) { list.setStandbyIndex (index); });
            break;

        case ControlActionType::standbyNext:
            list.setStandbyIndex (list.getStandbyIndex() + 1);
            break;

        case ControlActionType::standbyPrevious:
            list.setStandbyIndex (list.getStandbyIndex() - 1);
            break;

        case ControlActionType::selectCue:
            withTargetCue ([this, &list] (int index)
            {
                list.setSelectedIndex (index);
                inspector.setCueIndex (index);
                cueListComponent.selectRow (index);
            });
            break;

        case ControlActionType::auditionCue:
            withTargetCue ([this, &list] (int index)
            {
                if (const auto* cue = list.get (index))
                    audioEngine.audition (*cue, cue->startTime);
            });
            break;

        case ControlActionType::masterLevel:
            audioEngine.setMasterGainDb (action.value);
            break;

        case ControlActionType::none:
        default:
            return;
    }

    cueListComponent.refresh();
    publishControlStatus();
}

void MainComponent::addControlCue()
{
    Cue cue;
    cue.type = CueType::control;
    cue.number = show.getCueList().suggestNextNumber();
    cue.name = "Control cue";

    ControlMessage message;
    message.type = ControlMessageType::osc;
    cue.outputMessages.push_back (message);

    const auto index = show.getCueList().insert (std::move (cue));
    show.getCueList().setSelectedIndex (index);
    inspector.setCueIndex (index);
    cueListComponent.selectRow (index);
}


void MainComponent::saveStreamingSettings()
{
    if (auto* user = properties.getUserSettings())
        user->setValue (streamingSettingsKey,
                        juce::JSON::toString (audioEngine.getStreamingSettings().toVar(), true));
}

void MainComponent::showAbout()
{
    // A child of this component rather than a DocumentWindow: it covers the
    // whole window, dismisses on Escape or a click outside, and does not put a
    // second entry in the OS window list for a dialog with four links in it.
    if (aboutPanel.getParentComponent() == nullptr)
    {
        addChildComponent (aboutPanel);
        aboutPanel.setAlwaysOnTop (true);
    }

    aboutPanel.setBounds (getLocalBounds());
    aboutPanel.setVisible (true);
}

void MainComponent::showSettings()
{
    if (settingsWindow != nullptr)
    {
        settingsWindow->toFront (true);
        return;
    }

    settingsWindow = std::make_unique<SettingsWindow> (
        audioEngine.getStreamingSettings(), show,
        [this] (const StreamingSettings& updated)
        {
            audioEngine.setStreamingSettings (updated);
            saveStreamingSettings();
            inspector.refresh();
        });

    settingsWindow->onClose = [this] { settingsWindow = nullptr; };
}

void MainComponent::showControlSetup()
{
    if (controlSetupWindow != nullptr)
    {
        controlSetupWindow->toFront (true);
        return;
    }

    controlSetupWindow = std::make_unique<ControlSetupWindow> (controlHub, [this]
    {
        // Never write settings during a screenshot run: those are demo values, and the
        // operator's real ports and devices must survive regenerating the docs.
        if (screenshotMode)
            return;

        if (auto* user = properties.getUserSettings())
            user->setValue (controlSettingsKey,
                            juce::JSON::toString (controlHub.getSettings().toVar(), true));
    });

    controlSetupWindow->onClose = [this] { controlSetupWindow = nullptr; };
}

//==============================================================================
bool MainComponent::isInterestedInFileDrag (const juce::StringArray& files)
{
    for (const auto& path : files)
    {
        const juce::File file (path);

        if (file.hasFileExtension (Show::fileExtension()))
            return true;

        if (sampleCache.getFormatManager().findFormatForFileExtension (file.getFileExtension()) != nullptr)
            return true;
    }

    return false;
}

void MainComponent::filesDropped (const juce::StringArray& files, int, int)
{
    juce::StringArray audioFiles;

    for (const auto& path : files)
    {
        const juce::File file (path);

        if (file.hasFileExtension (Show::fileExtension()))
        {
            openShowFile (file);
            return;
        }

        if (sampleCache.getFormatManager().findFormatForFileExtension (file.getFileExtension()) != nullptr)
            audioFiles.add (path);
    }

    // Drop order is what the operator sees, so keep it rather than sorting.
    for (const auto& path : audioFiles)
        addCueFromFile (juce::File (path));
}

//==============================================================================
namespace
{
// Plain menu item IDs, not ApplicationCommands: these two are not bound to
// keys, do not appear in a toolbar, and have no enabled/disabled state to
// track, so a command would be ceremony around a single call.
enum HelpMenuIDs
{
    collectDiagnosticsItem = 9001,
    openLogFolderItem      = 9002
};
} // namespace

juce::StringArray MainComponent::getMenuBarNames()
{
    return { "File", "Cue", "Transport", "Audio", "Help" };
}

juce::PopupMenu MainComponent::getMenuForIndex (int index, const juce::String&)
{
    juce::PopupMenu menu;

    switch (index)
    {
        case 0:
            menu.addCommandItem (&commandManager, CommandIDs::newShow);
            menu.addCommandItem (&commandManager, CommandIDs::openShow);
            menu.addSeparator();
            menu.addCommandItem (&commandManager, CommandIDs::saveShow);
            menu.addCommandItem (&commandManager, CommandIDs::saveShowAs);
            break;

        case 1:
            menu.addCommandItem (&commandManager, CommandIDs::addCue);
            menu.addCommandItem (&commandManager, CommandIDs::addStreamingCue);
            menu.addCommandItem (&commandManager, CommandIDs::addControlCue);
            menu.addSeparator();
            menu.addCommandItem (&commandManager, CommandIDs::duplicateCue);
            menu.addCommandItem (&commandManager, CommandIDs::deleteCue);
            menu.addSeparator();
            menu.addCommandItem (&commandManager, CommandIDs::moveCueUp);
            menu.addCommandItem (&commandManager, CommandIDs::moveCueDown);
            menu.addCommandItem (&commandManager, CommandIDs::renumberCues);
            break;

        case 2:
            menu.addCommandItem (&commandManager, CommandIDs::go);
            menu.addCommandItem (&commandManager, CommandIDs::releaseVamp);
            menu.addSeparator();
            menu.addCommandItem (&commandManager, CommandIDs::pauseResume);
            menu.addCommandItem (&commandManager, CommandIDs::stopAll);
            menu.addCommandItem (&commandManager, CommandIDs::panic);
            menu.addSeparator();
            menu.addCommandItem (&commandManager, CommandIDs::auditionCue);
            menu.addCommandItem (&commandManager, CommandIDs::setStandbyToSelected);
            menu.addCommandItem (&commandManager, CommandIDs::standbyPrevious);
            menu.addCommandItem (&commandManager, CommandIDs::standbyNext);
            break;

        case 3:
            menu.addCommandItem (&commandManager, CommandIDs::showAudioSetup);
            menu.addCommandItem (&commandManager, CommandIDs::showControlSetup);
            menu.addSeparator();
            menu.addCommandItem (&commandManager, CommandIDs::showSettings);
            break;

        case 4:
            menu.addCommandItem (&commandManager, CommandIDs::showAbout);
            menu.addSeparator();
            menu.addItem (collectDiagnosticsItem, "Collect Diagnostics...");
            menu.addItem (openLogFolderItem, "Open Log Folder");
            break;

        default:
            break;
    }

    return menu;
}

void MainComponent::menuItemSelected (int menuItemID, int)
{
    if (menuItemID == collectDiagnosticsItem)
        collectDiagnostics();
    else if (menuItemID == openLogFolderItem)
        cp::diag::logDirectory().revealToUser();
}

void MainComponent::collectDiagnostics()
{
    const auto bundle = cp::diag::collectDiagnostics();

    if (bundle == juce::File())
    {
        juce::NativeMessageBox::showAsync (
            juce::MessageBoxOptions()
                .withIconType (juce::MessageBoxIconType::WarningIcon)
                .withTitle ("Could not collect diagnostics")
                .withMessage ("Nothing could be written to "
                              + cp::diag::logDirectory().getFullPathName())
                .withButton ("OK"),
            nullptr);
        return;
    }

    CP_LOG_INFO ("diagnostics bundle written to " + bundle.getFullPathName());

    // A dialog cannot be copied out of, and nobody retypes a path — so put it
    // on the clipboard and reveal the file as well.
    juce::SystemClipboard::copyTextToClipboard (bundle.getFullPathName());
    bundle.revealToUser();

    juce::NativeMessageBox::showAsync (
        juce::MessageBoxOptions()
            .withIconType (juce::MessageBoxIconType::InfoIcon)
            .withTitle ("Diagnostics collected")
            .withMessage ("Written to:\n" + bundle.getFullPathName()
                          + "\n\nThe path has been copied to your clipboard. Attach that "
                            "file to a bug report - it holds the logs, the settings (with "
                            "any passwords removed) and details of any recent crash.")
            .withButton ("OK"),
        nullptr);
}

//==============================================================================
juce::ApplicationCommandTarget* MainComponent::getNextCommandTarget()
{
    return findFirstTargetParentComponent();
}

void MainComponent::getAllCommands (juce::Array<juce::CommandID>& commands)
{
    commands.addArray ({
        CommandIDs::newShow, CommandIDs::openShow, CommandIDs::saveShow, CommandIDs::saveShowAs,
        CommandIDs::addCue, CommandIDs::addStreamingCue, CommandIDs::addControlCue,
        CommandIDs::duplicateCue,
        CommandIDs::deleteCue, CommandIDs::moveCueUp, CommandIDs::moveCueDown,
        CommandIDs::renumberCues,
        CommandIDs::go, CommandIDs::stopAll, CommandIDs::panic, CommandIDs::pauseResume,
        CommandIDs::releaseVamp, CommandIDs::auditionCue,
        CommandIDs::setStandbyToSelected, CommandIDs::standbyPrevious, CommandIDs::standbyNext,
        CommandIDs::showAudioSetup, CommandIDs::showControlSetup,
        CommandIDs::showSettings, CommandIDs::showAbout });
}

void MainComponent::getCommandInfo (juce::CommandID commandID, juce::ApplicationCommandInfo& info)
{
    using juce::KeyPress;
    const auto cmd = juce::ModifierKeys::commandModifier;
    const auto shiftCmd = juce::ModifierKeys::commandModifier | juce::ModifierKeys::shiftModifier;

    const auto hasSelection = show.getCueList().getSelectedIndex() >= 0;

    switch (commandID)
    {
        case CommandIDs::newShow:
            info.setInfo ("New show", "Start an empty show", "File", 0);
            info.addDefaultKeypress ('n', cmd);
            break;

        case CommandIDs::openShow:
            info.setInfo ("Open show...", "Open an existing show", "File", 0);
            info.addDefaultKeypress ('o', cmd);
            break;

        case CommandIDs::saveShow:
            info.setInfo ("Save show", "Save the current show", "File", 0);
            info.addDefaultKeypress ('s', cmd);
            break;

        case CommandIDs::saveShowAs:
            info.setInfo ("Save show as...", "Save under a new name", "File", 0);
            info.addDefaultKeypress ('s', shiftCmd);
            break;

        case CommandIDs::addCue:
            info.setInfo ("Add audio cue...", "Add a cue from an audio file", "Cue", 0);
            info.addDefaultKeypress ('e', cmd);
            break;

        case CommandIDs::addStreamingCue:
            info.setInfo ("Add streaming cue", "Add a cue that plays from a streaming service", "Cue", 0);
            info.addDefaultKeypress ('e', shiftCmd);
            break;

        case CommandIDs::addControlCue:
            info.setInfo ("Add control cue", "Add a cue that only sends MIDI and OSC", "Cue", 0);
            break;

        case CommandIDs::duplicateCue:
            info.setInfo ("Duplicate cue", "Copy the selected cue", "Cue", 0);
            info.addDefaultKeypress ('d', cmd);
            info.setActive (hasSelection);
            break;

        case CommandIDs::deleteCue:
            info.setInfo ("Delete cue", "Remove the selected cue", "Cue", 0);
            info.addDefaultKeypress (KeyPress::backspaceKey, cmd);
            info.setActive (hasSelection);
            break;

        case CommandIDs::moveCueUp:
            info.setInfo ("Move cue up", "Move the selected cue earlier", "Cue", 0);
            info.addDefaultKeypress (KeyPress::upKey, cmd);
            info.setActive (hasSelection);
            break;

        case CommandIDs::moveCueDown:
            info.setInfo ("Move cue down", "Move the selected cue later", "Cue", 0);
            info.addDefaultKeypress (KeyPress::downKey, cmd);
            info.setActive (hasSelection);
            break;

        case CommandIDs::renumberCues:
            info.setInfo ("Renumber all cues", "Number the cues 1, 2, 3 in list order", "Cue", 0);
            break;

        case CommandIDs::go:
            info.setInfo ("GO", "Fire the standby cue", "Transport", 0);
            info.addDefaultKeypress (KeyPress::spaceKey, 0);
            break;

        case CommandIDs::releaseVamp:
            info.setInfo ("Release vamp", "Let every vamping cue continue", "Transport", 0);
            info.addDefaultKeypress (KeyPress::returnKey, 0);
            info.setActive (audioEngine.isAnythingVamping());
            break;

        case CommandIDs::pauseResume:
            info.setInfo (audioEngine.isPaused() ? "Resume" : "Pause",
                          "Freeze or resume everything that is playing", "Transport", 0);
            info.addDefaultKeypress ('p', cmd);
            break;

        case CommandIDs::stopAll:
            info.setInfo ("Stop all", "Fade everything out over two seconds", "Transport", 0);
            // S is the one an operator's hand finds without looking; Cmd-. stays for anyone
            // who expects the platform convention.
            info.addDefaultKeypress ('s', 0);
            info.addDefaultKeypress ('.', cmd);
            break;

        case CommandIDs::panic:
            info.setInfo ("PANIC", "Silence everything immediately", "Transport", 0);
            info.addDefaultKeypress (KeyPress::escapeKey, 0);
            break;

        case CommandIDs::auditionCue:
            info.setInfo ("Audition selected cue", "Listen to the selected cue without firing it",
                          "Transport", 0);
            info.addDefaultKeypress ('\'', 0);
            info.setActive (hasSelection);
            break;

        case CommandIDs::setStandbyToSelected:
            info.setInfo ("Standby the selected cue", "Point GO at the selected cue", "Transport", 0);
            info.addDefaultKeypress (KeyPress::returnKey, cmd);
            info.setActive (hasSelection);
            break;

        case CommandIDs::standbyPrevious:
            info.setInfo ("Standby previous cue", "Step the standby marker back", "Transport", 0);
            info.addDefaultKeypress (KeyPress::upKey, shiftCmd);
            break;

        case CommandIDs::standbyNext:
            info.setInfo ("Standby next cue", "Step the standby marker forward", "Transport", 0);
            info.addDefaultKeypress (KeyPress::downKey, shiftCmd);
            break;

        case CommandIDs::showAudioSetup:
            info.setInfo ("Audio setup...", "Choose the audio device and channels", "Audio", 0);
            info.addDefaultKeypress (',', cmd);
            break;

        case CommandIDs::showControlSetup:
            info.setInfo ("Control setup...", "OSC, MIDI, Art-Net and sACN", "Audio", 0);
            info.addDefaultKeypress (',', shiftCmd);
            break;

        case CommandIDs::showSettings:
            info.setInfo ("Settings...", "Streaming account and new-cue defaults", "Audio", 0);
            break;

        case CommandIDs::showAbout:
            info.setInfo ("About SimpleCue", "Version, documentation and how to support the work", "Help", 0);
            break;

        default:
            break;
    }
}

bool MainComponent::perform (const InvocationInfo& info)
{
    auto& list = show.getCueList();

    switch (info.commandID)
    {
        case CommandIDs::newShow:     newShow(); return true;
        case CommandIDs::openShow:    openShow(); return true;
        case CommandIDs::saveShow:    saveShow (false); return true;
        case CommandIDs::saveShowAs:  saveShow (true); return true;

        case CommandIDs::addCue:
        {
            juce::File startIn;

            if (auto* user = properties.getUserSettings())
                startIn = juce::File (user->getValue (lastAudioDirKey));

            fileChooser = std::make_unique<juce::FileChooser> ("Add audio cues", startIn,
                                                               sampleCache.getWildcardFilter());
            fileChooser->launchAsync (juce::FileBrowserComponent::openMode
                                          | juce::FileBrowserComponent::canSelectFiles
                                          | juce::FileBrowserComponent::canSelectMultipleItems,
                [this] (const juce::FileChooser& chooser)
                {
                    for (const auto& file : chooser.getResults())
                    {
                        if (auto* user = properties.getUserSettings())
                            user->setValue (lastAudioDirKey, file.getParentDirectory().getFullPathName());

                        addCueFromFile (file);
                    }
                });

            return true;
        }

        case CommandIDs::addStreamingCue: addStreamingCue(); return true;
        case CommandIDs::addControlCue:   addControlCue(); return true;
        case CommandIDs::duplicateCue:    duplicateSelectedCue(); return true;
        case CommandIDs::deleteCue:       deleteSelectedCue(); return true;
        case CommandIDs::moveCueUp:       moveSelectedCue (-1); return true;
        case CommandIDs::moveCueDown:     moveSelectedCue (1); return true;
        case CommandIDs::renumberCues:    renumberCues(); return true;

        case CommandIDs::go:
            if (! fireStandbyStep())
                if (const auto error = audioEngine.getLastError(); error.isNotEmpty())
                    reportError (error);

            return true;

        case CommandIDs::stopAll:     audioEngine.stopAll (2.0); return true;
        case CommandIDs::panic:
            audioEngine.panic();
            controlHub.cancelPendingMessages();
            return true;
        case CommandIDs::pauseResume: audioEngine.setPaused (! audioEngine.isPaused()); return true;
        case CommandIDs::releaseVamp: audioEngine.releaseAllVamps(); return true;

        case CommandIDs::auditionCue:
            if (const auto* cue = list.get (list.getSelectedIndex()))
                if (! audioEngine.audition (*cue, cue->startTime))
                    reportError (audioEngine.getLastError());

            return true;

        case CommandIDs::setStandbyToSelected:
            list.setStandbyIndex (list.getSelectedIndex());
            return true;

        case CommandIDs::standbyPrevious:
            list.setStandbyIndex (list.getStandbyIndex() - 1);
            return true;

        case CommandIDs::standbyNext:
            list.setStandbyIndex (list.getStandbyIndex() + 1);
            return true;

        case CommandIDs::showAudioSetup:   showAudioSetup(); return true;
        case CommandIDs::showControlSetup: showControlSetup(); return true;
        case CommandIDs::showSettings:     showSettings(); return true;
        case CommandIDs::showAbout:        showAbout(); return true;

        default:
            return false;
    }
}

} // namespace cp
