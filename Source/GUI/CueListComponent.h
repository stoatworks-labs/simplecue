#pragma once

#include "Audio/AudioEngine.h"
#include "GUI/LookAndFeel.h"
#include "Model/CueList.h"

#include <set>

namespace cp
{

/** The cue list: the operator's main working surface.

    Shows the standby marker, which cues are sounding, and the loop/vamp/link settings that
    decide what happens after a GO — all of which have to be readable at a glance from a
    couple of feet away in the dark.
*/
/*  DragAndDropTarget has to be a public base: JUCE finds the target under the mouse with a
    dynamic_cast, and a cast to a private base fails, so a private one is silently never
    offered the drop. */
class CueListComponent : public  juce::Component,
                         public  juce::DragAndDropContainer,
                         public  juce::DragAndDropTarget,
                         private juce::TableListBoxModel,
                         private juce::ChangeListener,
                         private juce::Timer
{
public:
    CueListComponent (CueList& list, AudioEngine& engine);
    ~CueListComponent() override;

    void resized() override;
    void paintOverChildren (juce::Graphics&) override;

    /** Called when the operator picks a different cue to edit. */
    std::function<void (int index)> onSelectionChanged;

    /** Called on double-click / Enter: fire the cue directly. */
    std::function<void (int index)> onCueTriggered;

    /** Called when a cue's audio file should be chosen (double-click on an empty file). */
    std::function<void (int index)> onFileRequested;

    /** Called when the operator clicks a row's delete cross. */
    std::function<void (int cueIndex)> onCueDeleteRequested;

    /** Called when the operator drags cue @p cueIndex to a new place in the list. @p gapIndex
        names the place as CueList::moveToGap does. Never called for a drop that would leave
        the cue where it was. */
    std::function<void (int cueIndex, int gapIndex)> onCueMoveRequested;

    void refresh();

    /** Scrolls to and selects the row for cue @p index (its header row). */
    void selectRow (int index);

private:
    //== TableListBoxModel =====================================================
    int  getNumRows() override;
    void paintRowBackground (juce::Graphics&, int row, int width, int height, bool rowIsSelected) override;
    void paintCell (juce::Graphics&, int row, int columnId, int width, int height, bool rowIsSelected) override;
    void cellClicked (int row, int columnId, const juce::MouseEvent&) override;
    void cellDoubleClicked (int row, int columnId, const juce::MouseEvent&) override;
    void selectedRowsChanged (int lastRowSelected) override;
    void backgroundClicked (const juce::MouseEvent&) override;
    juce::var getDragSourceDescription (const juce::SparseSet<int>& selectedRows) override;

    //== Reordering by drag ====================================================
    bool isInterestedInDragSource (const SourceDetails&) override;
    void itemDragEnter (const SourceDetails&) override;
    void itemDragMove (const SourceDetails&) override;
    void itemDragExit (const SourceDetails&) override;
    void itemDropped (const SourceDetails&) override;
    void dragOperationEnded (const SourceDetails&) override;
    void timerCallback() override;

    /** The cue a drag is carrying, or -1 if @p details is not one of ours. */
    int draggedCueIndex (const SourceDetails& details) const;

    /** The gap (as CueList::moveToGap counts them) nearest @p position, which is in this
        component's coordinates. A drop among a cue's sub-cues goes below that cue, since
        nothing can sit between a cue and its own sub-cues. Returns -1 off the table. */
    int gapIndexAt (juce::Point<int> position) const;

    /** The display row whose top edge marks gap @p gapIndex. */
    int displayRowForGap (int gapIndex) const;

    /** Recomputes the drop line from dragFromIndex and lastDragPosition. */
    void updateDropIndicator();
    void clearDropIndicator();

    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    juce::String describeLoop (const Cue&) const;
    juce::String describeLink (const Cue&) const;

    /** Playback status of @p cue, folded into one label and colour. */
    struct Status { juce::String label; juce::Colour colour; };
    Status statusFor (const Cue&) const;

    enum ColumnIds
    {
        columnDelete = 1,
        columnIcon,
        columnStatus,
        columnNumber,
        columnName,
        columnFile,
        columnPreWait,
        columnLength,
        columnFades,
        columnLoop,
        columnLink
    };


    /** One visible line: either a cue's header or one step of its lifecycle.

        The table is flat, so the tree is flattened into this list every refresh. That keeps
        expansion state and row identity in one obvious place instead of spread across the
        model. */
    struct DisplayRow
    {
        int cueIndex { -1 };
        int stepIndex { -1 };   ///< -1 for the cue's own header row.

        bool isHeader() const noexcept { return stepIndex < 0; }
    };

    void rebuildRows();
    bool isExpanded (const Cue& cue) const;
    void toggleExpansion (const Cue& cue);
    juce::Rectangle<int> getTwistyBounds (int width, int height) const;
    void drawDeleteCross (juce::Graphics&, juce::Rectangle<int>, bool highlighted) const;
    void drawTypeIcon (juce::Graphics&, juce::Rectangle<int>, const Cue&, bool isSubCue,
                       CueStepType stepType) const;

    /** Times read as 00:00.00 and drop back to a dim grey at zero, so the eye lands on the
        cues that actually wait rather than on a wall of identical zeroes. */
    void drawTimeCell (juce::Graphics&, juce::Rectangle<int>, double seconds) const;

    /** The list keeps only the keys it navigates with: plain arrows, Page Up/Down, Home and
        End. JUCE's ListBox matches a key by its code alone, so it would also take Cmd+Up as
        Up, and it eats Return and Delete for model callbacks this list doesn't use. Those
        are the app's shortcuts (Move cue, Standby, Release vamp, Delete cue), and once a
        cue's row has been clicked the list has the keyboard focus, so it sees them first. */
    struct CueTable : public juce::TableListBox
    {
        bool keyPressed (const juce::KeyPress& key) override
        {
            if (key.getModifiers().isCommandDown()
                || key.isKeyCode (juce::KeyPress::returnKey)
                || key.isKeyCode (juce::KeyPress::deleteKey)
                || key.isKeyCode (juce::KeyPress::backspaceKey))
                return false;

            return juce::TableListBox::keyPressed (key);
        }
    };

    CueList& cueList;
    AudioEngine& audioEngine;
    CueTable table;
    std::vector<AudioEngine::ActiveCueInfo> activeSnapshot;
    std::vector<DisplayRow> displayRows;

    /** Cues the operator has opened by hand. The standby cue opens on its own while it is
        part-way through its lifecycle, so the steps are visible exactly when they matter. */
    std::set<juce::Uuid> manuallyExpanded;

    /** Where a drag in progress would put its cue, or -1 when there is no drag or the drop
        would change nothing. Drawn as a line across the table. */
    int dropGapIndex { -1 };

    /** The cue being dragged, or -1 when no drag is over the list. */
    int dragFromIndex { -1 };

    /** The last place a drag was seen, kept so the timer can scroll a long list while the
        mouse is held still at its top or bottom edge. */
    juce::Point<int> lastDragPosition;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CueListComponent)
};

} // namespace cp
