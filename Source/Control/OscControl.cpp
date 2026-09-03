#include "Control/OscControl.h"

namespace cp
{

namespace
{
    double numericArgument (const juce::Array<juce::var>& arguments, int index, double fallback)
    {
        if (! juce::isPositiveAndBelow (index, arguments.size()))
            return fallback;

        const auto& v = arguments.getReference (index);

        if (v.isDouble() || v.isInt() || v.isInt64())
            return (double) v;

        if (v.isString())
        {
            const auto s = v.toString().trim();

            if (s.containsAnyOf ("0123456789"))
                return s.getDoubleValue();
        }

        return fallback;
    }

    void addArgument (juce::OSCMessage& message, const juce::var& value)
    {
        if (value.isInt() || value.isInt64() || value.isBool())
            message.addInt32 ((juce::int32) (int) value);
        else if (value.isDouble())
            message.addFloat32 ((float) (double) value);
        else
            message.addString (value.toString());
    }
}

//==============================================================================
OscControl::OscControl()
{
    receiver.addListener (this);
}

OscControl::~OscControl()
{
    receiver.removeListener (this);
    receiver.disconnect();
    senders.clear();
}

juce::String OscControl::applySettings (const ControlSettings& settings)
{
    juce::String error;

    // --- input ----------------------------------------------------------------
    const auto wantsInput = settings.oscInputEnabled;
    const auto portChanged = settings.oscInputPort != currentPort;

    if (receiving && (! wantsInput || portChanged))
    {
        receiver.disconnect();
        receiving = false;
        currentPort = 0;
    }

    if (wantsInput && ! receiving)
    {
        if (receiver.connect (settings.oscInputPort))
        {
            receiving = true;
            currentPort = settings.oscInputPort;
        }
        else
        {
            error = "Could not listen for OSC on port " + juce::String (settings.oscInputPort)
                  + ". Another application may already be using it.";
        }
    }

    // --- outputs --------------------------------------------------------------
    // Rebuilt wholesale rather than diffed: connecting a UDP sender is cheap, and a stale
    // sender pointing at a host that has moved is worse than a moment's churn.
    senders.clear();
    targets = settings.oscTargets;

    for (const auto& target : targets)
    {
        auto sender = std::make_unique<juce::OSCSender>();

        if (target.enabled && ! sender->connect (target.host, target.port))
        {
            if (error.isEmpty())
                error = "Could not reach OSC target \"" + target.name + "\" at "
                      + target.host + ":" + juce::String (target.port) + ".";
        }

        senders.push_back (std::move (sender));
    }

    return error;
}

//==============================================================================
ControlAction OscControl::actionForAddress (const juce::String& address,
                                            const juce::Array<juce::var>& arguments)
{
    ControlAction action;
    action.origin = "OSC " + address;

    // Case is folded for ROUTING ONLY — half the OSC controllers in the world
    // capitalise differently from the other half, so the verbs and the fixed
    // path segments are matched without regard to it. The cue NUMBER is not a
    // keyword: it is operator-facing free text off the cue sheet, and `PRE`,
    // `A1` and `Q3` are all documented examples. Lower-casing the whole address
    // meant those cues could not be fired over OSC at all, and the error came
    // back quoting text the operator had never typed.
    auto path = address.trim();

    while (path.endsWithChar ('/'))
        path = path.dropLastCharacters (1);

    if (path.isEmpty())
        return action;

    // --- cue-specific: /cue/<number>/<verb> -----------------------------------
    if (path.startsWithIgnoreCase ("/cue/"))
    {
        const auto remainder = path.substring (5);
        const auto slash = remainder.lastIndexOfChar ('/');

        if (slash > 0)
        {
            const auto number = remainder.substring (0, slash);
            const auto verb   = remainder.substring (slash + 1).toLowerCase();

            action.cueNumber = number;

            if (verb == "go")               action.type = ControlActionType::goCue;
            else if (verb == "stop")        { action.type = ControlActionType::stopCue;
                                              action.value = numericArgument (arguments, 0, 0.0); }
            else if (verb == "standby")     action.type = ControlActionType::standbyCue;
            else if (verb == "select")      action.type = ControlActionType::selectCue;
            else if (verb == "audition")    action.type = ControlActionType::auditionCue;
            else if (verb == "releasevamp") action.type = ControlActionType::releaseVampCue;
            else                            action.cueNumber.clear();

            if (action.isValid())
                return action;
        }

        // /cue/go is a synonym for /go, for controllers that like a namespace.
        if (remainder.equalsIgnoreCase ("go"))
        {
            action.type = ControlActionType::go;
            return action;
        }
    }

    // --- standby --------------------------------------------------------------
    if (path.startsWithIgnoreCase ("/standby/"))
    {
        const auto rest = path.substring (9);

        if (rest.equalsIgnoreCase ("next"))          action.type = ControlActionType::standbyNext;
        else if (rest.equalsIgnoreCase ("previous")
                 || rest.equalsIgnoreCase ("prev"))  action.type = ControlActionType::standbyPrevious;
        else
        {
            action.type = ControlActionType::standbyCue;
            action.cueNumber = rest;   // as typed — see the note above
        }

        return action;
    }

    // --- global ---------------------------------------------------------------
    const auto verb = path.toLowerCase();

    if (verb == "/go")                    action.type = ControlActionType::go;
    else if (verb == "/stop")             { action.type = ControlActionType::stopAll;
                                            action.value = numericArgument (arguments, 0, 2.0); }
    else if (verb == "/stopall")          { action.type = ControlActionType::stopAll;
                                            action.value = numericArgument (arguments, 0, 2.0); }
    else if (verb == "/panic")            action.type = ControlActionType::panic;
    else if (verb == "/pause")            action.type = ControlActionType::pause;
    else if (verb == "/resume")           action.type = ControlActionType::resume;
    else if (verb == "/pause/toggle")     action.type = ControlActionType::pauseToggle;
    else if (verb == "/releasevamp")      action.type = ControlActionType::releaseVamp;
    else if (verb == "/master/level")     { action.type = ControlActionType::masterLevel;
                                            action.value = numericArgument (arguments, 0, 0.0); }

    return action;
}

//==============================================================================
void OscControl::oscMessageReceived (const juce::OSCMessage& message)
{
    handleMessage (message);
}

void OscControl::oscBundleReceived (const juce::OSCBundle& bundle)
{
    for (const auto& element : bundle)
    {
        if (element.isMessage())
            handleMessage (element.getMessage());
        else if (element.isBundle())
            oscBundleReceived (element.getBundle());
    }
}

void OscControl::handleMessage (const juce::OSCMessage& message)
{
    const auto address = message.getAddressPattern().toString();

    juce::Array<juce::var> arguments;

    for (const auto& argument : message)
    {
        if (argument.isFloat32())      arguments.add ((double) argument.getFloat32());
        else if (argument.isInt32())   arguments.add ((int) argument.getInt32());
        else if (argument.isString())  arguments.add (argument.getString());
    }

    if (address.trim().toLowerCase().startsWith ("/status/query"))
    {
        if (onActivity != nullptr)
            onActivity (address, true);

        if (onStateQuery != nullptr)
            onStateQuery();

        return;
    }

    const auto action = actionForAddress (address, arguments);

    if (onActivity != nullptr)
        onActivity (address, action.isValid());

    if (action.isValid() && onAction != nullptr)
        onAction (action);
}

//==============================================================================
bool OscControl::send (const ControlMessage& message)
{
    if (message.type != ControlMessageType::osc || message.oscAddress.isEmpty())
        return false;

    juce::OSCMessage out { juce::OSCAddressPattern (message.oscAddress) };

    for (const auto& argument : parseOscArguments (message.oscArguments))
        addArgument (out, argument);

    bool sentAnything = false;

    for (size_t i = 0; i < senders.size() && i < targets.size(); ++i)
    {
        if (! targets[i].enabled)
            continue;

        if (message.oscTarget.isNotEmpty() && targets[i].name != message.oscTarget)
            continue;

        sentAnything |= senders[i]->send (out);
    }

    return sentAnything;
}

void OscControl::broadcast (const juce::String& address, const juce::Array<juce::var>& arguments)
{
    if (address.isEmpty())
        return;

    juce::OSCMessage out { juce::OSCAddressPattern (address) };

    for (const auto& argument : arguments)
        addArgument (out, argument);

    for (size_t i = 0; i < senders.size() && i < targets.size(); ++i)
        if (targets[i].enabled)
            senders[i]->send (out);
}

} // namespace cp
