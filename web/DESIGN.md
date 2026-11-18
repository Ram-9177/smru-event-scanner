# Darkroom — the UI/UX of Event Photos (17 November 2026)

Source: the owner's design file `darkroom.html` (a two-screen student front door). This plan carries its language
to every screen of the app: the student app, the organiser console and People.

## The idea

A darkroom. **Finding** happens in the red-lit room: the event is a big frame of film, your selfie is a blank print
hanging on the drying line, the red shutter is the one thing to press. **Your photos** come out with the lights on:
prints hang from pegs, the whole event is a contact sheet with your frames circled in red grease pencil.
Organisers work in the same room with the lights on: paper cards on a dark bench.

## Tokens

| Token | Value | Use |
|---|---|---|
| room | `#170A09` | the red-lit room (student Find, sign-in) |
| bench | `#181513` | lights on (Prints, console, People) |
| panel | `#2A211D` | segmented controls, quiet panels on the bench |
| film | `#090504` / edge `#3A201C` / holes `#4A2A25` | film strips |
| paper | `#F4EEE3` | prints, cards, slips, tickets, dialogs |
| paper-2 | `#E6D9C8` / `#DDD0BE` | the well of a print, empty frames |
| ink | `#1B1210` | text on paper; muted on paper `#6B5B52` |
| light | `#F4EEE3` | text on room/bench; muted `#C9B8AE` |
| safelight red | `#FF4A36` (hover `#FF5F4C`, on dark text `#FF6B57`) | the primary action, the lamp, ticks |
| pencil red | `#E8301C` / bad text `#B3200E`, `#8E1A0C` | circles around you, errors on paper |
| amber | `#FFB224` | edge print, handwritten notes, focus ring |
| peg | `#C99B6B` / `#A87A4C` | pegs on the line |

Type: **Barlow Condensed** 700/800 uppercase for titles, labels, buttons and edge print (letter-spacing .08–.16em);
**Barlow** 400–600 for text; **Caveat** 700 for handwritten notes ("circled in red = you", "developing…").
Grain over room and bench (behind content). Buttons: 56 px tall, radius 16, condensed caps (primary red with dark
text, ghost outlined light, ink outlined on paper, done = paper). Slips: small paper notes, a hair rotated.
Focus: 2 px amber outline. Motion: prints sway on the line, frames develop in; all off with reduced motion.

Owner rule kept: **a photo is never tinted.** Prints, sheets, the viewer, the home's event frame and every
thumbnail (Earlier events included) show true colours. (The old Find strip of negatives is gone.)

## Student app

| Address | Screen |
|---|---|
| `/` | **Find**, the home across all campuses: the latest event |
| `/c/:campus` | **Find**, one campus's own home (its own link and QR): that campus's latest event. The old `/?campus=x` leads here; a campus that does not exist says "This campus link isn't right." with See all events |
| `/e/:slug`, `/e/:slug/find` | **Find** with that event as the big one (`?campus=x` when opened from a campus home, kept on every address of the event so the way back stays on that campus) |
| `/e/:slug/mine` | **Prints**, My prints |
| `/e/:slug/album` | **Prints**, All photos (contact sheet) |
| `/e/:slug/add` | Prints with the *Hang your shots* dialog open |
| `/e/:slug/me` | Prints with the *Delete my results?* dialog open |

**Find.** No campus chips: each campus has its own link. Top: wordmark + college, "Earlier events" in the corner
(phone: a clock and "Earlier"; only when the home has other events), the safelight lamp (desktop: "No login · Nothing
to install"). Intro: "Find every photo you're in." 01 Your event: one big film frame of the home's event, its cover
in true colour (edge date, a red count of your photos, "N new", "Soon" for an event not yet open). The home's event
is the newest open one; if none is open, the newest closed one with photos; then the newest opening soon; then any closed one. Under it the
caption (title, date · campus · venue · N photos, "My N prints →"); on an older event, "See the latest event".
*Earlier events* is a paper dialog: every other event of this home (this campus, or all), newest first, each with
a small true-colour cover, title, date, Soon / Closed / Latest and "N of you"; a tap opens it as the big one.
02 Show your face:
the blank print on the drying line (silhouette, "your face here"; the live camera or the selfie in it;
"developing…" while it searches). Phone: the dock stays at the bottom: Add photos · red shutter · See all, with the
consent line always visible under it (a tap on the print first brings the consent line into view). Laptop: two
columns; Take a selfie (webcam) with the consent line, "or", and the ticket with the QR of the one permanent link (on
a campus home, that campus's link: "Hyderabad campus: same QR after every event"). At the very bottom, after
everything (the phone's dock never covers it): "For organisers" as an outlined button. Messages are paper slips. A
selfie with no face or a camera problem says so in a slip; face search off goes to All.

**Prints.** Top: back, the event as edge print, the selfie avatar to retake. Hero: "N prints of you" + a handwritten
note. Tabs: My prints · N | All photos · N (lock when a passcode is needed). On My prints: Solo / Duo / Group chips
(our People rules), the line of hanging prints (wide photos hang wider), a tick on each to select, a play mark and
length on videos, "developing…" prints while photos are still being processed, the *Hang your shots* slot to add
photos, "might be you (N)" with Show/Hide. On All: the passcode gate if needed, the contact sheet (frame numbers,
your frames circled in red, a check on selected ones, Load the next N). Foot: the ticket (QR + Share the link),
fine print (selfie not kept, downloads off, help contact), "Delete my results for this event". Bottom bar (phone) /
sticky tools (laptop): Download all N / Download N selected / Clear, "Saved" afterwards.

**Viewer.** Dark over everything: the photo on a paper print, prev/next on a laptop, swipe and pinch-zoom on a
phone, videos play (starting just before you appear, "You at 0:42"), the handwritten tag ("you", "might be you",
"added by …"), Download photo (full quality) · Select, then Not me · Report this photo · Share.

**Dialogs** (paper cards): Earlier events (on Find), Hang your shots (name, choose photos and videos, progress meter, added / already on the
roll / could not be read, waiting for the organiser's check), Delete my results?, plus a toast for small news.

## Organiser console (`/admin`)

Lights on: bench background, paper cards. Sign-in, forgot and reset: the red-lit room with the lamp, a paper card
for the form, "Sign in with Microsoft" as a ghost button. Shell: a dark top bar with the wordmark and the sections
as condensed caps (Events, Requests, People, Share kit, Settings), the active one underlined in red. Events: each
event a film frame card (four frames of its photos on a strip, edge print with date and state, counts). An event:
edge-print title, state as a stamp, tabs in a segmented control (Sync, Add, Waiting, Photos, Settings), the next
step as a slip. Media: the contact sheet (frame numbers, red circles for selected, red for hidden/rejected
states). Forms: labels in condensed caps, fields on paper, primary actions red. Tables on paper. Toggles and checks
in red. Errors are slips with dark-red text.

## People (`/admin/people`)

The same bench: each person a print hanging from a peg (their reference face), name in condensed caps, role
handwritten, Solo/Duo/Group counts as edge print; adding reference faces is a drop zone like the *Hang your shots*
slot.

## Accessibility and sizes

Every tap target is at least 44 px, text on room/bench is light (#F4EEE3, 15.9:1) or muted (#C9B8AE, 9:1); on
paper ink (#1B1210) or muted (#6B5B52, 6:1); red buttons carry dark text. Layout works from 320 px; phone first;
desktop from 1000 px. Reduced motion stops sway, develop and grain.
