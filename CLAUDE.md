# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Language conventions

**Anything public-facing is English-first.** This repo is part of a job-search
portfolio aimed at English-language roles, so recruiters read the commit history
and the README's first screen.

| Artifact | Language |
|---|---|
| Commit messages | **English only** |
| README | **English first**, Chinese section after |
| PR titles and descriptions | English |
| Code comments | Chinese (existing convention — do not translate) |
| Conversation with the user | Chinese |

This constrains *artifacts*, not conversation. Do not translate existing Chinese
code comments; they stay as they are.

## Commands

```bash
npm run dev:stub    # offline — no API calls, no cost; drives the UI from fixed scripts
npm run dev         # live — needs a model API key
npm run verify      # 34 pipeline assertions + 33 matching edge cases; costs nothing
npm run typecheck
npm run certs       # sign a local TLS cert (needs mkcert); re-run when the LAN IP changes
npm run netease:api # start the self-hosted NeteaseCloudMusicApi on :3000
npm run netease:login # scan a QR to obtain the NetEase cookie; writes it into .env
npm run prefs       # derive prefs from the library export; --show to print what is stored
```

Node 25 runs TypeScript natively — there is no build step.

## Architecture invariants

Four layers. Two of them are pluggable adapters; keep them that way.

- **`MusicProvider`** (`src/music/types.ts`) — `itunes`, `netease` and `mixed`
  implemented; `applemusic` is a declared case that throws with an explanation.
  `mixed` composes the other two and must stay that way: iTunes answers first and
  NetEase is only a second opinion, so `mixed` can never score worse than iTunes.
  Reversing that order made it worse — see the README.
- **`BrainAdapter`** (`src/brain/types.ts`) — `claude` and `stub`; adding GLM /
  DeepSeek / Kimi means one new implementation plus a case in
  `src/brain/index.ts`. Nothing above the factory changes.

### The output contract is fixed

The model always returns `{say, play[], reason, segue}` (`DJResponseSchema`).
Stage ① only renders three of those fields; `segue` is a placeholder that feeds
the TTS pipeline in stage ③. **Do not change the shape** to fit a stage-① need.

### Keep `assemble()` free of I/O it doesn't need

`npm run verify` calls `assemble()` repeatedly, so weather, calendar and prefs
are all resolved in `server.ts` and passed *in* rather than fetched inside.
Assertions then read fixed values instead of whatever the sky is doing.

Note this is about determinism, not about the network in general — `verify` does
call the iTunes API to resolve tracks, and that is intended. It costs nothing and
it is the only way to test the hallucination filter against a real catalogue.

### Context assembly: stable vs volatile

`src/context/assemble.ts` splits the prompt into a **stable** group (system
prompt + user corpus, marked with a cache breakpoint) and a **volatile** group
(time, recent plays, execution trace).

Never put anything that changes per-turn into the stable group — one timestamp
invalidates the whole cached prefix. `npm run verify` has assertions guarding
this for the timestamp, the weather, and the calendar.

Fragment ③ distinguishes three states, and the distinction is load-bearing:
`暂未接入` (not wired up), `取不到` (wired up, fetch failed), and a real value.
Collapse them and the model invents a forecast.

### `resolve()` returns three states, not a boolean

`src/music/itunes.ts` maps a model-supplied `{title, artist}` to a real track:

| Result | Meaning | Handling |
|---|---|---|
| `exact` | title and artist both match | play normally |
| `alternate` | title matches, artist differs | play, but tell the user why |
| `null` | title does not match | hallucination — discard silently |

`alternate` exists for a real reason: stage names differ across platforms
(NetEase's 买辣椒也用券 is Apple Music's 冯沁苑LaJiao — same person). Treating
that as a hallucination is wrong; pretending it matched is also wrong.
Alternates are demoted to the end of the queue and capped at `MAX_ALTERNATES`.

