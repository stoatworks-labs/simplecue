#include "GUI/CueListComponent.h"

namespace cp
{

namespace
{
    /** Starts the description of a drag that carries a cue from this list, so anything else
        dropped on the list is ignored. */
    const char* const cueDragPrefix = "simplecue-cue:";
}

CueListComponent::CueListComponent (CueList& list, AudioEngine& engine)
    : cueList (list), audioEngine (engine)
{
    table.setModel (this);
    table.setColour (juce::ListBox::backgroundColourId, colours::panel);
    table.setRowHeight (26);
    table.setHeaderHeight (24);
    table.getViewport()->setScrollBarsShown (true, false);

    auto& header = table.getHeader();
    header.addColumn ("",        columnDelete,  26,  26,  26,
                      juce::TableHeaderComponent::notResizableOrSortable);
    header.addColumn ("",        columnIcon,    28,  28,  28,
                      juce::TableHeaderComponent::notResizableOrSortable);
    header.addColumn ("",        columnStatus,  74,  60,  120);
    header.addColumn ("Cue",     columnNumber,  62,  40,  120);
    header.addColumn ("Name",    columnName,    260, 120, 900);
    header.addColumn ("Source",  columnFile,    200, 100, 700);
    header.addColumn ("Pre",     columnPreWait, 80,  70,  120);
    header.addColumn ("Length",  columnLength,  84,  60,  140);
    header.addColumn ("Fades",   columnFades,   92,  60,  160);
    header.addColumn ("Repeat",  columnLoop,    108, 70,  200);
    header.addColumn ("Link",    columnLink,    150, 80,  300);
    header.setStretchToFitActive (true);

    addAndMakeVisible (table);

    cueList.addChangeListener (this);
    audioEngine.addChangeListener (this);
}

CueListComponent::~CueListComponent()
{
    cueList.removeChangeListener (this);
    audioEngine.removeChangeListener (this);
    table.setModel (nullptr);
}

void CueListComponent::resized()
{
    table.setBounds (getLocalBounds());
}

void CueListComponent::paintOverChildren (juce::Graphics& g)
{
    if (dropGapIndex < 0)
        return;

    const auto viewArea = getLocalArea (&table, table.getViewport()->getBounds());
    const auto rowTop = getLocalArea (&table, table.getRowPosition (displayRowForGap (dropGapIndex),
                                                                   true)).getY();

    // Held inside the rows, so a drop at the very top or bottom still shows a whole line
    // rather than one tucked under the header or cut off by the edge.
    const auto y = juce::jlimit (viewArea.getY() + 3, viewArea.getBottom() - 4, rowTop);

    g.setColour (colours::text);
    g.fillRect (viewArea.getX(), y - 1, viewArea.getWidth(), 2);
    g.fillEllipse ((float) viewArea.getX() + 2.0f, (float) y - 3.5f, 7.0f, 7.0f);
}

void CueListComponent::changeListenerCallback (juce::ChangeBroadcaster*)
{
    refresh();
}

bool CueListComponent::isExpanded (const Cue& cue) const
{
    if (manuallyExpanded.count (cue.id) > 0)
        return true;

    // The standby cue always opens, so the operator can see what the next few GOs will do
    // before committing to the first of them - not only once they are already part-way
    // through and wondering what happens next.
    if (const auto* standby = cueList.getStandbyCue(); standby != nullptr && standby->id == cue.id)
        return true;

    return false;
}

void CueListComponent::toggleExpansion (const Cue& cue)
{
    if (manuallyExpanded.count (cue.id) > 0)
        manuallyExpanded.erase (cue.id);
    else
        manuallyExpanded.insert (cue.id);

    rebuildRows();
    table.updateContent();
    table.repaint();
}

void CueListComponent::rebuildRows()
{
    displayRows.clear();

    for (int i = 0; i < cueList.size(); ++i)
    {
        const auto* cue = cueList.get (i);

        if (cue == nullptr)
            continue;

        displayRows.push_back ({ i, cueHeaderStep });

        const auto steps = cueList.stepsFor (i);

        if (isExpanded (*cue))
            for (int s = 0; s < (int) steps.size(); ++s)
                displayRows.push_back ({ i, s });
    }
}

void CueListComponent::refresh()
{
    activeSnapshot = audioEngine.getActiveCues();
    rebuildRows();

    table.updateContent();
    table.repaint();
}

void CueListComponent::selectRow (int index)
{
    for (int row = 0; row < (int) displayRows.size(); ++row)
    {
        if (displayRows[(size_t) row].cueIndex == index && displayRows[(size_t) row].isHeader())
        {
            table.selectRow (row, false, true);
            table.scrollToEnsureRowIsOnscreen (row);
            return;
        }
    }
}

juce::Rectangle<int> CueListComponent::getTwistyBounds (int width, int height) const
{
    juce::ignoreUnused (width);
    return juce::Rectangle<int> (4, (height - 12) / 2, 12, 12);
}


void CueListComponent::drawDeleteCross (juce::Graphics& g, juce::Rectangle<int> area,
                                        bool highlighted) const
{
    const auto cross = area.withSizeKeepingCentre (10, 10).toFloat();

    g.setColour (highlighted ? colours::stop.brighter (0.4f) : colours::stop.withAlpha (0.85f));
    g.drawLine (cross.getX(), cross.getY(), cross.getRight(), cross.getBottom(), 1.8f);
    g.drawLine (cross.getX(), cross.getBottom(), cross.getRight(), cross.getY(), 1.8f);
}

void CueListComponent::drawTypeIcon (juce::Graphics& g, juce::Rectangle<int> area,
                                     const Cue& cue, bool isSubCue, CueStepType stepType) const
{
    const auto box = area.withSizeKeepingCentre (14, 14).toFloat();

    if (isSubCue)
    {
        // Sub-cues take their colour from what they do, so the eye can find the devamp in
        // a long list without reading any text.
        const auto colour = stepType == CueStepType::play   ? colours::go
                          : stepType == CueStepType::devamp ? colours::vamp
                                                             : colours::stop;

        g.setColour (colour.withAlpha (0.9f));

        // A small speaker: a box with a cone, matching the parent's audio icon at half
        // weight so it reads as "part of the cue above".
        juce::Path speaker;
        speaker.addRectangle (box.getX() + 1.0f, box.getCentreY() - 2.0f, 3.0f, 4.0f);
        speaker.addTriangle (box.getX() + 8.0f, box.getCentreY() - 5.0f,
                             box.getX() + 8.0f, box.getCentreY() + 5.0f,
                             box.getX() + 4.0f, box.getCentreY());
        speaker.addRectangle (box.getX() + 4.0f, box.getCentreY() - 2.0f, 4.0f, 4.0f);
        g.fillPath (speaker);
        return;
    }

    switch (cue.type)
    {
        case CueType::control:
            // Concentric arcs: something being sent out rather than played.
            g.setColour (colours::standby);
            for (int i = 0; i < 3; ++i)
                g.drawEllipse (box.reduced ((float) i * 2.2f), 1.2f);
            break;

        case CueType::streaming:
            g.setColour (colours::loop);
            g.drawEllipse (box, 1.4f);
            g.fillEllipse (box.withSizeKeepingCentre (4.0f, 4.0f));
            break;

        case CueType::audioFile:
        default:
        {
            g.setColour (cue.audioFile.existsAsFile() ? colours::textDim : colours::stop);
            juce::Path speaker;
            speaker.addRectangle (box.getX(), box.getCentreY() - 2.5f, 3.5f, 5.0f);
            // Cone opening away from the body, so it reads as a speaker rather than as an
            // arrow pointing right.
            speaker.addTriangle (box.getX() + 8.5f, box.getCentreY() - 6.0f,
                                 box.getX() + 8.5f, box.getCentreY() + 6.0f,
                                 box.getX() + 3.5f, box.getCentreY());
            speaker.addRectangle (box.getX() + 3.5f, box.getCentreY() - 2.5f, 5.0f, 5.0f);
            g.fillPath (speaker);
            break;
        }
    }
}

void CueListComponent::drawTimeCell (juce::Graphics& g, juce::Rectangle<int> area,
                                     double seconds) const
{
    const auto isZero = seconds <= 0.0001;

    g.setColour (isZero ? colours::textDim.withAlpha (0.35f) : colours::text);
    g.setFont (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 11.5f,
                                  isZero ? juce::Font::plain : juce::Font::bold));

