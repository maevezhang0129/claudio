# Design

## `stage.jpg`

The wide-screen stage as built (1440×900), used at the top of the main README.
The queue is sample content injected in the browser, so the owner's real listening
history never reaches a public image. The photo is one of the Unsplash scenes in
`public/scenes/`.

The stage takes its look from playlist-video covers (a café photo, a big title,
the queue in small caps), not from the mockup below. It is a second visual world
for a different situation: a screen left running beside the desk, where the phone
layout's instrument panel would be a 640px column floating in empty space. The
mockup's rules still hold where they apply: green appears only on the status light,
and alternates are marked rather than passed off as the requested artist.

## `mockup.html`

The visual direction for Claudio's interface, before it was built. Open it in a
browser — the clock is live and reads the current hour.

The central decision it records: **the interface's metaphor is broadcast, not chat.**

- The largest element on screen — the dot-matrix clock — carries no interaction
  at all. The line under it is the routine name parsed from `user/routines.md`,
  so at 07:30 it reads "commute" rather than a generic "morning". That binding to
  the owner's own corpus is what makes it theirs and not copyable.
- Tracks are a numbered **queue** under one persistent player, not a stack of
  cards each with its own play button. A list is not a radio station.
- Green means exactly one thing: live. Amber means exactly one thing: this is an
  alternate version, not the artist you asked for.
- The dot grid is a pixel substrate at a fixed 4px pitch, not a texture — type
  and spacing snap to the same grid.
- Doto (dot-matrix) covers identity and readouts; IBM Plex Mono covers the small
  uppercase instrument labels; the system sans covers all Chinese prose. Doto has
  no CJK coverage, and that constraint defined the split.

All track and profile data in the mockup is sample content.

Reference material that informed this direction lives in `diagram/reference/`
and is gitignored — it is a third party's original work.