### Matching has a second gate: `TITLE_LENGTH_FLOOR`

Similarity alone does not stop a fabricated title that *contains* a real one —
「永夜的第七章序曲」 wraps 「夜的第七章」 and scores 0.81, over the 0.72 threshold.
Every candidate must also clear a normalised length ratio of 0.8.

It applies to **both** passes. It was originally on the `alternate` path only,
reasoning that containment is safe when the artist agrees; that was wrong. What a
model fabricates is a real artist with a padded title, so the artist always agrees
and it passed on the first try. Do not narrow it back.

### `normalize()` must not eat the title

Stripping decorations too eagerly is worse than not stripping. `/\s*(feat|ft)\s+/`
turned "Soft Spot" into "so", because the `ft` inside the word matched with zero
leading whitespace — and "so" is identical to what a fabricated "Soft Spot in the
Rain" collapses to. Latin markers require whitespace **before**; 与/和 require
whitespace **after**, or 「我和我的祖国」 truncates to 「我」. Eight `verify` cases
pin this.

### Similarity thresholds are load-bearing

`src/music/normalize.ts` decides what counts as the same song. The containment
bonus **must** scale with length ratio — without it, a fabricated title
("Whispers Beneath the Tide") matches a real one ("Tide") and hallucinations
leak through. This was a real regression; `npm run verify` pins it with eight
edge cases. Re-run verify after touching any threshold.

### Corpus is distilled, never dumped

`scripts/export-apple-music.mjs` pulls the local library over AppleScript;
`scripts/ingest.mjs` distills it into `user/library.md` (~1,200 tokens). Never
feed a raw export into the prompt — a few hundred tracks is already hundreds of
thousands of tokens.

Rank artists by **play count**, not save count. The two produce different
orderings and play count is the one that reflects actual listening.

`userCorpus()` in `src/context/assemble.ts` strips HTML comments before the
corpus reaches the model. The templates use `<!-- -->` for fill-in guidance
aimed at the human; leaking it makes the model read "✗ 没用：喜欢周杰伦" as a
stated preference. Two `npm run verify` assertions guard this.

### Anything that costs money needs an explicit trigger

`GET /api/plan/today` reads the stored plan and is free. `POST` runs the
scheduler, one model call per slot, and only ever happens because someone asked.
Never make a paid path fire as a side effect of opening a page or polling.

### Source files must stay text

`src/music/itunes.ts` and `scripts/ingest.mjs` used a literal NUL byte as a cache
key separator, which made git treat both as binary — diffs showed nothing. They
now use the `\u0000` escape: identical at runtime, readable to git and grep.
Don't put raw control characters in source.

### `plays.outcome` separates recommending from listening

A row is written as `queued` when a track enters the queue. A report from
`POST /api/played` **inserts a separate** `played`/`skipped` row — it must never
go back to updating the `queued` one, because the scheduler's lineup and
history-recalled queues have no such row and the update silently matched nothing
while still answering `ok`. Fragment ④ excludes `queued` rows: feeding back "you
played this" about a track nobody opened is how the model ends up reinforcing a
direction the owner never chose.

"Played" means six tenths of **the media in the player**, whose duration the
client reports from `audio.duration`. Never reintroduce an absolute seconds
threshold: one existed for previews and silently relabelled abandoned full
tracks as listened the moment full playback was switched on. Rows store that
duration so a future change to the rule can be applied to old data.

The skip line is the only negative signal in the whole system — everything else
(corpus, library export, derived prefs) describes things the owner likes. Do not
collapse it back into a plain play record.

### Automatic paths must not spend money

`CLAUDIO_AUTOPLAN` is off by default, and the ticker only receives its `autoPlan`
hook when the flag is on — with the flag off the scheduler code is never reached
from a timer at all. The env var is the explicit human trigger. Keep any future
automatic path behind the same kind of switch.

### Countable constraints go at the end of the volatile group