    const auto total = juce::jmax (0.0, seconds);
    const auto hundredths = (int) std::fmod (total * 100.0, 100.0);
    const auto secs = (int) std::fmod (total, 60.0);
    const auto minutes = (int) (total / 60.0);

    g.drawText (juce::String::formatted ("%02d:%02d.%02d", minutes, secs, hundredths),
                area, juce::Justification::centredRight);
}

//==============================================================================
int CueListComponent::getNumRows()
{
    return (int) displayRows.size();
}

CueListComponent::Status CueListComponent::statusFor (const Cue& cue) const
{
    for (const auto& active : activeSnapshot)
    {
        if (active.cueId != cue.id)
            continue;

        if (active.paused)     return { "PAUSED",  colours::textDim };
        if (active.inPreWait)  return { "WAIT",    colours::preWait };
        if (active.vamping)    return { "VAMP " + juce::String (active.vampPasses + 1), colours::vamp };
        if (active.stopping)   return { "FADING",  colours::stop };

        return { "PLAYING", colours::go };
    }

    if (cue.type == CueType::audioFile && ! cue.audioFile.existsAsFile())
        return { "MISSING", colours::stop };

    return {};
}

void CueListComponent::paintRowBackground (juce::Graphics& g, int row, int width, int height, bool rowIsSelected)
{
    if (! juce::isPositiveAndBelow (row, (int) displayRows.size()))
        return;

    const auto& display = displayRows[(size_t) row];

    // Step rows sit in a slightly recessed band so a cue and its lifecycle read as one
    // block rather than as a run of unrelated lines.
    if (display.isHeader())
        g.fillAll (display.cueIndex % 2 == 0 ? colours::panel : colours::panel.brighter (0.02f));
    else
        g.fillAll (colours::background.brighter (0.02f));

    if (rowIsSelected && display.isHeader())
        g.fillAll (colours::panelLight);

    // The standby marker goes on the exact row GO will act on: the cue header when the
    // lifecycle is collapsed or at its start, otherwise the step itself.
    const auto standbyCue = cueList.getStandbyIndex();
    const auto standbyStep = cueList.getStandbyStep();

    // Standby sits on an exact row now - the cue itself, or one of its sub-cues - so the
    // marker goes where GO will actually act, with no guessing when things are collapsed.
    const auto collapsedOntoHeader = display.isHeader() && standbyStep != cueHeaderStep
                                  && ! std::any_of (displayRows.begin(), displayRows.end(),
                                                    [&display] (const DisplayRow& r)
                                                    { return r.cueIndex == display.cueIndex && ! r.isHeader(); });

    const auto isStandbyRow = display.cueIndex == standbyCue
                           && (display.stepIndex == standbyStep || collapsedOntoHeader);

    if (isStandbyRow)
    {
        g.setColour (colours::standby);
        g.fillRect (0, 0, 4, height);
    }

    g.setColour (colours::outline.withAlpha (display.isHeader() ? 0.5f : 0.2f));
    g.drawHorizontalLine (height - 1, 0.0f, (float) width);
}

