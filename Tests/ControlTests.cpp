/*
    Tests for the control layer: the wire formats, the mappings they resolve to, and the
    edge detection that sits between a lighting desk and a GO.

    Everything here is exercised through the real production functions. The packet builders
    below construct genuine Art-Net and sACN frames byte by byte rather than reusing the
    parser's own idea of the layout, so a mistake in the parser cannot cancel out against a
    matching mistake in the test.
*/

#include "TestHarness.h"

#include "Control/ControlSettings.h"
#include "Control/DmxControl.h"
#include "Control/MidiControl.h"
#include "Control/OscControl.h"
#include "GUI/LookAndFeel.h"
#include "Model/Cue.h"
#include "Model/CueList.h"
#include "Model/CueStep.h"
#include "Model/Show.h"
#include "Model/StreamingSettings.h"
#include "Model/ControlMessage.h"

#include <cstring>
#include <vector>

using namespace cp;
using cptest::check;
using cptest::checkNear;
using cptest::checkEqual;

namespace
{

//==============================================================================
std::vector<juce::uint8> buildArtNetPacket (int universe, const std::vector<juce::uint8>& slots)
{
    std::vector<juce::uint8> packet (18, 0);

    std::memcpy (packet.data(), "Art-Net\0", 8);
    packet[8]  = 0x00;                       // OpCode low  (little-endian 0x5000)
    packet[9]  = 0x50;                       // OpCode high
    packet[10] = 0x00;                       // Protocol version high
    packet[11] = 14;                         // Protocol version low
    packet[12] = 0;                          // Sequence
    packet[13] = 0;                          // Physical
    packet[14] = (juce::uint8) (universe & 0xff);          // Sub-net + universe
    packet[15] = (juce::uint8) ((universe >> 8) & 0x7f);   // Net
    packet[16] = (juce::uint8) ((slots.size() >> 8) & 0xff);
    packet[17] = (juce::uint8) (slots.size() & 0xff);

    packet.insert (packet.end(), slots.begin(), slots.end());
    return packet;
}

std::vector<juce::uint8> buildSacnPacket (int universe, const std::vector<juce::uint8>& slots,
                                          juce::uint8 options = 0)
{
    std::vector<juce::uint8> packet (126, 0);

    packet[0] = 0x00; packet[1] = 0x10;      // Preamble size
    packet[2] = 0x00; packet[3] = 0x00;      // Post-amble size
    std::memcpy (packet.data() + 4, "ASC-E1.17\0\0\0", 12);

    // Root vector: E1.31 data.
    packet[18] = 0x00; packet[19] = 0x00; packet[20] = 0x00; packet[21] = 0x04;

    // Framing vector: data packet.
    packet[40] = 0x00; packet[41] = 0x00; packet[42] = 0x00; packet[43] = 0x02;

    packet[108] = 100;                       // Priority
    packet[111] = 0;                         // Sequence
    packet[112] = options;
    packet[113] = (juce::uint8) ((universe >> 8) & 0xff);
    packet[114] = (juce::uint8) (universe & 0xff);

    packet[117] = 0x02;                      // DMP vector
    packet[118] = 0xa1;                      // Address and data type
    packet[121] = 0x00; packet[122] = 0x01;  // Address increment

    const auto propertyCount = slots.size() + 1;   // Start code counts as a property
    packet[123] = (juce::uint8) ((propertyCount >> 8) & 0xff);
    packet[124] = (juce::uint8) (propertyCount & 0xff);
    packet[125] = 0x00;                      // DMX start code

    packet.insert (packet.end(), slots.begin(), slots.end());
    return packet;
}

/** A 512-slot frame with everything at zero except the addresses given. */
std::vector<juce::uint8> slotsWith (const std::map<int, juce::uint8>& levels)
{
    std::vector<juce::uint8> slots (512, 0);

    for (const auto& [address, level] : levels)
        if (juce::isPositiveAndBelow (address - 1, 512))
            slots[(size_t) (address - 1)] = level;

    return slots;
}

DmxFrame frameWith (int universe, const std::map<int, juce::uint8>& levels)
{
    DmxFrame frame;
    frame.universe = universe;
    frame.numSlots = 512;

    const auto slots = slotsWith (levels);
    std::memcpy (frame.slots, slots.data(), slots.size());
    return frame;
}

bool containsAction (const std::vector<ControlAction>& actions, ControlActionType type)
{
    for (const auto& a : actions)
        if (a.type == type)
            return true;

    return false;
}

const ControlAction* findAction (const std::vector<ControlAction>& actions, ControlActionType type)
{
    for (const auto& a : actions)
        if (a.type == type)
            return &a;

    return nullptr;
}

//==============================================================================
void testOscAddresses()
{
    cptest::section ("OSC address scheme");

    const juce::Array<juce::var> none;

    check (OscControl::actionForAddress ("/go", none).type == ControlActionType::go,
           "/go fires the standby cue");
    check (OscControl::actionForAddress ("/GO", none).type == ControlActionType::go,
           "addresses are matched case-insensitively");
    check (OscControl::actionForAddress ("/go/", none).type == ControlActionType::go,
           "a trailing slash is tolerated");
    check (OscControl::actionForAddress ("/cue/go", none).type == ControlActionType::go,
           "/cue/go is a synonym for /go");
    check (OscControl::actionForAddress ("/panic", none).type == ControlActionType::panic,
           "/panic maps to panic");
    check (OscControl::actionForAddress ("/pause", none).type == ControlActionType::pause,
           "/pause maps to pause");
    check (OscControl::actionForAddress ("/resume", none).type == ControlActionType::resume,
           "/resume maps to resume");
    check (OscControl::actionForAddress ("/pause/toggle", none).type == ControlActionType::pauseToggle,
           "/pause/toggle maps to a toggle");
    check (OscControl::actionForAddress ("/releasevamp", none).type == ControlActionType::releaseVamp,
           "/releasevamp releases every vamp");
    check (OscControl::actionForAddress ("/standby/next", none).type == ControlActionType::standbyNext,
           "/standby/next steps forward");
    check (OscControl::actionForAddress ("/standby/previous", none).type == ControlActionType::standbyPrevious,
           "/standby/previous steps back");

    {
        const auto action = OscControl::actionForAddress ("/cue/12.5/go", none);
        check (action.type == ControlActionType::goCue, "/cue/<n>/go fires a specific cue");
        checkEqual (action.cueNumber, "12.5", "the cue number is taken from the address");
    }

    {
        const auto action = OscControl::actionForAddress ("/cue/7/stop", { 4.5 });
        check (action.type == ControlActionType::stopCue, "/cue/<n>/stop stops one cue");
        checkEqual (action.cueNumber, "7", "cue number parsed for a stop");
        checkNear (action.value, 4.5, 1.0e-9, "the fade time comes from the first argument");
    }

    {
        // No argument at all must not become a 0-second fade by accident.
        const auto action = OscControl::actionForAddress ("/stop", none);
        check (action.type == ControlActionType::stopAll, "/stop stops everything");
        checkNear (action.value, 2.0, 1.0e-9, "stop-all defaults to a two-second fade");
    }

    {
        const auto action = OscControl::actionForAddress ("/stop", { 0 });
        checkNear (action.value, 0.0, 1.0e-9, "an explicit zero fade is honoured, not defaulted");
    }

    {
        const auto action = OscControl::actionForAddress ("/master/level", { -6.0 });
        check (action.type == ControlActionType::masterLevel, "/master/level sets the master");
        checkNear (action.value, -6.0, 1.0e-9, "the level comes from the argument");
    }

    {
        const auto action = OscControl::actionForAddress ("/standby/3", none);
        check (action.type == ControlActionType::standbyCue, "/standby/<n> stands by a cue");
        checkEqual (action.cueNumber, "3", "standby cue number parsed");
    }

    // A cue number is free text off the cue sheet, not a keyword. The address
    // used to be lower-cased whole, so a cue numbered PRE, A1 or Q3 could not be
    // fired over OSC at all — and the error quoted "pre", text the operator had
    // never typed, pointing the diagnosis away from the cause. Only the verbs
    // and the fixed segments are case-folded.
    {
        const auto action = OscControl::actionForAddress ("/cue/PRE/go", none);
        check (action.type == ControlActionType::goCue, "/cue/PRE/go is a cue fire");
        checkEqual (action.cueNumber, "PRE", "an alphabetic cue number keeps its case");
    }

    {
        const auto action = OscControl::actionForAddress ("/cue/A1/standby", none);
        check (action.type == ControlActionType::standbyCue, "/cue/A1/standby stands a cue by");
        checkEqual (action.cueNumber, "A1", "a mixed cue number keeps its case");
    }

    {
        const auto action = OscControl::actionForAddress ("/cue/Q3/GO", none);
        check (action.type == ControlActionType::goCue, "the verb is still case-insensitive");
        checkEqual (action.cueNumber, "Q3", "case-folding the verb does not fold the number");
    }

    {
        const auto action = OscControl::actionForAddress ("/STANDBY/PRE", none);
        check (action.type == ControlActionType::standbyCue, "/STANDBY/<n> still routes");
        checkEqual (action.cueNumber, "PRE", "standby keeps the cue number's case too");
    }

    {
        const auto action = OscControl::actionForAddress ("/CUE/12.5/go", none);
        check (action.type == ControlActionType::goCue, "an upper-cased /CUE/ still routes");
        checkEqual (action.cueNumber, "12.5", "a numeric cue number is unaffected");
    }

    check (! OscControl::actionForAddress ("/something/else", none).isValid(),
           "an unknown address produces no action");
    check (! OscControl::actionForAddress ("/cue/12/frobnicate", none).isValid(),
           "an unknown cue verb produces no action");
    check (! OscControl::actionForAddress ("", none).isValid(),
           "an empty address produces no action");
}

void testOscArguments()
{
    cptest::section ("OSC argument parsing");

    {
        const auto args = parseOscArguments ("1 2.5 hello");
        check (args.size() == 3, "three arguments parsed");
        check (args[0].isInt(), "a whole number becomes an int");
        check (args[1].isDouble(), "a decimal becomes a float");
        check (args[2].isString(), "a word becomes a string");
        checkNear ((double) args[1], 2.5, 1.0e-6, "the float value is right");
    }

    {
        const auto args = parseOscArguments ("\"two words\" 3");
        check (args.size() == 2, "a quoted string counts as one argument");
        checkEqual (args[0].toString(), "two words", "quotes hold a space-containing string together");
        check (args[1].isInt(), "parsing continues after the closing quote");
    }

    {
        // Without quoting, "42" would be sent as an int; a receiver expecting a string
        // needs a way to force it.
        const auto args = parseOscArguments ("\"42\"");
        check (args.size() == 1 && args[0].isString(), "quoting forces a number to stay a string");
    }

    {
        const auto args = parseOscArguments ("  -3   +7  ");
        check (args.size() == 2, "extra whitespace is ignored");
        check ((int) args[0] == -3 && (int) args[1] == 7, "signs are parsed");
    }

    check (parseOscArguments ("").isEmpty(), "an empty argument string yields nothing");
}

//==============================================================================
void testShowControl()
{
    cptest::section ("MIDI Show Control");

    ControlMessage message;
    message.type = ControlMessageType::midiShowControl;
    message.mscDeviceID = 5;
    message.mscCommandFormat = msc::formatLighting;
    message.mscCommand = msc::commandGo;
    message.mscCueNumber = "12.5";
    message.mscCueList = "3";

    const auto sysex = buildShowControlMessage (message);
    check (sysex.isSysEx(), "an MSC message is sysex");

    IncomingMsc decoded;
    check (parseShowControlMessage (sysex, decoded), "the message we built parses back");
    check (decoded.deviceID == 5, "device id round trips");
    check (decoded.commandFormat == msc::formatLighting, "command format round trips");
    check (decoded.command == msc::commandGo, "command round trips");
    checkEqual (decoded.cueNumber, "12.5", "cue number round trips");
    checkEqual (decoded.cueList, "3", "cue list round trips");

    // A note-on is not MSC, and must not be mistaken for one.
    check (! parseShowControlMessage (juce::MidiMessage::noteOn (1, 60, (juce::uint8) 100), decoded),
           "a channel message is not mistaken for MSC");

    // MMC shares the 0x7f universal prefix but uses sub-id 0x06 instead of 0x02.
    ControlMessage mmcMessage;
    mmcMessage.type = ControlMessageType::midiMachineControl;
    mmcMessage.mmcCommand = mmc::commandPlay;
    check (! parseShowControlMessage (buildMachineControlMessage (mmcMessage), decoded),
           "MMC is not mistaken for MSC");

    cptest::section ("MSC to action mapping");

    ControlSettings settings;
    settings.mscDeviceID = 5;
    settings.mscRespondToSoundFormat = true;
    settings.mscRespondToAllTypesFormat = true;

    const auto mscFor = [] (int deviceID, juce::uint8 format, juce::uint8 command,
                            const juce::String& cueNumber)
    {
        IncomingMsc m;
        m.deviceID = deviceID;
        m.commandFormat = format;
        m.command = command;
        m.cueNumber = cueNumber;
        return m;
    };

    {
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatSound, msc::commandGo, "8"), settings);
        check (action.type == ControlActionType::goCue, "a sound-format GO fires a cue");
        checkEqual (action.cueNumber, "8", "the cue number carries through");
    }

    {
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatSound, msc::commandGo, ""), settings);
        check (action.type == ControlActionType::go,
               "a GO with no cue number fires the standby cue");
    }

    {
        // 127 is the all-call device id and must be honoured whatever our own id is.
        const auto action = MidiControl::actionForShowControl (
            mscFor (127, msc::formatSound, msc::commandGo, "2"), settings);
        check (action.type == ControlActionType::goCue, "an all-call GO is accepted");
    }

    {
        const auto action = MidiControl::actionForShowControl (
            mscFor (9, msc::formatSound, msc::commandGo, "2"), settings);
        check (! action.isValid(), "a GO addressed to another device id is ignored");
    }

    {
        // Lighting-format traffic is for the lighting desk, not for us.
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatLighting, msc::commandGo, "2"), settings);
        check (! action.isValid(), "a command format we do not answer is ignored");
    }

    {
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatAllTypes, msc::commandGo, "2"), settings);
        check (action.type == ControlActionType::goCue, "all-types format is answered");
    }

    {
        auto strict = settings;
        strict.mscRespondToAllTypesFormat = false;
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatAllTypes, msc::commandGo, "2"), strict);
        check (! action.isValid(), "all-types can be switched off");
    }

    {
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatSound, msc::commandAllOff, ""), settings);
        check (action.type == ControlActionType::stopAll, "ALL OFF stops everything");
        checkNear (action.value, 0.0, 1.0e-9, "ALL OFF does not fade");
    }

    {
        const auto action = MidiControl::actionForShowControl (
            mscFor (5, msc::formatSound, msc::commandResume, ""), settings);
        check (action.type == ControlActionType::resume, "RESUME resumes");
    }

    {
        auto listenToEverything = settings;
        listenToEverything.mscDeviceID = 127;
        const auto action = MidiControl::actionForShowControl (
            mscFor (42, msc::formatSound, msc::commandGo, "1"), listenToEverything);
        check (action.type == ControlActionType::goCue,
               "device id 127 in our settings listens to every device");
    }
}

