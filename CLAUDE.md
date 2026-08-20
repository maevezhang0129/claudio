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
npm run verify      # 11 pipeline assertions + 8 similarity edge cases; costs nothing
npm run typecheck
```

Node 25 runs TypeScript natively — there is no build step.

## Architecture invariants

Four layers. Two of them are pluggable adapters; keep them that way.

- **`MusicProvider`** (`src/music/types.ts`) — `itunes` implemented; `applemusic`
  and `netease` are declared cases that throw with an explanation.
- **`BrainAdapter`** (`src/brain/types.ts`) — `claude` and `stub`; adding GLM /
  DeepSeek / Kimi means one new implementation plus a case in
  `src/brain/index.ts`. Nothing above the factory changes.

### The output contract is fixed

The model always returns `{say, play[], reason, segue}` (`DJResponseSchema`).
Stage ① only renders three of those fields; `segue` is a placeholder that feeds
the TTS pipeline in stage ③. **Do not change the shape** to fit a stage-① need.

### Context assembly: stable vs volatile

`src/context/assemble.ts` splits the prompt into a **stable** group (system
prompt + user corpus, marked with a cache breakpoint) and a **volatile** group
(time, recent plays, execution trace).

Never put anything that changes per-turn into the stable group — one timestamp
invalidates the whole cached prefix. `npm run verify` has an assertion guarding this.

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

## Privacy

`user/*.md` is the owner's personal taste corpus — listening habits, daily
routine, emotional rules. It is **gitignored**. Only `user/*.example.md`
templates are committed.

`user/raw/` holds full platform exports — every track and play count. Also
gitignored, and more sensitive than the corpus itself.

`src/context/assemble.ts` filters out `.example.` files so the blank templates
never get fed into the prompt alongside real corpus content.

Never commit `.env`, `data/`, or third-party reference screenshots.
