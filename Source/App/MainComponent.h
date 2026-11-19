#pragma once

#include "App/CommandIDs.h"
#include "Audio/AudioEngine.h"
#include "Audio/SampleCache.h"
#include "Control/ControlHub.h"
#include "GUI/ActiveCuesComponent.h"
#include "GUI/AudioSetupWindow.h"
#include "GUI/CueInspector.h"
#include "GUI/ControlSetupWindow.h"
#include "GUI/SettingsWindow.h"
#include "GUI/CueListComponent.h"
#include "GUI/TransportBar.h"
#include "Model/Show.h"
#include "../StoatworksAboutPanel.h"

namespace cp
{

/** The application window's contents: owns the show, the engine and the whole UI. */
class MainComponent : public  juce::Component,
                      public  juce::MenuBarModel,
                      public  juce::ApplicationCommandTarget,
                      public  juce::FileDragAndDropTarget,
                      public  ControlActionHandler,
                      private juce::ChangeListener,
                      private juce::Timer
{
public:
    explicit MainComponent (juce::ApplicationProperties& properties);
    ~MainComponent() override;

    void paint (juce::Graphics&) override;
    void resized() override;

    /** Opens @p file, prompting first if the current show has unsaved changes. */
    void openShowFile (const juce::File& file);

    /** Calls @p callback with true when it is safe to throw the current show away. */
    void confirmDiscardChanges (std::function<void (bool)> callback);

    /** Loads a demo show, opens the setup windows and writes PNGs of each into @p outputDir,
        then calls @p onComplete. Used by `SimpleCue --screenshots <dir>` to regenerate the
        images in the README from a known state. Suppresses the usual settings save, so a
        screenshot run never leaves the operator's ports and devices rearranged. */
    void captureScreenshots (const juce::File& outputDir, std::function<void()> onComplete);

    /** Loads the demo show the screenshots are taken of and applies the demo control
        settings, then leaves the app running. Used by `SimpleCue --demo` to film the app:
        those settings listen for OSC on 53000, so a capture can be choreographed over the
        app's own control surface rather than by driving the mouse. Suppresses the usual
        settings save for the same reason a screenshot run does. */
    void loadDemoShow();

    //== MenuBarModel ==========================================================
    juce::StringArray getMenuBarNames() override;
    juce::PopupMenu getMenuForIndex (int index, const juce::String& name) override;
    void menuItemSelected (int menuItemID, int topLevelMenuIndex) override;
    void collectDiagnostics();

    //== ApplicationCommandTarget ==============================================
    ApplicationCommandTarget* getNextCommandTarget() override;
    void getAllCommands (juce::Array<juce::CommandID>&) override;
    void getCommandInfo (juce::CommandID, juce::ApplicationCommandInfo&) override;
    bool perform (const InvocationInfo&) override;

    //== FileDragAndDropTarget =================================================
    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void filesDropped (const juce::StringArray& files, int x, int y) override;

    //== ControlActionHandler ==================================================
    /** Always arrives on the message thread; the transports marshal to it. */
    void performControlAction (const ControlAction& action) override;

private:
    void timerCallback() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    void newShow();
    void openShow();
    /** Saves the show, choosing a filename first when it has none. @p onComplete is called
        with whether a save actually happened, so the quit prompt can wait for it. */
    void saveShow (bool forceChooseFile, std::function<void (bool)> onComplete = {});
    void addCueFromFile (const juce::File& file, int insertAt = -1);
    void addStreamingCue();
    void addControlCue();
    void showControlSetup();
    void showSettings();
    void showAbout();
    void saveStreamingSettings();
    void publishControlStatus();

    /** Performs whatever the standby step is - play, devamp or end - and moves standby on
        to the next step of that cue's lifecycle, or to the next cue when it is finished.
        This is what GO does. */
    bool fireStandbyStep();

    /** Fires a whole cue, as a double-click or an incoming goCue does. Honours the cue's
        "firing this cue also fires its Play sub-cue" setting. */
    bool fireCueAsWhole (int index);

    /** Resolves the cue an incoming action refers to, by list position when the transport
        gave one (DMX) and by cue number otherwise. Returns -1 if there is no such cue. */
    int resolveControlTarget (const ControlAction& action) const;
    void chooseFileForCue (int index);
    void scanFileInto (Cue& cue, const juce::File& file);
    void deleteSelectedCue();
    void duplicateSelectedCue();
    void moveSelectedCue (int delta);

    /** After a move: selects the cue now at @p index, in the list and the inspector. Does
        nothing for -1, which is what a move that changed nothing returns. */
    void selectMovedCue (int index);
    void renumberCues();
    void showAudioSetup();
    void preloadShowAudio();
    void updateWindowTitle();
    void reportError (const juce::String& message);

    juce::ApplicationProperties& properties;

    SampleCache sampleCache;
    AudioEngine audioEngine { sampleCache };
    Show show;
    ControlHub controlHub;

    TransportBar transportBar { audioEngine };
    CueListComponent cueListComponent { show.getCueList(), audioEngine };
    CueInspector inspector { show.getCueList(), audioEngine, controlHub,
                             sampleCache.getFormatManager() };
    ActiveCuesComponent activeCues { audioEngine };

    juce::StretchableLayoutManager verticalLayout;
    juce::StretchableLayoutResizerBar verticalResizer { &verticalLayout, 1, false };

    juce::ApplicationCommandManager commandManager;

    /** What the menus' greyed-out items and changing titles are worked out from. The macOS
        menu bar does not ask again each time a menu opens: JUCE rebuilds it once just after
        launch, and from then on a menu keeps the enabled state it was built with, so Move cue
        up stayed greyed out with a cue selected. When any of this changes the command manager
        is told, and the menu bar it watches rebuilds itself. */
    struct CommandState
    {
        bool hasSelection = false;
        bool vamping = false;
        bool paused = false;

        bool operator== (const CommandState&) const = default;
    };

    CommandState lastCommandState;
    void refreshCommandStatus();

    std::unique_ptr<juce::FileChooser> fileChooser;
    std::unique_ptr<AudioSetupWindow> audioSetupWindow;
    std::unique_ptr<ControlSetupWindow> controlSetupWindow;
    std::unique_ptr<SettingsWindow> settingsWindow;
    juce::File screenshotAudioDirectory;
    bool screenshotMode { false };
    juce::TooltipWindow tooltips { this, 700 };

    static constexpr int activeCuesWidth = 300;
    static constexpr int transportHeight = 68;

    /* Vendored from stoatworks-backend/about - see StoatworksAboutPanel.h. */

    stoatworks::AboutPanel aboutPanel;


    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};

} // namespace cp
