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
npm run verify      # 18 pipeline assertions + 13 similarity edge cases; costs nothing
npm run typecheck
npm run certs       # sign a local TLS cert (needs mkcert); re-run when the LAN IP changes
npm run netease:api # start the self-hosted NeteaseCloudMusicApi on :3000
```

Node 25 runs TypeScript natively — there is no build step.

## Architecture invariants

Four layers. Two of them are pluggable adapters; keep them that way.

- **`MusicProvider`** (`src/music/types.ts`) — `itunes` and `netease` implemented;
  `applemusic` is a declared case that throws with an explanation.
- **`BrainAdapter`** (`src/brain/types.ts`) — `claude` and `stub`; adding GLM /
  DeepSeek / Kimi means one new implementation plus a case in
  `src/brain/index.ts`. Nothing above the factory changes.

### The output contract is fixed

The model always returns `{say, play[], reason, segue}` (`DJResponseSchema`).
Stage ① only renders three of those fields; `segue` is a placeholder that feeds
the TTS pipeline in stage ③. **Do not change the shape** to fit a stage-① need.

### `verify` must never touch the network

`npm run verify` promises to cost nothing and to be deterministic. That is why
weather and calendar are fetched in `server.ts` and passed *into* `assemble()`
rather than being fetched inside it — `assemble()` stays callable offline.
Keep it that way when adding to fragment ③.

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

### `alternate` has a second gate: length ratio

Similarity alone does not stop a fabricated title that *contains* a real one —
「永夜的第七章序曲」 wraps 「夜的第七章」 and scores 0.81, over the 0.72 threshold.
When the artist does **not** corroborate (the `alternate` path only), the match
must also clear `ALT_LENGTH_FLOOR` (0.8). Both providers apply it; five `verify`
cases pin the boundary. Do not relax it to make a specific song match.

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

## Privacy

`user/*.md` is the owner's personal taste corpus — listening habits, daily
routine, emotional rules. It is **gitignored**. Only `user/*.example.md`
templates are committed.

`user/raw/` holds full platform exports — every track and play count. Also
gitignored, and more sensitive than the corpus itself.

`src/context/assemble.ts` filters out `.example.` files so the blank templates
never get fed into the prompt alongside real corpus content.

Never commit `.env`, `data/`, or third-party reference screenshots.