void testMachineControl()
{
    cptest::section ("MIDI Machine Control");

    ControlMessage message;
    message.type = ControlMessageType::midiMachineControl;
    message.mscDeviceID = 12;
    message.mmcCommand = mmc::commandStop;

    int deviceID = 0;
    juce::uint8 command = 0;
    check (parseMachineControlMessage (buildMachineControlMessage (message), deviceID, command),
           "an MMC message we built parses back");
    check (deviceID == 12, "MMC device id round trips");
    check (command == mmc::commandStop, "MMC command round trips");

    check (MidiControl::actionForMachineControl (mmc::commandPlay).type == ControlActionType::go,
           "MMC play fires a GO");
    check (MidiControl::actionForMachineControl (mmc::commandDeferredPlay).type == ControlActionType::go,
           "MMC deferred play fires a GO");
    check (MidiControl::actionForMachineControl (mmc::commandStop).type == ControlActionType::stopAll,
           "MMC stop stops everything");
    check (MidiControl::actionForMachineControl (mmc::commandPause).type == ControlActionType::pauseToggle,
           "MMC pause toggles");
    check (! MidiControl::actionForMachineControl (0x7d).isValid(),
           "an MMC command we do not handle produces no action");
}

void testMidiBindings()
{
    cptest::section ("MIDI note / CC bindings");

    ControlSettings settings;

    MidiBinding noteBinding;
    noteBinding.kind = MidiTriggerKind::noteOn;
    noteBinding.channel = 1;
    noteBinding.number = 60;
    noteBinding.action = ControlActionType::go;
    settings.midiBindings.push_back (noteBinding);

    MidiBinding anyChannel;
    anyChannel.kind = MidiTriggerKind::noteOn;
    anyChannel.channel = 0;                    // any
    anyChannel.number = 62;
    anyChannel.action = ControlActionType::panic;
    settings.midiBindings.push_back (anyChannel);

    MidiBinding fader;
    fader.kind = MidiTriggerKind::controlChange;
    fader.channel = 1;
    fader.number = 7;
    fader.useValueAsLevel = true;
    fader.action = ControlActionType::masterLevel;
    settings.midiBindings.push_back (fader);

    check (MidiControl::actionForChannelMessage (
               juce::MidiMessage::noteOn (1, 60, (juce::uint8) 100), settings).type
           == ControlActionType::go,
           "a bound note fires its action");

    check (! MidiControl::actionForChannelMessage (
               juce::MidiMessage::noteOn (2, 60, (juce::uint8) 100), settings).isValid(),
           "the same note on another channel does not fire");

    check (MidiControl::actionForChannelMessage (
               juce::MidiMessage::noteOn (9, 62, (juce::uint8) 100), settings).type
           == ControlActionType::panic,
           "a channel-0 binding matches any channel");

    // A note-on at velocity 0 is a note-off. Treating it as a trigger would fire every cue
    // twice on any controller that releases that way.
    check (! MidiControl::actionForChannelMessage (
               juce::MidiMessage::noteOn (1, 60, (juce::uint8) 0), settings).isValid(),
           "a zero-velocity note-on does not re-fire the cue");

    check (! MidiControl::actionForChannelMessage (
               juce::MidiMessage::noteOff (1, 60), settings).isValid(),
           "a note-off does not fire");

    check (! MidiControl::actionForChannelMessage (
               juce::MidiMessage::noteOn (1, 61, (juce::uint8) 100), settings).isValid(),
           "an unbound note does nothing");

    {
        const auto action = MidiControl::actionForChannelMessage (
            juce::MidiMessage::controllerEvent (1, 7, 127), settings);
        check (action.type == ControlActionType::masterLevel, "a bound CC drives the master level");
        checkNear (action.value, 0.0, 0.001, "a full fader is 0 dB");
    }

    {
        const auto action = MidiControl::actionForChannelMessage (
            juce::MidiMessage::controllerEvent (1, 7, 0), settings);
        checkNear (action.value, -100.0, 0.001, "a closed fader is silence, not -60 dB");
    }

    {
        const auto action = MidiControl::actionForChannelMessage (
            juce::MidiMessage::controllerEvent (1, 7, 64), settings);
        // -60 dB + (64/127) * 60 dB.
        checkNear (action.value, -29.76, 0.05, "the middle of the fader is halfway down the range");
    }
}

