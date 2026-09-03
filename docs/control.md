# Control reference

Everything the outside world can do to SimpleCue, and everything it sends back. Configure
it all in **Audio → Control setup**, which also carries a live monitor of incoming traffic —
when a desk is not firing a cue, the first question is always "is anything arriving at
all?", and that panel is the answer.

Control settings live in the application's own preferences, not in the show file. Ports,
MIDI device names and DMX universes belong to the rig; a show that opens in the rehearsal
room should not drag the venue's network layout along with it.

Nothing listens until you turn it on. An audio player that silently opens a network port on
first run is not a good guest on a show network.

---

## OSC

Set the input port (default 53000) and add one or more targets for outgoing messages and
status. Addresses are matched **case-insensitively** and a trailing slash is ignored.
That applies to the verbs and the fixed segments (`/CUE/12/GO` works); the cue number
itself is passed through as typed, so an alphabetic number such as `PRE` or `A1`
reaches the cue list intact. Matching a cue number also ignores case, so `/cue/pre/go`
finds a cue numbered `PRE`.

### Incoming

| Address | Arguments | Action |
|---|---|---|
| `/go` | — | Perform the standby step and advance |
| `/cue/<number>/go` | — | Fire a specific cue |
| `/cue/<number>/stop` | `[fade]` | Stop one cue, optionally over *fade* seconds |
| `/cue/<number>/standby` | — | Make it the standby cue |
| `/cue/<number>/select` | — | Select it for editing |
| `/cue/<number>/audition` | — | Audition it |
| `/cue/<number>/releasevamp` | — | Release that cue's vamp |
| `/stop` | `[fade]` | Stop everything (default 2 s) |
| `/panic` | — | Immediate silence, cancels queued control messages |
| `/pause` `/resume` `/pause/toggle` | — | Freeze or resume playback |
| `/releasevamp` | — | Release every vamp |
| `/standby/next` `/standby/previous` | — | Step the standby marker |
| `/standby/<number>` | — | Stand by a specific cue |
| `/master/level` | `<dB>` | Set the master level |
| `/status/query` | — | Send the whole state to the targets |

`<number>` is the cue number as printed on the cue sheet, not a list position. Renumbering
a show therefore renumbers what the outside world triggers, which is what anyone would
expect. Numeric cue numbers also match loosely, so a desk sending `12.50` finds `12.5`.

`/go` performs whatever the standby marker is sitting on — the cue itself, or one of its
sub-cues. `/cue/<number>/go` fires that cue as a whole and honours its "firing this cue also
fires its Play sub-cue" setting, so a cue configured as a container stays a container
whether it is triggered from the keyboard or from a lighting desk.

An address that names a cue which does not exist produces `/status/error` rather than
silence — a cue that quietly does not happen is the worst kind of failure.

### Outgoing status

Sent to every enabled target when the state changes, and in full on `/status/query`.

| Address | Arguments |
|---|---|
| `/status/standby` | cue number, cue name |
| `/status/playing` | number of cues sounding |
| `/status/playingCues` | space-separated cue numbers |
| `/status/paused` | `0` or `1` |
| `/status/vamping` | `0` or `1` |
| `/status/master` | dB |
| `/status/error` | message |

### Companion

Point a Generic OSC connection at the player's input port for control, and add a target
back to Companion's OSC listener (12321 by default) for feedback. The status addresses
above are what a button's feedback should watch.

---

## MIDI

Choose which inputs and outputs to open. Devices are remembered by their system identifier,
so re-plugging an interface keeps working; an enabled device that is not present is
reported rather than silently ignored.

### Note, CC and program bindings

Each binding matches a kind, a channel (or *any*), and a number, then fires an action.

- A **note-on with velocity 0** is treated as a note-off and does not fire. Without that,
  controllers that release notes this way would trigger every cue twice.
- A CC binding set to **use the value as a level** feeds the controller value into the
  action instead of triggering it, mapping 0–127 onto −∞ to 0 dB. That is how a fader
  drives the master level.

### MIDI Show Control

Set the device ID the player answers to. ID **127 in an incoming message** is the spec's
all-call and is always honoured; setting **127 in the player's own settings** makes it
listen to every device. Choose which command formats to answer — *Sound* is the obvious
one, and *All-types* is required by the spec to be honoured by everything.

| MSC command | Action |
|---|---|
| `GO` with a cue number | Fire that cue |
| `GO` with no cue number | Perform the standby step |
| `STOP` with a cue number | Stop that cue |
| `STOP` with no cue number | Pause |
| `RESUME` | Resume |
| `LOAD` | Stand by that cue |
| `GO_OFF` | Stop that cue, or everything |
| `ALL_OFF` | Stop everything immediately |

### MIDI Machine Control

Off by default. `PLAY` and `DEFERRED PLAY` fire a GO, `STOP` stops everything, `PAUSE`
toggles.

### Outgoing

Any cue can carry MIDI messages — note on/off, CC, program change, MSC and MMC — alongside
its audio. See **Control cues** below.

---

## DMX: Art-Net and sACN

Both can run at once. Set the universe, a start address, and the level a channel counts as
"on" at (default 128).

| Offset | Channel |
|---|---|
| +0 | **GO** — perform the standby step |
| +1 | **Stop all** |
| +2 | **Panic** |
| +3 | **Pause** — held above the trigger level means paused |
| +4 | **Release vamp** |
| +5 | **Master level** — 0 is silence, 255 is 0 dB |
| +6 | **Standby select** — a value of *N* stands by the *N*th cue in the list |
| +7… | Fire the 1st, 2nd, 3rd… cue in the list directly |

DMX is the one transport that addresses cues by **position** rather than by number, because
a DMX channel can only count.

Three behaviours worth knowing:

- **Triggers are edge-detected.** A desk sends the same universe forty times a second, so
  level-triggering would fire a cue forty times a second. An action fires on the frame
  where a channel first rises to the threshold.
- **The first frame after connecting only arms the detector.** Plugging into a desk that is
  already holding GO high must not fire a cue the moment the cable goes in.
- **sACN preview and stream-terminated packets are ignored.** A designer working blind
  cannot fire a sound cue by accident.

Art-Net listens on UDP 6454; sACN listens on UDP 5568 and joins the multicast group for the
configured universe (`239.255.<hi>.<lo>`), while still accepting unicast senders.

---

## Control cues

Every cue can carry outgoing messages, so a sound cue can fly a lighting cue without a
separate cue sitting beside it in the list. A cue of type **control** is simply one that has
messages and no audio.

Messages are scheduled against the cue's **pre-wait**, so a message with no delay of its own
lands with the first sample of audio rather than at the moment GO was pressed. Each message
can carry its own extra delay on top.

Because a control cue takes no time, links from it are pre-scheduled the same way as links
from a cue of known length: an auto-follow fires the moment the messages go out.

**Panic cancels queued control messages** as well as silencing audio. A message arriving
after someone has hit panic is exactly what they were trying to stop.

---

## Timing

Incoming control arrives on a socket or MIDI thread and is handed to the message thread
before it touches the show, because acting on a cue list from a driver callback would be a
data race with the UI. That marshalling costs a few milliseconds of jitter — unavoidable for
anything arriving over a network or a MIDI cable, and far below the variation in a human GO.

The sample-accurate part is what happens *after* a cue fires: links, crossfades and
auto-follows are scheduled in samples, not by a timer. See the main README.