The persona states how to pick tracks, but a *countable* rule ("at least two
unfamiliar artists") is ignored when buried in it. `requirements()` in
`assemble.ts` restates such rules as the final section of the prompt, and one
`verify` assertion pins that it stays last — that position is the entire reason
it works.

Anything the model must count, verify in code as well. It cannot check a name
against a chart from thousands of tokens earlier; `countFresh()` does it and the
result is fed back next turn. Count on the **final queue**, never on the resolved
candidates, or the number contradicts the visible list and the feedback lies.

### Nothing enters the queue that cannot be played

A resolved track with neither `previewUrl` nor `fullPlayback` is dropped, counted
as `unplayable` rather than as a hallucination. Both the chat path and the
scheduler apply this. Sending the listener out to another app's website is worse
than one fewer song.

### `prefs` and the corpus do not overlap

`user/taste.md` holds what only the owner knows. `user/library.md` holds the
distilled statistics. `prefs` holds what neither can express — ratios, and the
specific dormant tracks `library.md` only counts. When adding a `prefs` key, check
it is not already answerable from `library.md`; duplicating it costs tokens every
turn and gives the model two sources that can disagree.

`prefs` goes in the volatile group. It is re-derived and hand-edited, and a few
hundred tokens never justify invalidating the cached prefix.

### External data never reaches a CSS string

Album art URLs come from the music APIs. They were interpolated into a
`url("...")` value for the floating panel's backdrop, which hands external text to
the style parser. The same field was already escaped where it goes into DIDL XML
in `upnp.ts` — CSS was simply missed.

It is an `<img>` now, not a background. `img.src` does not pass through CSS at
all, so the class of bug is gone rather than escaped around. Prefer that shape:
if external data must reach the page, put it somewhere no parser reads as code.

### A dead storefront must announce itself

`ITunesProvider.health()` asks for a word any region should match. Zero results
means the region is unusable, not that the song is missing — on 2026-09-11 the CN
storefront returned zero for every query, English included, while TW/HK/US/JP
answered normally and the HTTP status stayed 200. Silent failure like that turns
`mixed` into NetEase-only without a word on screen, so the default storefront is
TW and the banner reports both halves separately.

`npm run verify` probes the storefront before its catalogue-dependent assertions
and exits naming the region if it is dead. Reporting an environment outage as four
assertion failures sends the next person to read matching code that is fine.

Its fixtures must not encode one catalogue's contents either. A fabricated title
has to be one no region carries — "Whispers Beneath the Tide" is a real ambient
upload in TW — and order is asserted by original index, never by comparing title
strings, because TW and HK answer in traditional characters and `normalize()`
does not convert between them.

### "Repeatedly skipped" means on more than one day

`outcomeStats()` counts distinct days per artist, not rows. Clicking through four
tracks at two seconds each is one action, not four judgements, and counting rows
let a single burst crown an artist on the negative-feedback list — it briefly
advised avoiding keshi and 方大同, the two most replayed artists in the library.

### The server is LAN-exposed, so static serving is security-relevant

`app.listen` binds `0.0.0.0` on purpose — reaching it from a phone is the point.
That means anything serving files from disk is reachable by everyone on the
Wi-Fi, and `public/` sits one directory below `.env` (which holds the model API
key) and `user/` (the personal corpus). A path-traversal bug in the static
handler is not theoretical here. Keep `@fastify/static` current, and treat an
audit finding against it as urgent rather than routine.

## Privacy

`user/*.md` is the owner's personal taste corpus — listening habits, daily
routine, emotional rules. It is **gitignored**. Only `user/*.example.md`
templates are committed.

`user/raw/` holds full platform exports — every track and play count. Also
gitignored, and more sensitive than the corpus itself.

`src/context/assemble.ts` filters out `.example.` files so the blank templates
never get fed into the prompt alongside real corpus content.

Never commit `.env`, `data/`, or third-party reference screenshots.