//==============================================================================
void testArtNetParsing()
{
    cptest::section ("Art-Net packet parsing");

    {
        auto packet = buildArtNetPacket (1, { 10, 20, 30, 40 });
        DmxFrame frame;

        check (parseArtNetPacket (packet.data(), (int) packet.size(), frame),
               "a well-formed ArtDmx packet parses");
        check (frame.universe == 1, "universe decoded");
        check (frame.numSlots == 4, "slot count decoded");
        check (frame.levelAt (1) == 10 && frame.levelAt (4) == 40,
               "slots are addressed the way a desk numbers them, from 1");
        check (frame.levelAt (5) == 0, "reading past the end of the frame gives zero");
        check (frame.levelAt (0) == 0, "address 0 is not a valid DMX slot");
    }

    {
        // Universe is 15 bits: the low byte is sub-net + universe, the high byte is Net.
        auto packet = buildArtNetPacket (0x0105, { 1 });
        DmxFrame frame;
        check (parseArtNetPacket (packet.data(), (int) packet.size(), frame), "high universe parses");
        check (frame.universe == 0x0105, "the Net byte contributes to the universe number");
    }

    {
        auto packet = buildArtNetPacket (1, { 1, 2, 3 });
        packet[0] = 'X';
        DmxFrame frame;
        check (! parseArtNetPacket (packet.data(), (int) packet.size(), frame),
               "a packet with the wrong identifier is rejected");
    }

    {
        // ArtPoll and friends share the port; only ArtDmx carries levels.
        auto packet = buildArtNetPacket (1, { 1, 2, 3 });
        packet[8] = 0x00; packet[9] = 0x20;
        DmxFrame frame;
        check (! parseArtNetPacket (packet.data(), (int) packet.size(), frame),
               "a non-ArtDmx opcode is rejected");
    }

    {
        auto packet = buildArtNetPacket (1, { 1, 2, 3 });
        packet[11] = 13;
        DmxFrame frame;
        check (! parseArtNetPacket (packet.data(), (int) packet.size(), frame),
               "an old protocol version is rejected");
    }

    {
        // A packet claiming more data than it carries must not read past its own buffer.
        auto packet = buildArtNetPacket (1, { 1, 2, 3 });
        packet[16] = 0x01; packet[17] = 0xf4;   // says 500 slots, carries 3
        DmxFrame frame;
        check (parseArtNetPacket (packet.data(), (int) packet.size(), frame),
               "an over-declared length still parses");
        check (frame.numSlots == 3, "the slot count is clamped to what actually arrived");
    }

    {
        DmxFrame frame;
        check (! parseArtNetPacket (nullptr, 0, frame), "a null packet is rejected");

        auto packet = buildArtNetPacket (1, {});
        check (! parseArtNetPacket (packet.data(), (int) packet.size(), frame),
               "a packet with no slots is rejected");
    }
}

