# Claudio

A personal AI radio station. It reads your listening habits from a handful of
markdown files, picks tracks with reasons it can trace back to them, and talks
to you like a late-night DJ.

Not a recommendation algorithm — a prompt assembler plus a thin layer of API glue.
All the intelligence lives in the corpus you write; the code just keeps it honest.

**Status: stage ③ complete — a mixed music source, a schedule that fires on its own, spoken announcements, and casting to a DLNA device.**

[中文说明见下方](#claudio-中文说明)

---

## Quick start

```bash
npm install

# Create your own corpus from the templates (these files are never committed)
for f in taste routines mood-rules; do cp user/$f.example.md user/$f.md; done

# Offline mode — no API calls, no cost. Fixed scripts drive the UI.
npm run dev:stub

# Live mode — needs a model API key
cp .env.example .env
npm run dev

# Sign a local TLS cert so the phone gets a secure context (needed to install the PWA)
brew install mkcert && mkcert -install    # once per machine, asks for your password
npm run certs                             # re-run whenever your LAN IP changes
```

Open https://localhost:8080. The startup banner also prints a LAN address so you
can reach it from your phone on the same Wi-Fi.

```bash
npm run verify      # 34 pipeline assertions + 33 matching edge cases — costs nothing
npm run typecheck
```

Node 25 runs TypeScript natively, so there is no build step.

> **Billing note:** an Anthropic API key is **not** included with a Claude Pro or
> Max subscription. API usage is metered separately at console.anthropic.com.

## Making it yours

Claudio's entire personality comes from three files in `user/`. The repo ships
only `*.example.md` templates — **your real corpus is gitignored**, because it
contains your daily routine and other personal details.

| File | What goes in it |
|---|---|
| `user/taste.md` | Long-term preferences, hard exclusions, albums you keep returning to |
| `user/routines.md` | What you're doing at what hour, and what each moment needs to sound like |
| `user/mood-rules.md` | A translation table: "when I say X, I mean Y" |

Specificity is everything. "I like Jay Chou" is useless. "I like the arrangement
density of Jay Chou's 2001–2005 records; after that he started copying himself"
is something a DJ can actually cite.

`routines.md` also drives the clock in the interface. Write
`- 07:00–09:00 commute: …` and the display reads **commute** at 7:30 instead of
a generic "morning."

### Seeding from your existing library

Writing taste from a blank page is hard. If you use Apple Music on a Mac, export
what you already listen to and let the numbers speak first:

```bash
npm run export:apple   # reads Music.app over AppleScript → user/raw/apple-music.json
npm run ingest         # distills it → user/library.md
```

The raw export is far too large for a prompt — a few hundred tracks is already
hundreds of thousands of tokens, and the model would drown in IDs. `ingest`
distills it to roughly 1,200 tokens: artists ranked by **play count rather than
save count** (saving a lot is not the same as listening a lot), genre and era
distribution, the tracks you actually loop, and your own playlist names — which
say more about how you file music than any statistic.

Both the raw export and `library.md` are gitignored. Re-run either command
whenever your library changes.

## Design

`design/mockup.html` records the visual direction — open it in a browser, the
clock is live. The short version: the interface's metaphor is **broadcast, not
chat**. The largest element carries no interaction, tracks are a numbered queue
under one persistent player, and green means exactly one thing: live.
See `design/README.md` for the reasoning.

## Architecture

Four layers.

```
① External context   user/*.md · model API · music API · Open-Meteo · Calendar.app
② Local brain        server.ts · context/ · brain/ · music/ · state/
③ Runtime assembly   six fragments glued into one prompt per turn
④ Surface            PWA (localhost:8080) + HTTP contract
```

### Layer ③ is the whole product

```
① System prompt      src/prompts/dj-persona.md   ┐ stable group
② User corpus        user/*.md                   ┘ cache breakpoint → billed at 1/10
③ Environment        time · weather · calendar  ┐
④ Retrieved memory   state.db · plays            │ volatile — changes every turn
⑥ Execution trace    the scheduler, when it fires┘
⑤ User input         goes through messages
        ↓
  model → {say, play[], reason, segue}
        ↓
  provider resolves play[] → filters hallucinations → persists → pushes to client
```

**The stable and volatile groups must stay separate.** One timestamp leaking into
the stable group invalidates the entire cached prefix. `npm run verify` guards this
with a dedicated assertion.

### Key design: `resolve()` returns three states

The model only emits `{title, artist}`. The provider turns that into a real track:

| Result | Meaning | Handling |
|---|---|---|
| `exact` | title and artist both match | play normally |
| `alternate` | title matches, artist differs | play, but tell the user why |
| `null` | title doesn't match anything | hallucination — discard |

`alternate` earns its place: the artist 买辣椒也用券 on NetEase is listed as
冯沁苑LaJiao on Apple Music — same person. Discarding that as a hallucination is
wrong, and pretending it matched is also wrong. Alternates are demoted to the end
of the queue and capped at one per reply.

## Music providers

Pluggable via `CLAUDIO_MUSIC_PROVIDER`.

| Provider | Status | Cost | Capabilities |
|---|---|---|---|
| **`mixed`** | ✅ **default** | free | NetEase recognises, iTunes plays — see the measurements below |
| `itunes` | ✅ implemented | free, no auth | search validation · artwork · 30s preview |
| `netease` | ✅ implemented | free, self-hosted | best Mandarin catalog · full tracks **with a logged-in cookie** |
| `applemusic` | not implemented | $99/yr Developer Program + your Apple Music subscription | full playback |

iTunes is the right starting point because the `trackId` it returns **is** the
Apple Music catalog ID — the matching logic carries over unchanged if you ever
upgrade to MusicKit.

### Measured: three providers, one set of tracks

30 tracks sampled from the owner's library by play count, three runs each. The
ranges are what matters — a single run of NetEase would have told a much more
flattering story than the truth.

| Provider | exact /30 | not resolved | playable /30 | median |
|---|---|---|---|---|
| `itunes` | 23 (identical all three runs) | 4 | 26 | 173–211 ms |
| `netease` | **20–26** | **1–8** | **0** | 1308–1656 ms |
| `mixed` | 24–26 | 1–2 | 27 | 168–197 ms |

Three things fall out of this:

**NetEase is the better catalogue and the less reliable service.** At its best it
resolves 26/30 against iTunes' 23; at its worst, 20. That spread is the
reverse-engineered API, not the catalogue — nothing changed between runs.
iTunes returned byte-identical results all three times.

**`mixed` is never worse than iTunes, and costs nothing in latency.** It asks
iTunes first and only wakes NetEase when iTunes is unsure, so the 77% of tracks
iTunes already nails skip the slow path entirely. It also inherits iTunes'
stability rather than NetEase's variance.

**The first version of `mixed` was worse than iTunes alone**, and only a test
caught it. It asked NetEase first and used its canonical name to look up audio;
for 「买辣椒也用券 - 起风了」 NetEase canonicalises to a 20-artist karaoke upload
that iTunes has never heard of, so the track went from playable to silent.
Starting from iTunes and treating NetEase as a second opinion makes the
improvement strictly additive.

### NetEase: read the cookie note before you switch

```bash
npm run netease:api     # starts a self-hosted NeteaseCloudMusicApi on :3000
npm run netease:login   # SMS code or QR; writes the cookie into .env
```

`netease:login` exists because the alternative is "open DevTools, find Cookies,
copy a 300-character string" — three steps that each invite a mistake, on a Mac
where F12 is the volume key. The script drives the self-hosted API's own login
flow and merges the result into `.env`, leaving every other line alone.

It defaults to an SMS code rather than the QR. The QR encodes a URL, so scanning
it with a camera or a browser opens a web login page — which signs the phone in
and completes nothing here, leaving the terminal waiting forever while every
signal on the phone says it worked. Only the NetEase Music app's own scanner
finishes that handshake. The SMS path needs no app at all.

Both can still be refused: NetEase answers `10004`, "this sign-in carries
security risk", to logins that do not come from an official client, and a proxy
on the route makes that likelier. So there is a third option that cannot be
refused -- log in with the browser, paste the cookie. It takes the whole cookie
string, the `MUSIC_U=` form, or the bare value, and checks it against the account
endpoint **before** writing: a credential that does not work should fail here,
not silently three days later as "why is everything still 0:30".

Search and metadata work fine anonymously, and the Mandarin catalog really is
better — `陈奕迅 富士山下` comes back first, where iTunes needs the similarity
threshold to find it. (An earlier note here quoted 87% against 77% from a single
run; the table above replaces it with the three-run range, which is 20–26 out of
30 against a flat 23.)

**Playback does not.** Measured anonymously against the live API: `privilege.pl`
is `0` for every top hit, and `/song/url` returns `url: null` across the board —
including tracks with no obvious licensing issue. Without
`CLAUDIO_NETEASE_COOKIE` set to a logged-in account, this provider can look songs
up but cannot play a single one, which makes it strictly weaker than iTunes'
30-second previews. With a cookie, you get whatever that account has rights to;
VIP tracks still need VIP.

Two more things the catalog does that Apple Music doesn't: covers and AI-generated
uploads frequently outrank the originals (searching `周杰伦 晴天` returns five
covers before anything else, because JVR's catalog is no longer licensed there),
and its search is fuzzy enough that a fabricated title can match a real upload.
That second one forced a real fix — see below.

### Two bugs the hallucination filter was hiding

NetEase's looser search exposed a hole: a fabricated title that *contains* a real
one — the invented 「永夜的第七章序曲」 wraps the real 「夜的第七章」 — scores 0.81
on similarity, over the 0.72 threshold, and leaked through.

Similarity cannot catch that on its own, so a match must now also clear a
**length-ratio floor of 0.8**. Traditional/simplified pairs are the same length
and pass; a title padded with extra words is 0.5–0.63 and does not.

The floor was first installed only on the `alternate` path, on the reasoning that
containment is trustworthy when the artist agrees. That reasoning was wrong, and
the test for `mixed` proved it: what a model actually fabricates is a **real
artist with a padded title**, so the artist always agrees and the match sailed
through the first pass. The floor now applies to both passes.

Chasing that down turned up something worse, present since the first commit:

```
normalize("Soft Spot")  ->  "so"
```

The `feat.` stripper was written as `/\s*(feat\.?|ft\.?|…)\s+.+$/i`. With `\s*`
accepting zero whitespace, the `ft` inside "So**ft** Spot" read as a featuring
marker and everything after it was discarded. Exactly one track in the owner's
library is affected — and it is the second most-played one, at 77 plays. Because
the invented "Soft Spot in the Rain" also collapsed to `"so"`, the two were
*identical* after normalisation and scored 1.000.

Requiring whitespace before the Latin markers fixes it. The Chinese markers 与/和
keep the opposite guard — whitespace is required *after* them, or 「我和我的祖国」
would truncate to 「我」. Eight `normalize` cases and eight length-ratio cases now
pin both boundaries.

## The station (stage ③)

Stage ① answered when you asked. Stage ③ is what makes it a station: it knows
what the weather is doing, it has a schedule, it talks, and it can play out loud.

### Environment: weather and calendar

Weather comes from **Open-Meteo** — free, no key, no account, chosen for the same
reason as iTunes. Calendar reads your local `Calendar.app` over AppleScript, the
same route `scripts/export-apple-music.mjs` uses for Music.app; the data is
already on this machine, so there is no reason to reach for a cloud API.

Both are **off the critical path**. Each has its own timeout and degrades to a
single honest line, because a turn must never fail over a nice-to-have. The
prompt distinguishes "not wired up" from "wired up but couldn't fetch" — say it
vaguely and the model will invent a forecast.

Calendar is opt-in (`CLAUDIO_CALENDAR=on`): the first read triggers a system
permission prompt, and Calendar's Apple Events are slow enough that the latency
should be a choice, not a surprise.

Both land in the **volatile** group. Weather changes every 15 minutes; in the
stable group it would invalidate the cached prefix dozens of times a day. Four
`verify` assertions hold that line.

### Announcements: `say` and `segue` finally get used

`segue` has been in the output contract since day one, rendered as text and
otherwise idle. It exists for this.

Speech uses the browser's **Web Speech API** — no cloud TTS, no key, no bill,
consistent with everything else here. The two fields fire at different moments,
which is the whole point:

- `say` — when the reply arrives, before the music starts
- `segue` — when the **whole queue** finishes, because it's a hook pointing at
  next time. Reading it after every track would turn it into recited copy.

Music ducks to 15% while the DJ talks, the way a real station does. The MIC
toggle in the header is off by default and its state persists; iOS only allows
the first `speak()` inside a user gesture, so the toggle doubles as the unlock.

### Scheduler: the station has a lineup

`POST /api/plan/today` walks the slots in your `routines.md` and pre-books a set
for each one. Slots are planned **serially, not in parallel** — each one is told
what the earlier ones already took, or a day's four slots recommend the same five
songs.

This is also where fragment ⑥ (execution trace) stops being a placeholder. A
scheduled turn tells the model it was woken by the timetable and which slot it's
booking, so the DJ writes "when your commute rolls around" instead of opening
cold.

Planning costs money — one model call per slot — so it only ever happens on an
explicit `POST`. `GET` reads the stored plan and is free; the UI polls that
freely and puts the spend behind a button. Re-posting returns the cached plan
unless you pass `force`.

### The timetable fires on its own

The scheduler books the slots; a one-minute ticker is what actually *starts*
them. It recomputes which slot the clock is in and compares it to the previous
minute — deliberately dumb, and deliberately not a set of pre-armed timers:
`routines.md` gets edited, and a laptop sleeps. Polling the wall clock survives
both; a `setTimeout` armed six hours ago survives neither.

By default the ticker never plans. Planning calls the model and costs money, and
that cannot follow from a clock reaching a mark on its own. `CLAUDIO_AUTOPLAN=on`
is the human saying it may: with the flag set, arriving at a slot that has no
lineup books one. It skips slots that already have one, and skips fallback slot
names entirely — a name that isn't in `routines.md` has no time range to plan
for, so calling the model would buy nothing. With the flag unset the scheduler is
not even reachable from the timer.

On handoff the client loads that slot's lineup into the queue and stops there.
It does not start playing: browsers block autoplay without a gesture anyway, and
interrupting whatever you are listening to because the clock moved is rude. If
something is already playing, it only leaves a line in the feed.

### The queue only holds things it can actually play

A track the catalogue knows but this source cannot sound — NetEase has it, iTunes
does not, and no cookie is set — used to enter the queue anyway and turn into a
link out to a web page. A radio station that ejects you is not a radio station.
Those are now counted as `unplayable` and left out, separately from `dropped`,
which counts fabrications. One fewer song beats one dead row.

A new recommendation also starts playing on its own. The send click is the user
gesture browsers require, so `play(0)` is allowed there. A slot handoff has no
gesture and only cues.

### Out-of-library picks are demanded in the prompt and counted in code

Asked for nothing, the DJ recommends the artists already at the top of
`library.md` — the safest picks and the least useful ones, because those are the
songs you would have played yourself.

Stating the rule in the persona did nothing: it is a long document and a countable
constraint buried inside it does not register with a small model. Restated as the
last section of the volatile group — the end of the prompt — it moved a turn from
3 library-only tracks to 6 with genuinely new names among them.

The model cannot check itself, though. It will write "Taylor Swift is an
out-of-library pick" about an artist with 186 plays, because deciding whether a
name appears on a chart thousands of tokens earlier is exactly what it is bad at.
So `countFresh()` parses the artists out of `library.md` and counts, and the
result is fed back the next turn: "you gave 0 genuinely new ones last time."

Measured on a fresh session, same prompt: 3 of 4 out-of-library, then 5 of 5.

**It does not hold on a session with a long transcript.** The same prompt against
a session carrying a dozen library-heavy turns returns 0 new artists, and
shortening the history window to 8 messages did not change that — the model is
imitating its own past replies more strongly than it is following the constraint.
Clearing the session restores the behaviour. This is a limit of `glm-4.5-air`,
not of the plumbing.

### A floating window, for working alongside

`FLOAT` opens the station in a Document Picture-in-Picture window: a small
always-on-top panel that stays visible over an editor or a browser. It carries the
signature element — the dot-matrix clock — plus what is playing and the transport.

The panel is **moved** into that window rather than copied, so every element
reference and bound handler keeps working and the two views cannot drift apart.
The `<audio>` element stays behind in the main document; moving it would cut
playback. Chrome only; elsewhere the button says so.

### What counts as "played" depends on the medium

The threshold was "six tenths of it, **or** thirty seconds" — the second half
added back when 30-second previews were all there was, so a preview heard to the
end would not read as a skip.

Turning on full playback made that half wrong the same minute. Thirty-one seconds
of a 4:36 track satisfied it, so abandoning a song after half a minute was filed
as having listened to it. That corrupts the only negative signal in the system.

It is six tenths, full stop, because the duration the client reports is the
duration of **the media in the player** — `audio.duration`, not the track's
metadata. A preview heard to the end is 30 of 30; a full track heard for three
minutes is 180 of 276. One rule, correct on both. The absolute figure survives
only for when the duration is unknown.

Rows now also store that duration. Without it a row reading "listened 77 seconds"
cannot be re-judged later — preview heard through, or full track abandoned early?
— so a change to the rule can never be applied backwards.

### The `plays` table was recording recommendations

A row was written the moment a track entered the queue, and the client never
reported anything back. So the table held a *recommendation* history wearing a
*listening* history's name, and fragment ④ told the model "you played these"
about songs that had never been opened. The profile's Played count said 9 when
the true number was 0.

Rows now carry an `outcome`. Recommending writes `queued`; the client reports
what actually happened and it becomes `played` or `skipped`. Fragment ④ drops
`queued` entirely and spells the other two out:

```
- 陈奕迅 - 富士山下（12 分钟前，听完了）
- Beyond - 海阔天空（12 分钟前，只听了 4 秒就切走了）
```

The skip line is the valuable one. It is the only negative signal anywhere in
this system — the corpus, the library export and every derived preference all
describe things the owner likes. "I queued this for you and you killed it in four
seconds" is the one input that can say otherwise, and rendering it as a play
throws it away.

Timing accumulates only while audio is actually playing; pausing and
backgrounding stop the clock, or a paused tab overnight would count as eight
hours of listening. Duration comes from the media element rather than the track
metadata: a 30-second preview reports four minutes in its metadata, so measuring
against that would mark every completed preview as a skip.

A report **inserts** a row rather than updating the `queued` one. The first
version updated — `UPDATE ... WHERE provider_id = ?` — which silently assumed the
track had just been recommended in conversation. Anything played from the
scheduler's lineup, or from re-loading an older turn out of history, had no such
row: the UPDATE matched nothing, the endpoint still answered `ok`, and the
listening was dropped. That is the worst shape a bug can take, and it gutted the
one path meant to generate volume. Two rows is also the truer model — `queued` is
a recommendation log, `played`/`skipped` a listening log, each with its own real
timestamp.

### Learned preferences: `prefs`

`npm run prefs` derives a first pass from the library export. The split from the
corpus is strict, and it is the point:

| Where | What belongs there |
|---|---|
| `user/taste.md` | what only you know — why you like it, when not to play it |
| `user/library.md` | the distilled picture — top artists, genres, eras, loops |
| `prefs` | what only arithmetic knows |

So `prefs` deliberately repeats none of `library.md`'s charts. It stores the
things they cannot express:

- **`artist.deep`** — plays *divided by* track count. TREASURE has 540 plays
  spread over 56 tracks; keshi has 256 over 8. One of those is collecting a
  group, the other is wearing eight songs out. A single ranked list flattens the
  difference; the ratio keeps it.
- **`artist.shallow`** — the other end of that ratio. Saved a lot, played little,
  so don't treat them as strong signal.
- **`track.dormant`** — `taste.md` says outright that never-played ≠ disliked, but
  `library.md` only reports the count (103). This names them. Two filters earn
  their place: titles carrying a version marker are excluded, and so is anything
  whose normalised title duplicates a played track by the same artist. Without
  them the list is nothing but TREASURE's tour set and 陶喆's live album — songs
  nobody forgot, just alternate takes.
- **`library.unplayed`** — 16% of the library has never been played, which is a
  measure of appetite for the unfamiliar.
- **`behaviour.recent`** — the only entry not derived from the Apple export.
  It reads the `plays` table: how many recommendations were finished, how many
  were killed, and which artists keep getting killed. It is written only once at
  least 20 outcomes exist; below that a "you dislike X" computed from four rows
  is noise, and the model will not doubt its corpus — it will just comply.

It lands in the **volatile** group, not with the corpus. It gets re-derived and
hand-edited, and a few hundred tokens are not worth invalidating a 5,000-character
cached prefix over. `GET /api/prefs` and `PUT /api/prefs/:key` make it editable
without SQL; two assertions keep it out of the stable group.

### Cast: play it out loud

`src/cast/upnp.ts` speaks SSDP and AVTransport directly — a UDP multicast
M-SEARCH to find renderers, then SOAP to drive them. No dependency: the fields to
read are a fixed handful, and this project's entire dependency list is three
packages.

The URL handed to the device must be reachable **by the device**. That mkcert
certificate means nothing to a television — which is fine, because iTunes preview
URLs and NetEase stream URLs are public either way. DIDL-Lite metadata rides
along so the screen shows a title and artwork instead of a URL. Casting pauses
local playback, so the same song doesn't play twice in one room.

Verified against a real DLNA renderer on the LAN: discovery, description
parsing, and the SOAP round-trip (`GetTransportInfo` → `NO_MEDIA_PRESENT`).

## Roadmap

- [x] **Stage ①** conversational recommendation · hallucination filter · 30s previews
- [x] **Stage ②** full-track playback — via NetEase, not MusicKit ([why](#netease-read-the-cookie-note-before-you-switch))
- [x] **Stage ③** scheduler · spoken announcements · weather/calendar · UPnP cast
- [x] `prefs` — preferences derived from behaviour, alongside the hand-written corpus

Every table and contract reserved in stage ① is now in use, and none of them
needed a schema migration to get there.

## Known limits

- Traditional/simplified Chinese variants are handled by a similarity threshold
  (0.72), not a character mapping table. Edge cases can misjudge.
- Prompt caching needs a stable prefix above the model's minimum (2048 tokens on
  Haiku). A thin corpus silently won't cache — `cacheReadTokens` stays at 0. Write
  more and it starts working.
- The iTunes Search API is public but carries no SLA and no documented rate limits.
- Local-only. `npm run certs` fixes the secure-context problem on the LAN, but
  the certificate is bound to an IP — change Wi-Fi and you re-run it. A phone
  also has to trust the mkcert root CA separately (AirDrop `rootCA.pem`, install
  the profile, then enable it under Certificate Trust Settings).
- The NetEase provider needs a logged-in cookie to play anything at all, and the
  self-hosted API it depends on is reverse-engineered — it can break without
  notice. See the provider section above.
- A slot handoff loads the lineup into the queue but never starts playback, so
  the station still needs you to press play. Browsers block autoplay without a
  gesture, and this is the honest version of that constraint rather than a
  workaround for it.
- `mixed` inherits NetEase's dependency: if the self-hosted API is down, it
  degrades to plain iTunes rather than failing, and the startup banner says so
  instead of pretending it is still mixing.
- The server binds `0.0.0.0` so a phone can reach it, which puts `public/` one
  directory below `.env` and `user/` on the local network. That makes the static
  handler security-relevant: `@fastify/static` is pinned to a version without the
  known path-traversal advisories, and should stay that way.
- Keep the checkout off an iCloud-synced folder. With "Desktop & Documents" sync
  on, iCloud's file provider intercepts reads under `node_modules`: the same
  small file takes anywhere from 2 ms to 7 s, and imports eventually fail with
  `ECANCELED`. The symptom is a server that starts, prints nothing, and never
  listens.
- Casting was verified read-only against a real renderer (discovery, description,
  `GetTransportInfo`). `SetAVTransportURI` + `Play` follow the same SOAP path but
  were deliberately not fired — that makes a television in someone's living room
  start playing music.

---
---

# Claudio 中文说明

一个私人 AI 电台。它从几个 markdown 文件里读懂你的听歌习惯，挑歌并给出能追溯到
语料某一条的理由，像深夜电台 DJ 那样跟你说话。

它不是推荐算法，而是**一个 prompt 组装器加一层薄薄的 API 胶水**。全部智能都在
你自己写的语料里，代码只负责让它保持诚实。

**当前状态：阶段③ 完成 —— 混合音源、会自己到点换档的排期、语音播报、投到 DLNA 设备外放。**

## 快速开始

```bash
npm install

# 从模板生成你自己的语料（这几个文件不会被提交）
for f in taste routines mood-rules; do cp user/$f.example.md user/$f.md; done

# 离线模式：不调 API、不花钱，用固定剧本驱动前端
npm run dev:stub

# 真实模式：需要模型 API key
cp .env.example .env
npm run dev

# 签一张本地证书，手机才有安全上下文（装 PWA 的前提）
brew install mkcert && mkcert -install    # 每台机器一次，会要一次密码
npm run certs                             # 换 WiFi、IP 变了就重跑
```

打开 https://localhost:8080。启动横幅还会打印局域网地址，手机连同一 WiFi 可直接访问。

```bash
npm run verify      # 34 项管线断言 + 33 条匹配边界用例，不花钱
npm run typecheck
```

Node 25 原生执行 TypeScript，没有构建步骤。

> **计费提醒**：Anthropic API key 和 Claude Pro / Max 订阅是**两套账**，
> 订阅不含 API 额度，需要在 console.anthropic.com 单独充值。

## 让它属于你

Claudio 的全部个性来自 `user/` 下的三个文件。仓库里只有 `*.example.md` 空模板，
**你的真实语料不会被提交** —— 里面有作息等私人信息。

| 文件 | 写什么 |
|---|---|
| `user/taste.md` | 长期偏好、明确不听的、会反复回去听的 |
| `user/routines.md` | 什么时间在做什么、各需要什么样的声音 |
| `user/mood-rules.md` | 「我说 X，你该理解成 Y」的翻译表 |

具体是一切。「喜欢周杰伦」没用；「喜欢周杰伦 2001–2005 的编曲密度，之后越来越像
自我复制」才是 DJ 能拿来解释一次推荐的东西。

`routines.md` 还驱动界面上那个时钟 —— 写了 `- 07:00–09:00 通勤：…` 之后，
早上 7:30 打开时时钟下面显示的是「通勤」，而不是通用的「清晨」。

## 设计

`design/mockup.html` 记录了视觉方向 —— 用浏览器打开，时钟是活的。一句话概括：
界面的隐喻是**广播，不是聊天**。最大的元素不承担交互，曲目是一条编号队列配一个
常驻播放器，绿色只意味着一件事：正在播。理由见 `design/README.md`。

## 架构

四层。

```
① 外部上下文   user/*.md · 模型 API · 音源 API · Open-Meteo · Calendar.app
② 本地大脑     server.ts · context/ · brain/ · music/ · state/
③ 运行时聚合   每次触发把六片粘成一个 prompt
④ 交互表层     PWA (localhost:8080) + HTTP 契约
```

### 第三层就是产品本身

```
① 系统提示词   src/prompts/dj-persona.md   ┐ 稳定组
② 用户语料     user/*.md                   ┘ 打缓存断点，命中后按 1/10 计费
③ 环境注入     时间（天气/日历待接入）      ┐
④ 已检索记忆   state.db · plays            │ 易变组，每轮都变
⑥ 执行轨迹     调度器/webhook（阶段③）      ┘
⑤ 用户输入     走 messages
        ↓
  模型 → {say, play[], reason, segue}
        ↓
  provider 逐首解析 → 过滤幻觉 → 落库 → 推给前端
```

**稳定组和易变组必须分开。** 一个时间戳混进稳定组，整个缓存前缀就作废。
`npm run verify` 有一条断言专门守这个。

### 关键设计：`resolve()` 三态

模型只输出「歌名 + 艺人」，由 provider 解析成真实曲目：

| 结果 | 含义 | 处理 |
|---|---|---|
| `exact` | 曲名和艺人都对上 | 正常播 |
| `alternate` | 曲名对上、艺人不同 | 播，但向用户交代原因 |
| `null` | 曲名对不上任何东西 | 判定为幻觉，丢弃 |

`alternate` 存在的理由是真实的：网易云上的「买辣椒也用券」在 Apple Music 上叫
「冯沁苑LaJiao」，同一个人。把它当幻觉丢掉是错的，假装匹配成功也是错的。
alternate 一律降级到队列末尾，且每次回复最多保留一首。

## 音源 provider

通过 `CLAUDIO_MUSIC_PROVIDER` 切换。

| provider | 状态 | 成本 | 能力 |
|---|---|---|---|
| **`mixed`** | ✅ **默认** | 免费 | 网易云认歌、iTunes 出声 —— 实测见下 |
| `itunes` | ✅ 已实现 | 免费、零鉴权 | 搜索校验 · 封面 · 30 秒试听 |
| `netease` | ✅ 已实现 | 免费，需自建 | 华语曲库最全 · **带登录 cookie 才能整曲播放** |
| `applemusic` | 未实现 | $99/年 Developer Program + 你的 Apple Music 订阅 | 整曲播放 |

选 iTunes 起步的理由：它返回的 `trackId` **就是** Apple Music catalog ID，
将来若升级 MusicKit，匹配逻辑可以原样继承。

### 实测：三个 provider，同一批曲目

从曲库里按播放次数取样 30 首，每个 provider 跑三轮。**要看的是区间** ——
只跑一轮的话，网易云会给出一个比事实好看得多的故事。

| provider | exact /30 | 解析不到 | 可播 /30 | 中位耗时 |
|---|---|---|---|---|
| `itunes` | 23（三轮完全一致） | 4 | 26 | 173–211 ms |
| `netease` | **20–26** | **1–8** | **0** | 1308–1656 ms |
| `mixed` | 24–26 | 1–2 | 27 | 168–197 ms |

三个结论：

**网易云是更好的曲库，也是更不可靠的服务。** 状态好的时候 26/30，
比 iTunes 的 23 强；状态差的时候 20。这个跨度来自那套逆向接口本身 ——
两轮之间什么都没改。iTunes 三轮返回的结果一字不差。

**`mixed` 不会比 iTunes 差，而且不额外付延迟。** 它先问 iTunes，
只在 iTunes 没把握时才叫醒网易云，于是 iTunes 本来就能搞定的那 77%
完全不走慢路径。稳定性也跟着 iTunes 走，而不是跟着网易云的方差走。

**`mixed` 的第一版比单用 iTunes 还差**，是测试抓出来的。
那一版先问网易云、再拿它的规范名去换音源；
「买辣椒也用券 - 起风了」被网易云归一化成一个 20 人合唱的翻唱上传，
iTunes 根本没听说过这个东西，于是这首歌从「能播」变成了「哑的」。
改成以 iTunes 打底、网易云只当第二意见之后，网易云带来的就只有加法。

### 网易云：切过去之前先看 cookie 这一段

```bash
npm run netease:api     # 起一个自建的 NeteaseCloudMusicApi，监听 :3000
npm run netease:login   # 手机验证码或扫码，cookie 自动写进 .env
```

之所以有 `netease:login`：另一条路是「打开开发者工具 → 找 Cookies →
复制一串 300 字符」，三步每一步都能出错，而 Mac 上连打开开发者工具
都得先知道 F12 是音量键。脚本把自建服务本身的登录流程驱动起来，
然后把结果合并进 `.env` —— 其余每一行都不动。

默认走**手机验证码**而不是扫码。二维码里是一个网址，
用相机或浏览器扫会打开网页登录页 —— 那会让手机登录成功，
但这边的握手一步都没完成，终端会一直等下去，
而手机上每一个信号都在说「成功了」。只有网易云音乐 App 自己的扫一扫
能完成那个握手。验证码那条路根本不需要 App。

两条路都可能被拒：网易云对非官方客户端发起的登录会返回 `10004`
「当前登录存在安全风险」，链路上有代理时更容易触发。
所以还有第三条不会被拒的路 —— 在浏览器里登录，把 cookie 粘过来。
整段 cookie、`MUSIC_U=` 形式、或只有值本身都接受，
而且**写入之前先拿账号接口验一遍**：一个不能用的凭据应该在这里就失败，
而不是三天后以「怎么还全是 0:30」的形式浮出来。

匿名状态下搜索和元数据都正常，华语曲库确实更全 —— 搜「陈奕迅 富士山下」
第一条就是原版，iTunes 那边要靠相似度兜。（这里早先引过「87% 对 77%」，
那是单轮数字；上面那张表用三轮区间取代了它 —— 实际是 20–26 对稳定的 23。）

**但播不了。** 对着真实接口实测：热门结果的 `privilege.pl` 全是 0，
`/song/url` 一律返回 `url: null`，连没有明显版权问题的歌也一样。
不设 `CLAUDIO_NETEASE_COOKIE`（一个已登录账号的 cookie）的话，
这个 provider 只能查不能播，能力严格弱于 iTunes 的 30 秒试听。
带上 cookie 能播的是这个账号有权限的部分，VIP 曲目仍然要 VIP。

还有两件 Apple Music 不会发生的事：翻唱和 AI 生成的上传经常排在原版前面
（搜「周杰伦 晴天」前五条全是翻唱，因为杰威尔的曲库已经不在网易云了），
以及它的搜索松到能让一个编造的曲名匹配上真实条目 ——
后面这条逼出了一个真的修复。

### 幻觉过滤器藏着的两个 bug

网易云更松的搜索暴露了一个洞：一个**包着**真实曲名的编造曲名
（「永夜的第七章序曲」裹着真实的「夜的第七章」）相似度 0.81，
越过 0.72 的阈值被放行。

光靠相似度拦不住，所以匹配现在还必须过一道 **长度比 0.8** 的闸。
繁简对等长，能过；被额外的词裹起来的曲名是 0.5–0.63，过不去。

这道闸最初只装在 alternate 那条路上，理由是「艺人对上时包含是可信的」。
那个理由是错的，给 `mixed` 写的测试证明了这一点：模型真正会编的，
恰恰是**真艺人 + 加了料的曲名** —— 那种情况艺人当然对得上，
于是从第一趟就大摇大摆走了过去。现在两趟都过闸。

顺着查下去还翻出一个更糟的，从初版就在：

```
normalize("Soft Spot")  ->  "so"
```

剥 `feat.` 的那条正则写成了 `/\s*(feat\.?|ft\.?|…)\s+.+$/i`。
`\s*` 允许零个空白，于是「So**ft** Spot」里的 `ft` 被当成合唱标记，
后面全被丢掉。这个库里只有一首歌中招 —— 正好是播放次数第二高的那首，77 次。
而编造的「Soft Spot in the Rain」也同样塌成 `"so"`，
两者归一化后**完全相同**，相似度 1.000。

要求英文标记前面必须有空白就修好了。中文的 与/和 保留相反的约束 ——
它们后面必须有空白，否则「我和我的祖国」会被截成「我」。
现在 8 条 normalize 用例和 8 条长度比用例把两边的边界都钉死了。

## 电台本身（阶段③）

阶段①是你问它才答。阶段③才让它成为一个电台：它知道外面什么天气，
有自己的节目表，会说话，能在屋里放出来。

### 环境注入：天气与日程

天气用 **Open-Meteo** —— 免费、不用 key、不用注册，选它的理由和当初选 iTunes
一模一样。日程走 AppleScript 读本机 `Calendar.app`，
和 `scripts/export-apple-music.mjs` 读 Music.app 是同一条路子：
数据本来就在这台机器上，没理由去接一个云日历。

两者都**不在关键路径上**。各自带超时，取不到就降级成一行老实话 ——
一轮对话绝不该因为一个锦上添花的东西而失败。提示词里明确区分
「没接入」和「接了但这次没取到」：含糊其辞会让模型自己编一个天气出来。

日程默认关闭（`CLAUDIO_CALENDAR=on` 打开）：第一次读会弹系统授权框，
而且 Calendar 的 Apple Event 慢到那个延迟应该由用户自己选择承担，而不是撞上。

两者都进**易变组**。天气每 15 分钟变一次，混进稳定组的话缓存前缀一天要作废几十次。
4 条 verify 断言守着这条线。

### 语音播报：`say` 和 `segue` 终于派上用场

`segue` 从第一天起就在输出契约里，一直只被渲染成文本，闲置至今。它就是为这一刻存在的。

合成用浏览器自带的 **Web Speech API** —— 不接云 TTS、不要 key、不产生账单，
和这个项目其他所有决定一致。两个字段在不同时机触发，这正是关键：

- `say` —— 回复到达时念，在音乐开始之前
- `segue` —— **整个队列**播完时才念，因为它是指向下一次的钩子。
  每首歌后面都念一遍，它就变成念稿子了。

DJ 说话时音乐压到 15%，和真实电台一样。顶栏的 MIC 开关默认关闭、状态会记住；
iOS 只允许在用户手势里发起第一次 `speak()`，所以这个开关同时充当解锁动作。

### 调度器：电台有节目表了

`POST /api/plan/today` 遍历 `routines.md` 里的时段，为每一档预排一组歌。
各档是**串行**排的，不是并行 —— 后一档要看得见前面已经用掉了哪些歌，
否则一天四档很可能各自推荐同样那五首。

这里也是第⑥片（执行轨迹）第一次不再是占位符。由调度器触发的那一轮会告诉模型：
你是被时间表叫醒的、正在为哪一档排期。于是 DJ 写出来的是
「等你那个通勤时段到了」，而不是凭空开始介绍歌。

排期要花钱 —— 一档一次模型调用 —— 所以它只在显式 `POST` 时发生。
`GET` 只读库、免费，前端可以随便轮询，把花钱那一步放在按钮后面。
重复 POST 会直接返回已有的计划，除非带 `force`。

### 节目表会自己到点

调度器负责**排**，真正让它**开始**的是一个一分钟的触发器。
它每分钟重算一次「现在属于哪一档」，和上一分钟比。
刻意写得笨，也刻意不用预先排好的定时器：`routines.md` 随时会改，
笔记本会睡眠。每分钟看一眼墙上的钟，这两件事都扛得住；
六小时前排下的 `setTimeout` 一件都扛不住。

默认情况下触发器永远不排期。排期要调模型、要花钱，
那不能仅仅因为时钟走到某一格就发生。`CLAUDIO_AUTOPLAN=on` 是人点的那个头：
打开之后，换到一个还没有节目单的档就为它排一次。
已经有节目单的档不重排，兜底时段名直接跳过 ——
一个没写进 `routines.md` 的名字没有对应的时间段，调模型什么也换不到。
不打开这个开关时，调度器根本不在定时器能触及的路径上。

换档时前端把那一档的节目单载进队列，然后就停在那儿。
它不会自动开始播：浏览器本来就不允许无手势自动播放，
而且因为时钟动了就打断你正在听的东西很粗暴。
已经在播的时候，它只在对话流里留一行。

### 队列里只放放得出声的东西

曲库认得、但这套音源发不出声的曲目 —— 网易云有、iTunes 没有、又没配 cookie ——
过去照样进队列，点下去变成跳转到一个网页。**一个会把你踢出去的电台不是电台。**
这类现在计入 `unplayable` 并被排除，与统计幻觉的 `dropped` 分开。
少一首，好过队列里躺着一行点不动的东西。

新推荐也会自动播第一首。发送键那一下就是浏览器要的用户手势，
所以那里的 `play(0)` 不会被拦。换档没有手势，只能预置。

### 库外曲目：提示词提要求，代码来核对

什么都不说的话，DJ 会推 `library.md` 榜首那几位 ——
最安全也最没用，因为那些歌你自己就会放。

把规则写进人设**没有任何效果**：人设是一大段文字，
可数的约束埋在中间，小模型读不出它的分量。
改成放在易变组的最后一节（也就是整个 prompt 的末尾），
同一轮就从「3 首全是库内」变成「6 首里有真正的新名字」。

但模型核对不了自己。它会一边写「Taylor Swift 是库外推荐」，
一边推一个你播过 186 次的艺人 —— 判断「这个名字在不在几千 token 之前那张榜上」
恰恰是它最不擅长的事。所以 `countFresh()` 从 `library.md` 里解析出艺人名来数，
数完的结果回灌给下一轮：「上一轮你只给出了 0 首真正库外的」。

全新会话实测，同一条 prompt：4 首里 3 首库外，下一轮 5 首全是库外。

**但它在历史很长的会话里不成立。** 同样的 prompt，在一个攒了十几轮
库内推荐的会话里返回 0 首新艺人；把历史窗口缩到 8 条也没改变结果 ——
模型模仿自己过往回复的力度，压过了那条约束。清空会话就恢复正常。
这是 `glm-4.5-air` 的能力边界，不是管线的问题。

### 一个陪着你工作的悬浮窗

`FLOAT` 用 Document Picture-in-Picture 把电台开成一个小窗：
**始终置顶**，压在编辑器或浏览器之上。里面留着签名元素 ——
点阵时钟 —— 加上在播曲目和走带。

面板是**搬**进那个窗口的，不是复制：所以所有元素引用和已绑定的处理器继续有效，
两边不可能各说各话。`<audio>` 留在主文档 —— 搬动它播放就断了。
仅 Chrome 支持，其他浏览器点了会明说。

### 「算听过」的门槛取决于放的是什么

原来的判定是「听满六成，**或者**听够 30 秒」。后半句是当年只有 30 秒试听时
加的，为了让一段听到底的试听不被当成跳过。

整曲播放打开的那一分钟，后半句就错了：一首 4:36 的歌听 31 秒也满足它，
于是「听了半分钟就切掉」被记成了「听过」。
那会污染系统里**唯一的负反馈**。

现在只剩「六成」这一条，因为前端上报的时长是**播放器里那段媒体**的时长
（`audio.duration`），不是曲目元数据。试听听到底是 30/30，
整曲听三分钟是 180/276 —— 同一条规则两边都对。
那个绝对值只在拿不到时长时才兜底。

每一行现在还会记下那段媒体多长。没有它，一行「听了 77 秒」事后无从判断：
究竟是听完的试听，还是听了个开头就切的整曲。规则一改，历史数据就再也重算不了。

### `plays` 表一直记的是推荐，不是收听

曲目进队列的那一刻就写一行，而前端从来不上报任何东西。
于是这张表拿着「收听历史」的名字装着**推荐历史**，
第④片在告诉模型「你听过这些」—— 而其中大部分从没被点开过。
资料页的 Played 显示 9，真实数字是 0。

现在每行带一个 `outcome`。推荐时写 `queued`，前端上报实际发生了什么，
它才变成 `played` 或 `skipped`。第④片直接丢掉 `queued`，
并把另外两种如实说出来：

```
- 陈奕迅 - 富士山下（12 分钟前，听完了）
- Beyond - 海阔天空（12 分钟前，只听了 4 秒就切走了）
```

有价值的是「切走了」那一行。它是整个系统里**唯一的负反馈** ——
语料、曲库导出、所有推导出来的偏好，描述的全是喜欢的东西。
「我推给你，你四秒就切了」是唯一能说出相反意见的输入，
把它渲染成一次播放，就等于把它扔掉。

计时只在音频真的在播时累加：暂停、切后台都停表，
否则挂着一个暂停的标签页过夜会被记成听了八小时。
时长取播放器实际媒体的时长而不是曲目元数据 ——
30 秒试听的元数据时长是整曲的四分钟，按那个算，
每一次完整听完的试听都会被判成跳过。

上报是**插入**新行，而不是去改那条 `queued`。第一版是改的
（`UPDATE ... WHERE provider_id = ?`），那个写法默默假设了
「这首歌刚被对话推荐过」。从调度器节目单播的、从历史里重新载入的旧队列，
plays 表里都没有那一行：UPDATE 一行都没命中，接口却照样返回 `ok`，
收听被静默丢掉 —— 而那恰恰是本该产生收听量的那条路径。
分成两种行语义也更真：`queued` 是推荐流水，`played`/`skipped` 是收听流水，
各自的时间戳都是真的。

### 从行为学到的偏好：`prefs`

`npm run prefs` 从曲库导出推出第一版。它和语料的分工是硬的，
而这正是重点：

| 在哪 | 该写什么 |
|---|---|
| `user/taste.md` | 只有你知道的事 —— 为什么喜欢、什么时候不听 |
| `user/library.md` | 蒸馏出的画像 —— 常听艺人、曲风、年代、循环榜 |
| `prefs` | 只有算术知道的事 |

所以 `prefs` 刻意不重复 `library.md` 的任何一张榜，只存它们表达不了的东西：

- **`artist.deep`** —— 播放次数**除以**曲目数。TREASURE 播了 540 次，
  摊在 56 首上；keshi 播了 256 次，只有 8 首。
  一个是「收藏了一个团」，一个是「这八首听到烂」。
  单一排行榜会把这两种喜欢压平，比值把它们分开。
- **`artist.shallow`** —— 同一个比值的另一端。收得多播得少，
  不该被当成强信号。
- **`track.dormant`** —— `taste.md` 明确写了「没播放过 ≠ 不喜欢」，
  但 `library.md` 只给了个数字（103 首）。这里把它们点名。
  两道过滤是必须的：曲名带版本标记的排除，
  归一化后与同一艺人某首播过的歌重名的也排除 ——
  不滤的话这份名单就只剩 TREASURE 的巡演 setlist 和陶喆的现场专辑，
  那些歌没人忘记，它们只是另一个版本。
- **`library.unplayed`** —— 16% 的曲目从没播过，这是对陌生东西的胃口。
- **`behaviour.recent`** —— 唯一不来自 Apple 导出的一条。
  它读 `plays` 表：推过的里面听完了多少、切掉了多少、哪些艺人反复被切。
  只有在至少 20 条有结论的记录之后才写 —— 低于这个数，
  从四行记录上算出来的「你不喜欢 X」是噪声，
  而模型不会怀疑自己的语料，它只会照做。

它进**易变组**，不跟语料放在一起。它会被重新推导、也会被手改，
几百 token 不值得让一段 5000 字符的缓存前缀作废。
`GET /api/prefs` 和 `PUT /api/prefs/:key` 让它不用写 SQL 就能改；
两条断言守着它不进稳定组。

### 外放：让它在屋里响

`src/cast/upnp.ts` 直接讲 SSDP 和 AVTransport —— 先用 UDP 组播发一个 M-SEARCH
找渲染器，再用 SOAP 驱动它。不引依赖：要读的字段就固定那几个，
而这个项目的全部依赖只有三个包。

交给设备的 URL 必须是**设备自己能访问到的**。那张 mkcert 证书对一台电视毫无意义 ——
不过无所谓，iTunes 试听和网易云直链本来就是公网地址。
DIDL-Lite 元数据一起带过去，这样电视屏幕上显示的是曲名和封面，不是一串 URL。
投出去之后本机会暂停，免得同一首歌在一个屋里放两遍。

已对局域网上一台真实 DLNA 渲染器验证：发现、描述解析、SOAP 往返
（`GetTransportInfo` → `NO_MEDIA_PRESENT`）全部打通。

## 路线

- [x] **阶段①** 对话推荐 · 幻觉过滤 · 30 秒试听
- [x] **阶段②** 整曲播放 —— 走网易云，不是 MusicKit（[原因](#网易云切过去之前先看-cookie-这一段)）
- [x] **阶段③** 调度器 · 语音播报 · 天气/日程注入 · UPnP 外放
- [x] `prefs` —— 从行为里推导的偏好，与手写语料并列

阶段①预留的表和契约现在全部用上了，而且没有一处需要 schema 迁移。

## 已知边界

- 繁简差异靠相似度阈值（0.72）兜，不是字表转换，极端情况可能误判。
- prompt 缓存要求稳定前缀超过模型门槛（Haiku 是 2048 token）。语料太薄不会报错，
  只是静默地不缓存，`cacheReadTokens` 一直是 0。写厚了就会自动生效。
- iTunes Search API 是公开接口，但无 SLA、无速率限制文档。
- 仅本地运行。`npm run certs` 解决了局域网的安全上下文问题，但证书绑定 IP ——
  换了 WiFi 就得重跑。手机还要单独信任 mkcert 的根证书
  （AirDrop 传 `rootCA.pem` → 安装描述文件 → 证书信任设置里打开）。
- 网易云 provider 不带登录 cookie 就一首也播不了，且它依赖的自建服务是逆向的，
  随时可能失效。见上面 provider 那一节。
- 换档只把节目单载进队列，不会开始播 —— 电台仍然需要你按一下。
  浏览器本来就不允许无手势自动播放，这是如实呈现那个限制，不是绕过它。
- `mixed` 继承了网易云那份依赖：自建服务挂掉时它会退化成纯 iTunes 而不是报错，
  启动横幅会明说退化了，不会假装还在混合。
- 服务器绑 `0.0.0.0`，手机才连得上 —— 代价是 `public/` 的上一层就是 `.env`
  和 `user/`，而这些在局域网上都可达。所以静态文件服务是有安全含义的：
  `@fastify/static` 锁在没有已知路径穿越公告的版本上，别让它退回去。
- 仓库别放在被 iCloud 同步的目录里。开着「桌面与文稿」同步时，
  iCloud 的文件提供程序会拦截 `node_modules` 下的读操作：
  同一个小文件耗时在 2ms 到 7 秒之间乱跳，最后 import 直接 `ECANCELED`。
  症状是服务起来了、什么都不打印、也永远不 listen。
- 外放只做了只读验证（发现、描述解析、`GetTransportInfo`）。
  `SetAVTransportURI` + `Play` 走的是同一条 SOAP 路径，但故意没有真的发出去 ——
  那会让别人客厅里的电视突然开始放歌。
