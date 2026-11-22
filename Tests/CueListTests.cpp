/*
    Tests for how the cue list marks the selected cue.

    The real CueListComponent is painted into an image, with no window, and the rows are
    read back as pixels. The selection is set the way the app sets it: through the show's
    CueList (what opening a show does) or through the table's own selectRow (what a click
    on a row does). Colours are compared by contrast rather than by value, so the tests say
    "can this be seen" rather than pinning one shade of blue.
*/

#include "TestHarness.h"

#include "Audio/AudioEngine.h"
#include "Audio/SampleCache.h"
#include "GUI/CueListComponent.h"
#include "GUI/LookAndFeel.h"
#include "Model/CueList.h"

#include <cmath>

using namespace cp;
using cptest::check;

namespace
{

//==============================================================================
/** The WCAG contrast ratio of two opaque colours: 1 when identical, 21 for black on white. */
double contrast (juce::Colour a, juce::Colour b)
{
    const auto luminance = [] (juce::Colour c)
    {
        const auto channel = [] (juce::uint8 value)
        {
            const auto x = value / 255.0;
            return x <= 0.03928 ? x / 12.92 : std::pow ((x + 0.055) / 1.055, 2.4);
        };

        return 0.2126 * channel (c.getRed()) + 0.7152 * channel (c.getGreen())
             + 0.0722 * channel (c.getBlue());
    };

    const auto la = luminance (a);
    const auto lb = luminance (b);
    return (juce::jmax (la, lb) + 0.05) / (juce::jmin (la, lb) + 0.05);
}

/** The selected cue's header against an unselected header of the same stripe. The old
    highlight managed 1.16, which disappears on a dimmed screen in a dark room. */
constexpr double headerContrast = 1.6;

/** A selected cue's step rows against unselected step rows. Lighter than the header, so the
    block reads as one cue rather than as several selected rows. */
constexpr double stepContrast = 1.2;

/** What an unselected step row is painted with. */
const juce::Colour stepBackground = colours::background.brighter (0.02f);

//==============================================================================
/** A cue list as the operator sees it, painted into an image instead of a window. */
struct ListOnScreen
{
    explicit ListOnScreen (int numCues)
    {
        for (int i = 0; i < numCues; ++i)
        {
            Cue cue;
            cue.number = juce::String (i + 1);
            cue.name = "Cue " + cue.number;
            list.insert (std::move (cue));
        }

        view.setSize (900, 400);
        view.setVisible (true);
        view.refresh();
    }

    /** The table inside the list: what a click on a row selects a row of. */
    juce::TableListBox& table()
    {
        auto* found = dynamic_cast<juce::TableListBox*> (view.getChildComponent (0));
        jassert (found != nullptr);
        return *found;
    }

    juce::Image paint()
    {
        view.refresh();
        return view.createComponentSnapshot (view.getLocalBounds(), true, 1.0f);
    }

    /** A pixel of @p row's background: mid-width, and near the top, which is clear of the
        row's text and of the selection's outline. */
    static juce::Colour rowColour (const juce::Image& image, int row)
    {
        return image.getPixelAt (image.getWidth() / 2, headerHeight + row * rowHeight + 4);
    }

    static constexpr int headerHeight = 24;
    static constexpr int rowHeight = 26;

    CueList list;
    SampleCache cache;
    AudioEngine engine { cache };
    CueListComponent view { list, engine };
};

//==============================================================================
void testOpenedShowMarksItsSelectedCue()
{
    cptest::section ("cue list: an opened show marks its selected cue");

    ListOnScreen screen (4);
    screen.list.setStandbyIndex (3);    // opens cue 4's steps at the bottom, clear of rows 0-2

    // What opening a show leaves: cue 1 selected in the show, nothing selected in the table.
    screen.list.setSelectedIndex (0);
    const auto image = screen.paint();

    // Rows 0 and 2 are cues 1 and 3, which share a stripe.
    check (contrast (ListOnScreen::rowColour (image, 0), ListOnScreen::rowColour (image, 2))
               >= headerContrast,
           "the selected cue stands out from an unselected one");
    check (ListOnScreen::rowColour (image, 2) == colours::panel,
           "an unselected cue keeps its own stripe");
    check (screen.table().getSelectedRow() == 0,
           "the table's selection is put on the cue too, so the arrow keys start from it");
}

void testClickedStepMarksItsWholeCue()
{
    cptest::section ("cue list: clicking a sub-cue marks its whole cue");

    ListOnScreen screen (4);
    screen.list.setStandbyIndex (0);    // rows: cue 1, Play, Fade/Stop, cue 2, cue 3, cue 4
    screen.paint();

    screen.table().selectRow (2);       // what a click on cue 1's Fade/Stop row does
    check (screen.list.getSelectedIndex() == 0, "the click selected the step's cue");

    const auto image = screen.paint();

    check (contrast (ListOnScreen::rowColour (image, 0), ListOnScreen::rowColour (image, 4))
               >= headerContrast,
           "the cue's header is marked although its header row was not the one clicked");
    check (contrast (ListOnScreen::rowColour (image, 1), stepBackground) >= stepContrast,
           "its Play row is marked");
    check (contrast (ListOnScreen::rowColour (image, 2), stepBackground) >= stepContrast,
           "its Fade/Stop row is marked");
    check (image.getPixelAt (1, ListOnScreen::headerHeight + ListOnScreen::rowHeight / 2)
               == colours::standby,
           "the standby marker is still drawn over the selection");
    check (screen.table().getSelectedRow() == 2,
           "the table keeps the step row that was clicked");
}

void testMarkFollowsItsCueWhenRowsMove()
{
    cptest::section ("cue list: the mark stays on its cue when rows move");

    ListOnScreen screen (5);
    screen.list.setStandbyIndex (0);    // rows: cue 1, Play, Fade/Stop, cue 2, cue 3, cue 4, cue 5
    screen.paint();

    screen.table().selectRow (5);       // a click on cue 4
    check (screen.list.getSelectedIndex() == 3, "the click selected cue 4");

    // GO moves on: cue 1's steps close and cue 5's open, so cue 4 moves up from row 5 to
    // row 3, and row 5 becomes cue 5's Play row.
    screen.list.setStandbyIndex (4);
    const auto image = screen.paint();

    // Rows 1 and 3 are cues 2 and 4, which share a stripe.
    check (contrast (ListOnScreen::rowColour (image, 3), ListOnScreen::rowColour (image, 1))
               >= headerContrast,
           "cue 4 is still marked, at its new row");
    check (ListOnScreen::rowColour (image, 5) == stepBackground
               && ListOnScreen::rowColour (image, 6) == stepBackground,
           "the rows that took its old place are not marked");
    check (screen.table().getSelectedRow() == 3, "the table's selection moved with cue 4");
}

} // namespace

//==============================================================================
void runCueListTests();

void runCueListTests()
{
    testOpenedShowMarksItsSelectedCue();
    testClickedStepMarksItsWholeCue();
    testMarkFollowsItsCueWhenRowsMove();
}