void testSacnParsing()
{
    cptest::section ("sACN packet parsing");

    {
        auto packet = buildSacnPacket (3, { 5, 6, 7 });
        DmxFrame frame;

        check (parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "a well-formed E1.31 data packet parses");
        check (frame.universe == 3, "universe decoded");
        check (frame.numSlots == 3, "slot count decoded from the property count");
        check (frame.levelAt (1) == 5 && frame.levelAt (3) == 7, "slot levels decoded");
    }

    {
        // Bit 7 of the options byte marks preview data, which by spec must not drive live
        // output — a designer working blind should not fire a sound cue.
        auto packet = buildSacnPacket (3, { 255, 255 }, 0x80);
        DmxFrame frame;
        check (! parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "preview packets are ignored");
    }

    {
        auto packet = buildSacnPacket (3, { 255 }, 0x40);
        DmxFrame frame;
        check (! parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "stream-terminated packets are ignored");
    }

    {
        auto packet = buildSacnPacket (3, { 1 });
        packet[4] = 'X';
        DmxFrame frame;
        check (! parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "a wrong ACN identifier is rejected");
    }

    {
        // Synchronisation packets carry no levels of their own.
        auto packet = buildSacnPacket (3, { 1 });
        packet[43] = 0x01;
        DmxFrame frame;
        check (! parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "a sync packet is rejected");
    }

    {
        auto packet = buildSacnPacket (3, { 1 });
        packet[125] = 0xdd;                     // Not the DMX start code
        DmxFrame frame;
        check (! parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "a non-zero start code is rejected");
    }

    {
        auto packet = buildSacnPacket (3, { 1, 2, 3 });
        packet[123] = 0x02; packet[124] = 0x00;  // Claims 511 slots, carries 3
        DmxFrame frame;
        check (parseSacnPacket (packet.data(), (int) packet.size(), frame),
               "an over-declared property count still parses");
        check (frame.numSlots == 3, "the slot count is clamped to what actually arrived");
    }

    {
        DmxFrame frame;
        std::vector<juce::uint8> tooShort (40, 0);
        check (! parseSacnPacket (tooShort.data(), (int) tooShort.size(), frame),
               "a truncated packet is rejected rather than read past");
    }

    checkEqual (dmx::sacnMulticastAddress (1), "239.255.0.1", "multicast group for universe 1");
    checkEqual (dmx::sacnMulticastAddress (300), "239.255.1.44", "multicast group for universe 300");
}

