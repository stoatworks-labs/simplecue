#include "Model/CueList.h"

namespace cp
{

Cue* CueList::get (int index) noexcept
{
    return juce::isPositiveAndBelow (index, size()) ? &cues[(size_t) index] : nullptr;
}

const Cue* CueList::get (int index) const noexcept
{
    return juce::isPositiveAndBelow (index, size()) ? &cues[(size_t) index] : nullptr;
}

int CueList::indexOfID (const juce::Uuid& id) const noexcept
{
    for (int i = 0; i < size(); ++i)
        if (cues[(size_t) i].id == id)
            return i;

    return -1;
}

Cue* CueList::findByID (const juce::Uuid& id) noexcept
{
    return get (indexOfID (id));
}

const Cue* CueList::findByID (const juce::Uuid& id) const noexcept
{
    return get (indexOfID (id));
}

int CueList::insert (Cue cue, int index)
{
    if (! juce::isPositiveAndBelow (index, size() + 1))
        index = size();

    cues.insert (cues.begin() + index, std::move (cue));

    // Keep the operator's positions pointing at the same cues they were before.
    if (selectedIndex >= index) ++selectedIndex;
    if (standbyIndex  >= index) ++standbyIndex;

    clampPositions();
    sendChangeMessage();
    return index;
}

void CueList::remove (int index)
{
    if (! juce::isPositiveAndBelow (index, size()))
        return;

    cues.erase (cues.begin() + index);

    if (selectedIndex > index) --selectedIndex;
    if (standbyIndex  > index) --standbyIndex;

    clampPositions();
    sendChangeMessage();
}

void CueList::removeByID (const juce::Uuid& id)
{
    remove (indexOfID (id));
}

void CueList::move (int fromIndex, int toIndex)
{
    if (! juce::isPositiveAndBelow (fromIndex, size()) || fromIndex == toIndex)
        return;

    toIndex = juce::jlimit (0, size() - 1, toIndex);

    const auto selectedID = get (selectedIndex) != nullptr ? get (selectedIndex)->id : juce::Uuid::null();
    const auto standbyID  = get (standbyIndex)  != nullptr ? get (standbyIndex)->id  : juce::Uuid::null();

    auto moved = std::move (cues[(size_t) fromIndex]);
    cues.erase (cues.begin() + fromIndex);
    cues.insert (cues.begin() + toIndex, std::move (moved));

    // Reordering should not move the operator's cursor onto a different cue.
    if (! selectedID.isNull()) selectedIndex = indexOfID (selectedID);
    if (! standbyID.isNull())  standbyIndex  = indexOfID (standbyID);

    clampPositions();
    sendChangeMessage();
}

int CueList::moveToGap (int fromIndex, int gapIndex)
{
    if (! juce::isPositiveAndBelow (fromIndex, size()) || gapIndex < 0 || gapIndex > size())
        return -1;

    // Lifting the cue out closes up the list, so every gap below it moves up by one.
    const auto toIndex = gapIndex > fromIndex ? gapIndex - 1 : gapIndex;

    if (toIndex == fromIndex)
        return -1;

    move (fromIndex, toIndex);
    return toIndex;
}

void CueList::replace (int index, Cue cue)
{
    if (! juce::isPositiveAndBelow (index, size()))
        return;

    cues[(size_t) index] = std::move (cue);
    sendChangeMessage();
}

bool CueList::modify (int index, const std::function<void (Cue&)>& fn)
{
    if (! juce::isPositiveAndBelow (index, size()) || fn == nullptr)
        return false;

    fn (cues[(size_t) index]);

    // An edit can change how many steps a cue has - turning a vamp off removes its devamp -
    // so the standby step has to be re-clamped, or GO would point past the end of the list.
    clampPositions();

    sendChangeMessage();
    return true;
}

bool CueList::modifyByID (const juce::Uuid& id, const std::function<void (Cue&)>& fn)
{
    return modify (indexOfID (id), fn);
}

void CueList::clear()
{
    cues.clear();
    selectedIndex = -1;
    standbyIndex  = -1;
    standbyStep   = cueHeaderStep;
    sendChangeMessage();
}

juce::String CueList::suggestNextNumber() const
{
    int highest = 0;

    for (const auto& c : cues)
        highest = juce::jmax (highest, c.number.getIntValue());

    return juce::String (highest + 1);
}

void CueList::setSelectedIndex (int index)
{
    const auto clamped = isEmpty() ? -1 : juce::jlimit (-1, size() - 1, index);

    if (clamped != selectedIndex)
    {
        selectedIndex = clamped;
        sendChangeMessage();
    }
}

void CueList::setStandbyIndex (int index)
{
    setStandbyPosition (index, cueHeaderStep);
}

void CueList::setStandbyPosition (int index, int step)
{
    const auto clampedIndex = isEmpty() ? -1 : juce::jlimit (-1, size() - 1, index);
    const auto numSteps = (int) stepsFor (clampedIndex).size();
    const auto clampedStep = juce::jlimit (cueHeaderStep, juce::jmax (cueHeaderStep, numSteps - 1), step);

    if (clampedIndex == standbyIndex && clampedStep == standbyStep)
        return;

    standbyIndex = clampedIndex;
    standbyStep = clampedStep;
    sendChangeMessage();
}

std::vector<CueStep> CueList::stepsFor (int index) const
{
    if (const auto* cue = get (index))
        return buildCueSteps (*cue);

    return {};
}

std::optional<CueStep> CueList::getStandbyStepInfo() const
{
    const auto steps = stepsFor (standbyIndex);

    if (! juce::isPositiveAndBelow (standbyStep, (int) steps.size()))
        return {};

    return steps[(size_t) standbyStep];
}

void CueList::advanceStandby()
{
    if (isEmpty())
        return;

    const auto steps = stepsFor (standbyIndex);
    const auto numSteps = (int) steps.size();

    if (standbyStep == cueHeaderStep)
    {
        const auto* cue = get (standbyIndex);

        // Firing the cue itself already fired its Play sub-cue, so standby skips over it
        // rather than offering to play the same thing twice.
        const auto firstSubCue = (cue != nullptr && cue->firePlayWithCue) ? 1 : 0;

        if (firstSubCue < numSteps)
        {
            setStandbyPosition (standbyIndex, firstSubCue);
            return;
        }
    }
    else if (standbyStep + 1 < numSteps)
    {
        setStandbyPosition (standbyIndex, standbyStep + 1);
        return;
    }

    // Deliberately stops on the last cue rather than wrapping: an accidental extra GO at
    // the end of a show should do nothing, not restart the top of the list.
    if (standbyIndex < size() - 1)
        setStandbyPosition (standbyIndex + 1, cueHeaderStep);
    else
        setStandbyPosition (size() - 1, juce::jmax (cueHeaderStep, numSteps - 1));
}

const Cue* CueList::getStandbyCue() const noexcept
{
    return get (standbyIndex);
}

const Cue* CueList::resolveLinkTarget (int fromIndex) const noexcept
{
    const auto* from = get (fromIndex);

    if (from == nullptr)
        return nullptr;

    if (! from->link.targetsNextCue())
        return findByID (from->link.target);

    return get (fromIndex + 1);
}

void CueList::clampPositions()
{
    if (isEmpty())
    {
        selectedIndex = -1;
        standbyIndex  = -1;
        standbyStep   = cueHeaderStep;
        return;
    }

    selectedIndex = juce::jlimit (-1, size() - 1, selectedIndex);
    standbyIndex  = juce::jlimit (-1, size() - 1, standbyIndex);

    // Editing a cue can remove a sub-cue - turning a vamp off drops its devamp - so the
    // standby step has to be pulled back into range rather than pointing past the end.
    const auto numSteps = (int) stepsFor (standbyIndex).size();
    standbyStep = juce::jlimit (cueHeaderStep, juce::jmax (cueHeaderStep, numSteps - 1), standbyStep);
}

//==============================================================================
juce::var CueList::toVar (const juce::File& showDirectory) const
{
    juce::Array<juce::var> arr;

    for (const auto& c : cues)
        arr.add (c.toVar (showDirectory));

    return arr;
}

void CueList::restoreFromVar (const juce::var& v, const juce::File& showDirectory)
{
    cues.clear();

    if (const auto* arr = v.getArray())
        for (const auto& item : *arr)
            cues.push_back (Cue::fromVar (item, showDirectory));

    selectedIndex = isEmpty() ? -1 : 0;
    standbyIndex  = isEmpty() ? -1 : 0;
    standbyStep   = cueHeaderStep;

    sendChangeMessage();
}

} // namespace cp
