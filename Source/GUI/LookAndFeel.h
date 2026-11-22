#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace cp
{

/** Colours shared across the app.

    Chosen for a dark backstage position: low overall brightness so the screen does not
    light the operator, but with GO, stop and vamp far enough apart in hue that they are
    unmistakable at a glance under pressure.
*/
namespace colours
{
    const juce::Colour background   { 0xff14161a };
    const juce::Colour panel        { 0xff1c1f26 };
    const juce::Colour panelLight   { 0xff262b34 };
    const juce::Colour outline      { 0xff333945 };
    const juce::Colour text         { 0xffe6e9ef };
    const juce::Colour textDim      { 0xff8b93a3 };

    const juce::Colour go           { 0xff2ecc71 };
    const juce::Colour stop         { 0xffe74c3c };
    const juce::Colour vamp         { 0xfff1c40f };
    const juce::Colour loop         { 0xff5dade2 };
    const juce::Colour standby      { 0xff9b59b6 };

    /** The cue being edited. Blue, well away from the standby purple: selection is what the
        inspector shows, standby is what GO fires, and the two must never look alike. */
    const juce::Colour selection    { 0xff3a7bd5 };

    const juce::Colour preWait      { 0xff7f8c8d };
    const juce::Colour meterLow     { 0xff2ecc71 };
    const juce::Colour meterHigh    { 0xffe67e22 };
    const juce::Colour meterClip    { 0xffe74c3c };
}

class SimpleCueLookAndFeel : public juce::LookAndFeel_V4
{
public:
    SimpleCueLookAndFeel();

    void drawButtonBackground (juce::Graphics&, juce::Button&, const juce::Colour& backgroundColour,
                               bool shouldDrawAsHighlighted, bool shouldDrawAsDown) override;

    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height,
                           float sliderPos, float rotaryStartAngle, float rotaryEndAngle,
                           juce::Slider&) override;
};

/** A slider that ignores the scroll wheel until it has been clicked.

    Inside a scrolling inspector an ordinary slider grabs the wheel as the pointer passes
    over it, so scrolling down the panel silently rewrites whatever the pointer crossed -
    a cue's gain, a fade time. Requiring a click first makes scrolling safe and costs one
    click when the value really is being edited.
*/
class ClickToAdjustSlider : public juce::Slider
{
public:
    ClickToAdjustSlider();

    void mouseWheelMove (const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    void focusGained (FocusChangeType) override;
    void focusLost (FocusChangeType) override;
};

/** Formats seconds as mm:ss.t, or h:mm:ss.t past an hour. Negative input gives "--:--". */
juce::String formatTime (double seconds);

/** Formats seconds to millisecond precision, for fields an operator types exact times into.
    Always mm:ss.mmm, or h:mm:ss.mmm past an hour. */
juce::String formatTimecode (double seconds);

/** Reads a time typed by hand. Accepts plain seconds ("12.5"), mm:ss ("1:02.5") and
    h:mm:ss ("1:02:03.5"). Returns @p fallback if nothing usable was typed. */
double parseTimecode (const juce::String& text, double fallback = 0.0);

} // namespace cp