//==============================================================================
void testDmxTriggering()
{
    cptest::section ("DMX triggering");

    DmxSettings settings;
    settings.universe = 1;
    settings.startAddress = 10;
    settings.triggerThreshold = 128;
    settings.numDirectCueChannels = 8;

    const auto go = settings.startAddress + DmxSettings::offsetGo;
    const auto panicAddress = settings.startAddress + DmxSettings::offsetPanic;
    const auto pause = settings.startAddress + DmxSettings::offsetPause;
    const auto master = settings.startAddress + DmxSettings::offsetMasterLevel;
    const auto standby = settings.startAddress + DmxSettings::offsetStandbySelect;
    const auto firstCue = settings.startAddress + DmxSettings::offsetFirstDirectCue;

    {
        DmxTriggerState state;

        // The very first frame only arms the detector. Connecting to a desk already
        // holding GO high must not fire a cue the moment the cable goes in.
        auto actions = state.processFrame (frameWith (1, { { go, 255 } }), settings);
        check (actions.empty(), "the first frame arms rather than fires");

        // Still held: no edge, so still nothing.
        actions = state.processFrame (frameWith (1, { { go, 255 } }), settings);
        check (actions.empty(), "a held channel does not re-fire every frame");

        actions = state.processFrame (frameWith (1, {}), settings);
        check (actions.empty(), "releasing does not fire");

        actions = state.processFrame (frameWith (1, { { go, 255 } }), settings);
        check (containsAction (actions, ControlActionType::go), "a fresh rise fires GO");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (frameWith (1, { { go, 127 } }), settings);
        check (actions.empty(), "a level just below the threshold does not fire");

        actions = state.processFrame (frameWith (1, { { go, 128 } }), settings);
        check (containsAction (actions, ControlActionType::go), "the threshold itself fires");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (frameWith (1, { { panicAddress, 255 } }), settings);
        check (containsAction (actions, ControlActionType::panic), "the panic channel fires panic");
    }

    {
        // Pause follows the channel rather than edge-triggering, so the desk holds it.
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (frameWith (1, { { pause, 255 } }), settings);
        check (containsAction (actions, ControlActionType::pause), "raising the pause channel pauses");

        actions = state.processFrame (frameWith (1, { { pause, 255 } }), settings);
        check (! containsAction (actions, ControlActionType::pause),
               "holding pause does not repeat the action");

        actions = state.processFrame (frameWith (1, { { pause, 0 } }), settings);
        check (containsAction (actions, ControlActionType::resume), "dropping the channel resumes");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (1, { { master, 255 } }), settings);

        auto actions = state.processFrame (frameWith (1, { { master, 255 } }), settings);
        check (! containsAction (actions, ControlActionType::masterLevel),
               "an unchanged master level is not resent 40 times a second");

        actions = state.processFrame (frameWith (1, { { master, 128 } }), settings);
        const auto* level = findAction (actions, ControlActionType::masterLevel);
        check (level != nullptr, "moving the master channel reports a level");

        if (level != nullptr)
            checkNear (level->value, -60.0 + 128.0 / 255.0 * 60.0, 0.1,
                       "the level maps across a 60 dB range");

        actions = state.processFrame (frameWith (1, { { master, 0 } }), settings);
        level = findAction (actions, ControlActionType::masterLevel);
        check (level != nullptr && level->value < -99.0, "a closed master channel is silence");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (frameWith (1, { { standby, 4 } }), settings);
        const auto* action = findAction (actions, ControlActionType::standbyCue);
        check (action != nullptr, "the standby channel selects a cue");

        if (action != nullptr)
            check (action->cueIndex == 3, "a value of N stands by the Nth cue, counting from 1");

        actions = state.processFrame (frameWith (1, { { standby, 4 } }), settings);
        check (! containsAction (actions, ControlActionType::standbyCue),
               "an unchanged standby channel does not repeat");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (frameWith (1, { { firstCue + 2, 255 } }), settings);
        const auto* action = findAction (actions, ControlActionType::goCue);
        check (action != nullptr, "a direct cue channel fires a cue");

        if (action != nullptr)
            check (action->cueIndex == 2, "the channel offset selects the cue by position");
    }

    {
        // Channels beyond the configured count belong to other fixtures on the universe.
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (
            frameWith (1, { { firstCue + settings.numDirectCueChannels, 255 } }), settings);
        check (! containsAction (actions, ControlActionType::goCue),
               "a channel past the configured range is left alone");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (7, {}), settings);
        auto actions = state.processFrame (frameWith (7, { { go, 255 } }), settings);
        check (actions.empty(), "frames from another universe are ignored");
    }

    {
        // Several things can move in one frame; all of them should be reported.
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);

        auto actions = state.processFrame (
            frameWith (1, { { go, 255 }, { firstCue, 255 }, { master, 200 } }), settings);
        check (containsAction (actions, ControlActionType::go)
               && containsAction (actions, ControlActionType::goCue)
               && containsAction (actions, ControlActionType::masterLevel),
               "one frame can carry several changes at once");
    }

    {
        DmxTriggerState state;
        state.processFrame (frameWith (1, {}), settings);
        state.processFrame (frameWith (1, { { go, 255 } }), settings);
        state.reset();

        auto actions = state.processFrame (frameWith (1, { { go, 255 } }), settings);
        check (actions.empty(), "after a reset the next frame re-arms rather than firing");
    }
}