void CueListComponent::paintCell (juce::Graphics& g, int row, int columnId, int width, int height, bool)
{
    if (! juce::isPositiveAndBelow (row, (int) displayRows.size()))
        return;

    const auto& display = displayRows[(size_t) row];
    const auto* cue = cueList.get (display.cueIndex);

    if (cue == nullptr)
        return;

    const auto fullCell = juce::Rectangle<int> (0, 0, width, height);

    // --- a sub-cue ------------------------------------------------------------
    if (! display.isHeader())
    {
        const auto steps = cueList.stepsFor (display.cueIndex);

        if (! juce::isPositiveAndBelow (display.stepIndex, (int) steps.size()))
            return;

        const auto& step = steps[(size_t) display.stepIndex];
        const auto stepArea = fullCell.reduced (6, 0);

        switch (columnId)
        {
            case columnDelete:
                break;   // Sub-cues belong to their cue; they are not deleted on their own.

            case columnIcon:
                drawTypeIcon (g, fullCell, *cue, true, step.type);
                break;

            case columnName:
                g.setColour (colours::text);
                g.setFont (juce::FontOptions (12.5f));
                // Indented, so the sub-cue reads as part of the cue above it.
                g.drawText (step.label, stepArea.withTrimmedLeft (22),
                            juce::Justification::centredLeft, true);
                break;

            case columnFile:
                g.setColour (colours::textDim);
                g.setFont (juce::FontOptions (11.5f));
                g.drawText (step.detail, stepArea, juce::Justification::centredLeft, true);
                break;

            case columnPreWait:
                if (step.type == CueStepType::play)
                    drawTimeCell (g, stepArea, cue->preWait);
                break;

            case columnLength:
                if (step.type == CueStepType::play)
                    drawTimeCell (g, stepArea, cue->fadeInTime);
                else if (step.type == CueStepType::end)
                    drawTimeCell (g, stepArea,
                                  cue->endAction == EndAction::hardStop ? 0.0 : cue->endFadeTime);
                break;

            default:
                break;
        }

        return;
    }

    const auto area = fullCell.reduced (6, 0);
    g.setFont (juce::FontOptions (12.5f));
    g.setColour (colours::text);

    switch (columnId)
    {
        case columnDelete:
            drawDeleteCross (g, fullCell, false);
            break;

        case columnIcon:
            drawTypeIcon (g, fullCell, *cue, false, CueStepType::play);
            break;

        case columnStatus:
        {
            const auto status = statusFor (*cue);

            if (status.label.isEmpty())
                return;

            auto tag = area.withSizeKeepingCentre (juce::jmin (area.getWidth(), 66), 16);
            g.setColour (status.colour);
            g.fillRoundedRectangle (tag.toFloat(), 3.0f);
            g.setColour (colours::background);
            g.setFont (juce::FontOptions (9.5f, juce::Font::bold));
            g.drawText (status.label, tag, juce::Justification::centred);
            break;
        }

        case columnNumber:
        {
            auto numberArea = area;

            {
                const auto twisty = getTwistyBounds (width, height);
                juce::Path triangle;

                if (isExpanded (*cue))
                {
                    triangle.addTriangle ((float) twisty.getX(), (float) twisty.getY() + 2.0f,
                                          (float) twisty.getRight(), (float) twisty.getY() + 2.0f,
                                          (float) twisty.getCentreX(), (float) twisty.getBottom() - 1.0f);
                }
                else
                {
                    triangle.addTriangle ((float) twisty.getX() + 2.0f, (float) twisty.getY(),
                                          (float) twisty.getX() + 2.0f, (float) twisty.getBottom(),
                                          (float) twisty.getRight() - 1.0f, (float) twisty.getCentreY());
                }

                g.setColour (colours::textDim);
                g.fillPath (triangle);
                numberArea = numberArea.withTrimmedLeft (14);
            }

            g.setColour (colours::text);
            g.setFont (juce::FontOptions (13.0f, juce::Font::bold));
            g.drawText (cue->number, numberArea, juce::Justification::centredLeft, true);
            break;
        }

        case columnName:
            g.drawText (cue->name.isNotEmpty() ? cue->name : juce::String ("(untitled)"),
                        area, juce::Justification::centredLeft, true);
            break;

        case columnFile:
        {
            if (cue->type == CueType::streaming)
            {
                g.setColour (colours::loop);
                const auto label = cue->streaming.displayName.isNotEmpty()
                                       ? cue->streaming.displayName : cue->streaming.uri;
                g.drawText (audioEngine.getStreamingSettings().getProviderDisplayName()
                                + "   " + label,
                            area, juce::Justification::centredLeft, true);
                break;
            }

            if (cue->type == CueType::control)
            {
                g.setColour (colours::standby);
                g.drawText (juce::String (cue->outputMessages.size())
                                + (cue->outputMessages.size() == 1 ? " message" : " messages"),
                            area, juce::Justification::centredLeft, true);
                break;
            }

            if (cue->audioFile == juce::File())
            {
                g.setColour (colours::textDim);
                g.drawText ("double-click to choose a file", area, juce::Justification::centredLeft, true);
                break;
            }

            g.setColour (cue->audioFile.existsAsFile() ? colours::textDim : colours::stop);
            g.drawText (cue->audioFile.getFileName(), area, juce::Justification::centredLeft, true);
            break;
        }

        case columnPreWait:
            drawTimeCell (g, area, cue->preWait);
            break;

        case columnLength:
        {
            const auto length = cue->playbackLength();
            g.setColour (colours::textDim);
            g.drawText (length > 0.0 ? formatTime (length) : juce::String ("open"),
                        area, juce::Justification::centredLeft, true);
            break;
        }

        case columnFades:
        {
            juce::StringArray parts;

            if (cue->fadeInTime  > 0.0) parts.add (juce::String (cue->fadeInTime, 1)  + "s in");
            if (cue->fadeOutTime > 0.0) parts.add (juce::String (cue->fadeOutTime, 1) + "s out");

            g.setColour (colours::textDim);
            g.drawText (parts.joinIntoString (" / "), area, juce::Justification::centredLeft, true);
            break;
        }

        case columnLoop:
            g.setColour (cue->vampEnabled ? colours::vamp
                                          : (cue->loopEnabled ? colours::loop : colours::textDim));
            g.drawText (describeLoop (*cue), area, juce::Justification::centredLeft, true);
            break;

        case columnLink:
            g.setColour (cue->link.mode == LinkMode::none ? colours::textDim : colours::standby);
            g.drawText (describeLink (*cue), area, juce::Justification::centredLeft, true);
            break;

        default:
            break;
    }
}

juce::String CueListComponent::describeLoop (const Cue& cue) const
{
    juce::StringArray parts;

    if (cue.loopEnabled)
        parts.add (cue.loopCount <= 0 ? juce::String ("loop") : "x" + juce::String (cue.loopCount));

    if (cue.vampEnabled)
        parts.add ("vamp");

    return parts.joinIntoString (" + ");
}

juce::String CueListComponent::describeLink (const Cue& cue) const
{
    if (cue.link.mode == LinkMode::none)
        return {};

    juce::String target = "next";

    if (! cue.link.targetsNextCue())
        if (const auto* t = cueList.findByID (cue.link.target))
            target = t->number.isNotEmpty() ? t->number : t->name;

    switch (cue.link.mode)
    {
        case LinkMode::autoContinue:
            return "instantly -> " + target + (cue.link.delay > 0.0
                                                  ? " +" + juce::String (cue.link.delay, 1) + "s" : "");
        case LinkMode::autoFollow:
            return "at end -> " + target + (cue.link.delay > 0.0
                                                ? " +" + juce::String (cue.link.delay, 1) + "s" : "");
        case LinkMode::crossfade:
            return "xfade " + juce::String (cue.link.duration, 1) + "s -> " + target;
        case LinkMode::none:
        default:
            return {};
    }
}