//==============================================================================
void testControlMessagePersistence()
{
    cptest::section ("control message and settings persistence");

    ControlMessage message;
    message.type = ControlMessageType::midiShowControl;
    message.delay = 1.75;
    message.oscTarget = "Companion";
    message.oscAddress = "/custom/address";
    message.oscArguments = "1 \"two words\" 3.5";
    message.midiTarget = "Interface A";
    message.midiChannel = 9;
    message.midiData1 = 42;
    message.midiData2 = 99;
    message.mscDeviceID = 17;
    message.mscCommandFormat = msc::formatVideo;
    message.mscCommand = msc::commandStop;
    message.mscCueNumber = "44.2";
    message.mscCueList = "1";
    message.mmcCommand = mmc::commandPause;

    const auto restored = ControlMessage::fromVar (message.toVar());

    check (restored.type == message.type, "message type round trips");
    checkNear (restored.delay, 1.75, 1.0e-9, "delay round trips");
    checkEqual (restored.oscTarget, "Companion", "OSC target round trips");
    checkEqual (restored.oscAddress, "/custom/address", "OSC address round trips");
    checkEqual (restored.oscArguments, "1 \"two words\" 3.5", "OSC arguments round trip");
    checkEqual (restored.midiTarget, "Interface A", "MIDI target round trips");
    check (restored.midiChannel == 9 && restored.midiData1 == 42 && restored.midiData2 == 99,
           "MIDI channel and data round trip");
    check (restored.mscDeviceID == 17, "MSC device id round trips");
    check (restored.mscCommandFormat == msc::formatVideo, "MSC format round trips");
    check (restored.mscCommand == msc::commandStop, "MSC command round trips");
    checkEqual (restored.mscCueNumber, "44.2", "MSC cue number round trips");
    check (restored.mmcCommand == mmc::commandPause, "MMC command round trips");

    // --- settings -------------------------------------------------------------
    ControlSettings settings;
    settings.oscInputEnabled = true;
    settings.oscInputPort = 9000;
    settings.oscFeedbackEnabled = false;
    settings.oscTargets.push_back ({ "Desk", "10.0.0.5", 8000, false });
    settings.enabledMidiInputs.add ("input-identifier-1");
    settings.enabledMidiOutputs.add ("output-identifier-1");
    settings.mscDeviceID = 33;
    settings.mscRespondToSoundFormat = false;
    settings.midiMachineControlEnabled = true;
    settings.dmx.artNetEnabled = true;
    settings.dmx.sacnEnabled = true;
    settings.dmx.universe = 42;
    settings.dmx.startAddress = 101;
    settings.dmx.triggerThreshold = 200;
    settings.dmx.numDirectCueChannels = 64;

    MidiBinding binding;
    binding.kind = MidiTriggerKind::programChange;
    binding.channel = 0;
    binding.number = 12;
    binding.action = ControlActionType::goCue;
    binding.cueNumber = "5";
    settings.midiBindings.push_back (binding);

    const auto restoredSettings = ControlSettings::fromVar (settings.toVar());

    check (restoredSettings.oscInputEnabled, "OSC input flag round trips");
    check (restoredSettings.oscInputPort == 9000, "OSC port round trips");
    check (! restoredSettings.oscFeedbackEnabled, "feedback flag round trips");
    check (restoredSettings.oscTargets.size() == 1, "OSC targets round trip");

    if (! restoredSettings.oscTargets.empty())
    {
        checkEqual (restoredSettings.oscTargets[0].host, "10.0.0.5", "target host round trips");
        check (restoredSettings.oscTargets[0].port == 8000, "target port round trips");
        check (! restoredSettings.oscTargets[0].enabled, "a disabled target stays disabled");
    }

    check (restoredSettings.enabledMidiInputs.contains ("input-identifier-1"),
           "enabled MIDI inputs round trip");
    check (restoredSettings.enabledMidiOutputs.contains ("output-identifier-1"),
           "enabled MIDI outputs round trip");
    check (restoredSettings.mscDeviceID == 33, "MSC device id round trips");
    check (! restoredSettings.mscRespondToSoundFormat, "MSC format flags round trip");
    check (restoredSettings.midiMachineControlEnabled, "MMC flag round trips");

    check (restoredSettings.dmx.artNetEnabled && restoredSettings.dmx.sacnEnabled,
           "DMX protocol flags round trip");
    check (restoredSettings.dmx.universe == 42, "DMX universe round trips");
    check (restoredSettings.dmx.startAddress == 101, "DMX start address round trips");
    check (restoredSettings.dmx.triggerThreshold == 200, "DMX threshold round trips");
    check (restoredSettings.dmx.numDirectCueChannels == 64, "DMX cue channel count round trips");

    check (restoredSettings.midiBindings.size() == 1, "MIDI bindings round trip");

    if (! restoredSettings.midiBindings.empty())
    {
        const auto& b = restoredSettings.midiBindings[0];
        check (b.kind == MidiTriggerKind::programChange, "binding kind round trips");
        check (b.channel == 0, "an any-channel binding stays any-channel");
        check (b.action == ControlActionType::goCue, "binding action round trips");
        checkEqual (b.cueNumber, "5", "binding cue number round trips");
    }
}

void testControlCue()
{
    cptest::section ("control cues");

    Cue cue;
    cue.type = CueType::control;

    check (! cue.isPlayable(), "a control cue with no messages has nothing to do");

    ControlMessage message;
    message.type = ControlMessageType::osc;
    message.oscAddress = "/lx/go";
    cue.outputMessages.push_back (message);

    check (cue.isPlayable(), "a control cue with a message is playable");

    // This distinction is what lets a link from a control cue be pre-scheduled: its
    // playbackLength is 0 because it takes no time, not because its end is unknowable.
    checkNear (cue.playbackLength(), 0.0, 1.0e-9, "a control cue occupies no time");
    check (! cue.isOpenEnded(), "a control cue is not open-ended");

    Cue streaming;
    streaming.type = CueType::streaming;
    check (streaming.isOpenEnded(), "a streaming cue is open-ended");

    Cue looping;
    looping.fileDuration = 10.0;
    looping.loopEnabled = true;
    looping.loopCount = 0;
    check (looping.isOpenEnded(), "an infinite loop is open-ended");

    looping.loopCount = 3;
    check (! looping.isOpenEnded(), "a finite loop has a knowable end");

    Cue vamping;
    vamping.fileDuration = 10.0;
    vamping.vampEnabled = true;
    vamping.vampStart = 2.0;
    vamping.vampEnd = 5.0;
    check (vamping.isOpenEnded(), "an armed vamp is open-ended");

    // Round trip through the show format.
    const auto restored = Cue::fromVar (cue.toVar (juce::File()), juce::File());
    check (restored.type == CueType::control, "a control cue's type round trips");
    check (restored.outputMessages.size() == 1, "its messages round trip");

    if (! restored.outputMessages.empty())
        checkEqual (restored.outputMessages[0].oscAddress, "/lx/go",
                    "the message address round trips");
}