//==============================================================================
void CueListComponent::cellClicked (int row, int columnId, const juce::MouseEvent& e)
{
    if (! juce::isPositiveAndBelow (row, (int) displayRows.size()))
        return;

    const auto& display = displayRows[(size_t) row];
    const auto* cue = cueList.get (display.cueIndex);

    if (cue == nullptr)
        return;

    // Clicking a sub-cue stands it by, so an operator can jump straight to "release this
    // vamp" without walking there.
    if (! display.isHeader())
    {
        cueList.setStandbyPosition (display.cueIndex, display.stepIndex);
        refresh();
        return;
    }

    if (columnId == columnDelete)
    {
        if (onCueDeleteRequested != nullptr)
            onCueDeleteRequested (display.cueIndex);

        return;
    }

    if (columnId == columnNumber
        && getTwistyBounds (table.getHeader().getColumnWidth (columnNumber),
                            table.getRowHeight()).expanded (4, 4).contains (e.x, e.y))
    {
        toggleExpansion (*cue);
        return;
    }

    cueList.setSelectedIndex (display.cueIndex);

    if (onSelectionChanged != nullptr)
        onSelectionChanged (display.cueIndex);
}

void CueListComponent::cellDoubleClicked (int row, int columnId, const juce::MouseEvent&)
{
    if (! juce::isPositiveAndBelow (row, (int) displayRows.size()))
        return;

    const auto& display = displayRows[(size_t) row];
    const auto* cue = cueList.get (display.cueIndex);

    if (cue == nullptr || ! display.isHeader())
        return;

    if (columnId == columnFile && cue->type == CueType::audioFile)
    {
        if (onFileRequested != nullptr)
            onFileRequested (display.cueIndex);

        return;
    }

    if (onCueTriggered != nullptr)
        onCueTriggered (display.cueIndex);
}

void CueListComponent::selectedRowsChanged (int lastRowSelected)
{
    if (! juce::isPositiveAndBelow (lastRowSelected, (int) displayRows.size()))
        return;

    const auto& display = displayRows[(size_t) lastRowSelected];

    if (display.cueIndex == cueList.getSelectedIndex())
        return;

    cueList.setSelectedIndex (display.cueIndex);

    if (onSelectionChanged != nullptr)
        onSelectionChanged (display.cueIndex);
}