//==============================================================================
void testTimecodeParsing()
{
    cptest::section ("timecode fields");

    // Plain seconds, for someone who knows the number.
    checkNear (parseTimecode ("12.5"), 12.5, 1.0e-9, "plain seconds parse");
    checkNear (parseTimecode ("0"), 0.0, 1.0e-9, "zero parses");

    // Colon-separated fields count from the right, so nothing has to be padded out.
    checkNear (parseTimecode ("1:02.5"), 62.5, 1.0e-9, "m:ss parses");
    checkNear (parseTimecode ("1:00:05"), 3605.0, 1.0e-9, "h:mm:ss parses");
    checkNear (parseTimecode ("02:30"), 150.0, 1.0e-9, "leading zeroes are fine");
    checkNear (parseTimecode ("  3:00  "), 180.0, 1.0e-9, "surrounding space is ignored");

    // Anything unusable must leave the marker where it was rather than jumping it to zero.
    checkNear (parseTimecode ("", 7.0), 7.0, 1.0e-9, "empty text keeps the old value");
    checkNear (parseTimecode ("abc", 7.0), 7.0, 1.0e-9, "nonsense keeps the old value");
    checkNear (parseTimecode ("1:2:3:4", 7.0), 7.0, 1.0e-9, "too many fields keeps the old value");
    checkNear (parseTimecode (":", 7.0), 7.0, 1.0e-9, "a lone separator keeps the old value");
    checkNear (parseTimecode ("-5", 7.0), 0.0, 1.0e-9, "a negative time clamps to zero");

    checkEqual (formatTimecode (62.5), "01:02.500", "formats to millisecond precision");
    checkEqual (formatTimecode (3605.25), "1:00:05.250", "formats past an hour");
    checkEqual (formatTimecode (0.0), "00:00.000", "formats zero");

    // Round trip: what the field shows must read back as the same time.
    for (const auto seconds : { 0.0, 0.001, 1.5, 62.5, 599.999, 3605.25 })
        checkNear (parseTimecode (formatTimecode (seconds)), seconds, 0.001,
                   "formatTimecode round trips through parseTimecode");
}

void testShowDefaults()
{
    cptest::section ("project default fade times");

    Show show;

    checkNear (show.getDefaultFadeInTime(), 0.0, 1.0e-9, "a new show defaults to no fade");

    show.setDefaultFadeInTime (2.5);
    show.setDefaultFadeOutTime (4.0);
    show.setDefaultFadeShape (FadeShape::sCurve);

    Cue cue;
    show.applyDefaultsTo (cue);

    checkNear (cue.fadeInTime, 2.5, 1.0e-9, "a new cue picks up the default fade in");
    checkNear (cue.fadeOutTime, 4.0, 1.0e-9, "a new cue picks up the default fade out");
    check (cue.fadeInShape == FadeShape::sCurve, "a new cue picks up the default curve");

    // The whole point of a default: it seeds a cue, it does not own it afterwards.
    cue.fadeInTime = 9.0;
    show.setDefaultFadeInTime (1.0);
    checkNear (cue.fadeInTime, 9.0, 1.0e-9,
               "changing the default does not reach back into an existing cue");

    show.setDefaultFadeInTime (-5.0);
    checkNear (show.getDefaultFadeInTime(), 0.0, 1.0e-9, "a negative default clamps to zero");

    show.setDefaultFadeOutTime (10000.0);
    check (show.getDefaultFadeOutTime() <= 120.0, "an absurd default is clamped");

    // Round trip through the show file.
    auto directory = juce::File::getSpecialLocation (juce::File::tempDirectory)
                         .getChildFile ("simplecue-defaults-test");
    directory.createDirectory();
    const auto file = directory.getChildFile ("defaults.cueshow");

    show.setDefaultFadeInTime (3.25);
    show.setDefaultFadeOutTime (6.5);
    show.setDefaultFadeShape (FadeShape::logarithmic);

    check (show.save (file).isEmpty(), "a show with defaults saves");

    Show reloaded;
    check (reloaded.load (file).isEmpty(), "it loads back");
    checkNear (reloaded.getDefaultFadeInTime(), 3.25, 1.0e-9, "default fade in round trips");
    checkNear (reloaded.getDefaultFadeOutTime(), 6.5, 1.0e-9, "default fade out round trips");
    check (reloaded.getDefaultFadeShape() == FadeShape::logarithmic, "default curve round trips");

    directory.deleteRecursively();
}

void testStreamingSettings()
{
    cptest::section ("streaming settings");

    StreamingSettings settings;
    settings.provider = "tidal";
    settings.clientId = "abc123";
    settings.audioPath = StreamingAudioPath::remoteDevice;
    settings.captureFirstInputChannel = 4;
    settings.captureNumChannels = 2;
    settings.targetDeviceId = "device-xyz";

    const auto restored = StreamingSettings::fromVar (settings.toVar());

    checkEqual (restored.provider, "tidal", "provider round trips");
    checkEqual (restored.clientId, "abc123", "client id round trips");
    check (restored.audioPath == StreamingAudioPath::remoteDevice, "audio path round trips");
    check (restored.captureFirstInputChannel == 4, "capture input round trips");
    check (restored.captureNumChannels == 2, "capture channel count round trips");
    checkEqual (restored.targetDeviceId, "device-xyz", "target device round trips");

    checkEqual (restored.getProviderDisplayName(), "TIDAL", "provider display name resolves");

    // Nothing stored yet must not leave the app pointing at an empty provider.
    const auto fresh = StreamingSettings::fromVar (juce::var());
    checkEqual (fresh.provider, "spotify", "an absent setting falls back to a real provider");
    check (fresh.audioPath == StreamingAudioPath::localCapture,
           "the default path is the one where fades and routing actually work");

    check (StreamingSettings::providerKeys().size() == StreamingSettings::providerNames().size(),
           "every provider key has a display name");

    // A cue carries only its own reference now; the account lives in settings.
    Cue cue;
    cue.type = CueType::streaming;
    check (! cue.isPlayable(), "a streaming cue with no uri has nothing to play");
    cue.streaming.uri = "spotify:playlist:123";
    check (cue.isPlayable(), "a uri is all a streaming cue needs of its own");
}