void CueListComponent::backgroundClicked (const juce::MouseEvent&) {}

//==============================================================================
juce::var CueListComponent::getDragSourceDescription (const juce::SparseSet<int>& selectedRows)
{
    // Only a cue's own row picks it up. A sub-cue belongs to its cue and goes where it goes.
    if (selectedRows.size() != 1)
        return {};

    const auto row = selectedRows[0];

    if (! juce::isPositiveAndBelow (row, (int) displayRows.size())
        || ! displayRows[(size_t) row].isHeader())
        return {};

    if (const auto* cue = cueList.get (displayRows[(size_t) row].cueIndex))
        return juce::String (cueDragPrefix) + cue->id.toString();

    return {};
}

int CueListComponent::draggedCueIndex (const SourceDetails& details) const
{
    if (details.sourceComponent.get() != &table)
        return -1;

    const auto description = details.description.toString();

    if (! description.startsWith (cueDragPrefix))
        return -1;

    return cueList.indexOfID (juce::Uuid (description.fromFirstOccurrenceOf (cueDragPrefix,
                                                                             false, false)));
}

int CueListComponent::gapIndexAt (juce::Point<int> position) const
{
    const auto inTable = table.getLocalPoint (this, position);
    const auto row = table.getInsertionIndexForPosition (inTable.x, inTable.y);

    if (row < 0)
        return -1;

    if (row >= (int) displayRows.size())
        return cueList.size();

    const auto& display = displayRows[(size_t) row];
    return display.isHeader() ? display.cueIndex : display.cueIndex + 1;
}

int CueListComponent::displayRowForGap (int gapIndex) const
{
    for (int row = 0; row < (int) displayRows.size(); ++row)
        if (displayRows[(size_t) row].isHeader() && displayRows[(size_t) row].cueIndex == gapIndex)
            return row;

    return (int) displayRows.size();
}

void CueListComponent::updateDropIndicator()
{
    auto gap = dragFromIndex >= 0 ? gapIndexAt (lastDragPosition) : -1;

    // The gaps either side of the cue being carried would leave it where it is, so they get
    // no line: no line means letting go changes nothing.
    if (gap == dragFromIndex || gap == dragFromIndex + 1)
        gap = -1;

    if (gap != dropGapIndex)
    {
        dropGapIndex = gap;
        repaint();
    }
}

void CueListComponent::clearDropIndicator()
{
    stopTimer();
    dragFromIndex = -1;

    if (dropGapIndex >= 0)
    {
        dropGapIndex = -1;
        repaint();
    }
}

bool CueListComponent::isInterestedInDragSource (const SourceDetails& details)
{
    return draggedCueIndex (details) >= 0;
}

void CueListComponent::itemDragEnter (const SourceDetails& details)
{
    itemDragMove (details);
}

void CueListComponent::itemDragMove (const SourceDetails& details)
{
    dragFromIndex = draggedCueIndex (details);
    lastDragPosition = details.localPosition;
    updateDropIndicator();

    if (! isTimerRunning())
        startTimerHz (30);
}

void CueListComponent::itemDragExit (const SourceDetails&)
{
    clearDropIndicator();
}

void CueListComponent::itemDropped (const SourceDetails& details)
{
    const auto from = draggedCueIndex (details);
    const auto gap = gapIndexAt (details.localPosition);

    clearDropIndicator();

    if (from < 0 || gap < 0 || gap == from || gap == from + 1)
        return;

    if (onCueMoveRequested != nullptr)
        onCueMoveRequested (from, gap);
}

void CueListComponent::dragOperationEnded (const SourceDetails&)
{
    // A drag let go outside the list never reaches itemDropped or itemDragExit.
    clearDropIndicator();
}

void CueListComponent::timerCallback()
{
    // Drag-move callbacks stop the moment the mouse is held still, so this is what keeps a
    // long list scrolling while a cue is held at its top or bottom edge.
    auto* viewport = table.getViewport();
    const auto inViewport = viewport->getLocalPoint (this, lastDragPosition);

    if (viewport->autoScroll (inViewport.x, inViewport.y, 30, 14))
    {
        updateDropIndicator();
        repaint();   // The line follows its row as the rows move under it.
    }
}

} // namespace cp