//==============================================================================
void testCueSteps()
{
    cptest::section ("cue sub-cues");

    // Every audio cue reads the same way: play it, and be able to stop it.
    {
        Cue cue;
        cue.fileDuration = 10.0;
        const auto steps = buildCueSteps (cue);

        check (steps.size() == 2, "a plain cue has Play and Fade/Stop");
        check (steps[0].type == CueStepType::play, "the first sub-cue is Play");
        check (steps[1].type == CueStepType::end, "the last sub-cue is Fade/Stop");
    }

    // Even a cue that would end by itself keeps its Fade/Stop: it can be wanted out early.
    {
        Cue cue;
        cue.fileDuration = 10.0;
        cue.loopEnabled = true;
        cue.loopCount = 0;
        const auto steps = buildCueSteps (cue);

        check (steps.size() == 2, "an endless cue also has exactly Play and Fade/Stop");
        check (steps.back().type == CueStepType::end, "and it ends with Fade/Stop");
    }

    // Devamp only appears where there is something to release.
    {
        Cue cue;
        cue.fileDuration = 60.0;
        cue.vampEnabled = true;
        cue.vampStart = 10.0;
        cue.vampEnd = 20.0;

        const auto steps = buildCueSteps (cue);

        check (steps.size() == 3, "a vamped cue has play, devamp and fade/stop");
        check (steps[1].type == CueStepType::devamp, "the devamp sits between them");
        check (steps[1].detail.isNotEmpty(), "and says which region it releases");
    }

    {
        Cue cue;
        cue.fileDuration = 60.0;

        for (const auto& step : buildCueSteps (cue))
            check (step.type != CueStepType::devamp,
                   "a cue with no vamp shows no devamp sub-cue");
    }

    // A vamp whose markers are unusable is not a vamp.
    {
        Cue cue;
        cue.fileDuration = 60.0;
        cue.vampEnabled = true;
        cue.vampStart = 30.0;
        cue.vampEnd = 20.0;      // backwards

        for (const auto& step : buildCueSteps (cue))
            check (step.type != CueStepType::devamp, "an unusable vamp gets no devamp sub-cue");
    }

    // A control cue is a single event.
    {
        Cue cue;
        cue.type = CueType::control;
        const auto steps = buildCueSteps (cue);

        check (steps.size() == 1, "a control cue has one sub-cue");
        check (steps[0].type == CueStepType::play, "and it is the fire step");
    }

    // The Fade/Stop description has to match what it will actually do.
    {
        Cue cue;
        cue.fileDuration = 10.0;
        cue.endAction = EndAction::hardStop;
        check (buildCueSteps (cue).back().detail.containsIgnoreCase ("hard"),
               "a hard stop says so");

        cue.endAction = EndAction::fadeOut;
        cue.endFadeTime = 4.0;
        check (buildCueSteps (cue).back().detail.contains ("4.0"),
               "a fading end shows its fade time");
    }
}

void testStandbyWalksTheLifecycle()
{
    cptest::section ("standby walks cue and sub-cues");

    CueList list;

    Cue simple;
    simple.number = "1";
    simple.fileDuration = 10.0;

    Cue vamped;
    vamped.number = "2";
    vamped.fileDuration = 60.0;
    vamped.vampEnabled = true;
    vamped.vampStart = 10.0;
    vamped.vampEnd = 20.0;

    Cue last;
    last.number = "3";
    last.fileDuration = 10.0;

    const auto vampedId = vamped.id;

    list.insert (simple);
    list.insert (vamped);
    list.insert (last);
    list.setStandbyIndex (0);

    check (list.getStandbyIndex() == 0 && list.getStandbyStep() == cueHeaderStep,
           "standby starts on the cue itself, not on a sub-cue");
    check (list.stepsFor (0).size() == 2, "a plain cue has two sub-cues");

    // Firing the cue plays it, so standby skips the Play sub-cue and offers Fade/Stop.
    list.advanceStandby();
    check (list.getStandbyIndex() == 0 && list.getStandbyStep() == 1,
           "standby skips Play, which firing the cue already did");

    const auto stepInfo = list.getStandbyStepInfo();
    check (stepInfo.has_value() && stepInfo->type == CueStepType::end,
           "and lands on Fade/Stop");

    list.advanceStandby();
    check (list.getStandbyIndex() == 1 && list.getStandbyStep() == cueHeaderStep,
           "then moves to the next cue");

    // With the checkbox off, the cue is a container: standby offers Play as a sub-cue.
    list.modifyByID (vampedId, [] (Cue& c) { c.firePlayWithCue = false; });
    list.setStandbyIndex (1);
    list.advanceStandby();
    check (list.getStandbyStep() == 0, "a cue that does not fire Play offers it as a sub-cue");

    list.modifyByID (vampedId, [] (Cue& c) { c.firePlayWithCue = true; });

    // The vamped cue: header, then devamp, then fade/stop.
    list.setStandbyIndex (1);
    check (list.stepsFor (1).size() == 3, "the vamped cue has three sub-cues");

    list.advanceStandby();
    check (list.getStandbyStep() == 1, "standby skips Play and lands on the devamp");

    const auto devamp = list.getStandbyStepInfo();
    check (devamp.has_value() && devamp->type == CueStepType::devamp, "and it is the devamp");

    list.advanceStandby();
    check (list.getStandbyStep() == 2, "then Fade/Stop");

    list.advanceStandby();
    check (list.getStandbyIndex() == 2 && list.getStandbyStep() == cueHeaderStep,
           "only then does it move on to the next cue");

    // The end of the list is a wall, not a wrap.
    for (int i = 0; i < 5; ++i)
        list.advanceStandby();

    check (list.getStandbyIndex() == 2, "standby stops at the last cue");

    // Editing a cue can remove the sub-cue standby is sitting on.
    list.setStandbyPosition (1, 2);
    check (list.getStandbyStep() == 2, "standby can be placed on the last sub-cue");

    list.modifyByID (vampedId, [] (Cue& c) { c.vampEnabled = false; });
    check (list.getStandbyStep() < (int) list.stepsFor (1).size(),
           "removing the vamp pulls standby back into range");

    // Clicking a sub-cue stands it by directly.
    list.setStandbyPosition (1, 1);
    check (list.getStandbyIndex() == 1 && list.getStandbyStep() == 1,
           "standby can jump straight to a sub-cue");

    // Selecting a cue always returns standby to the cue itself.
    list.setStandbyIndex (1);
    check (list.getStandbyStep() == cueHeaderStep, "selecting a cue stands by the cue itself");
}

} // namespace

//==============================================================================
void runControlTests();

void runControlTests()
{
    testOscAddresses();
    testOscArguments();
    testShowControl();
    testMachineControl();
    testMidiBindings();
    testArtNetParsing();
    testSacnParsing();
    testDmxTriggering();
    testControlMessagePersistence();
    testControlCue();
    testTimecodeParsing();
    testShowDefaults();
    testStreamingSettings();
    testCueSteps();
    testStandbyWalksTheLifecycle();
}
