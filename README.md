# Claudio

A personal AI radio station. It reads your listening habits from a handful of
markdown files, picks tracks with reasons it can trace back to them, and talks
to you like a late-night DJ.

Not a recommendation algorithm — a prompt assembler plus a thin layer of API glue.
All the intelligence lives in the corpus you write; the code just keeps it honest.

**Status: stage ③ — full-track playback, a daily schedule, spoken announcements, and casting to a DLNA device.**

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
npm run verify      # 18 pipeline assertions + 13 similarity edge cases — costs nothing
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
| `itunes` | ✅ implemented | free, no auth | search validation · artwork · 30s preview |
| `netease` | ✅ implemented | free, self-hosted | best Mandarin catalog · full tracks **with a logged-in cookie** |
| `applemusic` | not implemented | $99/yr Developer Program + your Apple Music subscription | full playback |

iTunes is the right starting point because the `trackId` it returns **is** the
Apple Music catalog ID — the matching logic carries over unchanged if you ever
upgrade to MusicKit.

### NetEase: read the cookie note before you switch

```bash
npm run netease:api     # starts a self-hosted NeteaseCloudMusicApi on :3000
CLAUDIO_MUSIC_PROVIDER=netease npm run dev
```

Search and metadata work fine anonymously, and the Mandarin catalog really is
better — `陈奕迅 富士山下` comes back first, where iTunes needs the similarity
threshold to find it.

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

### The alternate path needed a second gate

NetEase's looser search exposed a hole that iTunes never triggered: a fabricated
title that *contains* a real one ("永夜的第七章序曲" wraps the real "夜的第七章")
scores 0.81 on similarity, comfortably over the 0.72 threshold, and leaked
through as an `alternate`.

Similarity alone can't catch it. So when the artist doesn't corroborate — the
`alternate` path, and only there — the match now also has to clear a **length
ratio** floor of 0.8. Traditional/simplified pairs are the same length and pass;
a title wrapped in extra words is 0.625 and doesn't. Five new `verify` cases pin
the boundary.

**Why not Spotify:** since February 2026, registering a Spotify developer app
requires the account to hold an active Premium subscription, and Development Mode
is capped at one client ID and five authorized users.

## Brain

`CLAUDIO_BRAIN` picks the provider, `CLAUDIO_MODEL` the tier. `stub` runs
offline for free.

Measured over six turns each, same prompts, tracks resolved against the catalog
so the hallucination figure is real rather than eyeballed:

| Tier | Median | Exact match | Hallucinated | Per turn |
|---|---|---|---|---|
| **`glm-4.5-air`** (default) | **5.3s** | **94%** | 6% | $0.00055 |
| `glm-4.7-flashx` | 28.6–63.9s | 82% | 0% | $0.00033 |
| `glm-4.7` | 10.8s | 87% | 7% | $0.00180 |
| `glm-4.7-flash` | 30–53s, 1-in-5 succeed | — | — | free |

`glm-4.5-air` wins on both speed and accuracy for about ¥1/month more than the
cheapest usable tier. `flashx` posts a 0% hallucination rate but 18% alternates —
right title, wrong artist — which is worse than nothing, because it looks like a
success. Avoid `glm-4.7-flash`: nominally free, but it runs on shared capacity
and is too slow and too congested for an interactive interface.

Zhipu gives new accounts 25M tokens, which covers the paid tiers. At ~3,300
tokens a turn that is roughly a year at 20 turns a day, so there is no reason to
top up before measuring. Cheaper models fabricate more tracks — but fabrications get caught
by `resolve()`, so the failure mode is "fewer recommendations," never "fake
recommendations." Watch the `dropped` counter in the UI; it is a direct measure
of hallucination rate, and the honest way to decide whether a paid tier earns its
price.

GLM, DeepSeek and Kimi share one implementation (`src/brain/openai-compat.ts`)
because all three speak the OpenAI chat format. It asks for `json_object` mode,
restates the schema in the prompt, validates the reply with Zod, and retries once
with the validation error fed back — none of those providers guarantee strict
`json_schema`, so the client cannot assume the response is well-formed.

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
- [ ] `prefs` — preferences learned from behaviour, merged with the hand-written corpus

The `plan` table and the `/api/plan/today` contract were reserved in stage ①, so
the scheduler landed without a schema migration. `prefs` is still empty and is
the one reserved piece not yet used.

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
- The scheduler plans; nothing yet *fires* at the start of a slot. The lineup is
  there when you open the app, but it will not wake you up.
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

**当前状态：阶段③ —— 整曲播放、当日排期、语音播报、投到 DLNA 设备外放。**

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
npm run verify      # 18 项管线断言 + 13 条相似度边界用例，不花钱
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
| `itunes` | ✅ 已实现 | 免费、零鉴权 | 搜索校验 · 封面 · 30 秒试听 |
| `netease` | ✅ 已实现 | 免费，需自建 | 华语曲库最全 · **带登录 cookie 才能整曲播放** |
| `applemusic` | 未实现 | $99/年 Developer Program + 你的 Apple Music 订阅 | 整曲播放 |

选 iTunes 起步的理由：它返回的 `trackId` **就是** Apple Music catalog ID，
将来若升级 MusicKit，匹配逻辑可以原样继承。

### 网易云：切过去之前先看 cookie 这一段

```bash
npm run netease:api     # 起一个自建的 NeteaseCloudMusicApi，监听 :3000
CLAUDIO_MUSIC_PROVIDER=netease npm run dev
```

匿名状态下搜索和元数据都正常，华语曲库确实更全 —— 搜「陈奕迅 富士山下」
第一条就是原版，iTunes 那边要靠相似度兜。

**但播不了。** 对着真实接口实测：热门结果的 `privilege.pl` 全是 0，
`/song/url` 一律返回 `url: null`，连没有明显版权问题的歌也一样。
不设 `CLAUDIO_NETEASE_COOKIE`（一个已登录账号的 cookie）的话，
这个 provider 只能查不能播，能力严格弱于 iTunes 的 30 秒试听。
带上 cookie 能播的是这个账号有权限的部分，VIP 曲目仍然要 VIP。

还有两件 Apple Music 不会发生的事：翻唱和 AI 生成的上传经常排在原版前面
（搜「周杰伦 晴天」前五条全是翻唱，因为杰威尔的曲库已经不在网易云了），
以及它的搜索松到能让一个编造的曲名匹配上真实条目 ——
后面这条逼出了一个真的修复。

### alternate 那条路需要第二道闸

网易云更松的搜索暴露了一个 iTunes 从没触发过的洞：
一个**包着**真实曲名的编造曲名（「永夜的第七章序曲」裹着真实的「夜的第七章」）
相似度能拿到 0.81，稳稳越过 0.72 的阈值，被当成 alternate 放行。

光靠相似度拦不住。所以当艺人对不上时 —— 也就是 alternate 那条路，且只在那里
—— 匹配还必须再过一道 **长度比** 0.8 的闸。繁简对是等长的，能过；
被额外的词裹起来的曲名是 0.625，过不去。新增 5 条 verify 用例把边界钉死。

**为什么不是 Spotify**：2026 年 2 月起，注册 Spotify 开发者应用的账号必须持有
Premium 订阅，且 Development Mode 限 1 个 Client ID、5 个授权用户。

## 大脑

`CLAUDIO_BRAIN` 选厂商，`CLAUDIO_MODEL` 选档位，`stub` 离线免费。

每档各跑 6 轮相同提示词，曲目全部送去曲库解析，所以幻觉率是实测不是目测：

| 档位 | 中位耗时 | 精确匹配 | 幻觉 | 每轮 |
|---|---|---|---|---|
| **`glm-4.5-air`**（默认） | **5.3s** | **94%** | 6% | $0.00055 |
| `glm-4.7-flashx` | 28.6–63.9s | 82% | 0% | $0.00033 |
| `glm-4.7` | 10.8s | 87% | 7% | $0.00180 |
| `glm-4.7-flash` | 30–53s，成功率 1/5 | — | — | 免费 |

`glm-4.5-air` 速度和准确率都最好，每月只比最便宜的可用档多约 ¥1。
`flashx` 幻觉率 0% 看着漂亮，但有 18% 的 alternate —— 曲名对、艺人不对 ——
那比直接编还糟，因为它看起来像成功了。
别用 `glm-4.7-flash`：名义免费，但走共享容量，对交互界面来说太慢也太挤。

智谱给新账号 2500 万 token，可用于付费档。按每轮约 3300 token 算，
20 轮/天够用一年左右 —— 所以没必要在测够之前就充值。
越便宜的模型越容易编歌，但编的会被 `resolve()` 拦掉，失败表现是「推荐变少」，
绝不会是「推荐了假歌」。界面上的 `dropped` 计数就是幻觉率的直接度量，
也是判断某个付费档值不值这个钱的唯一诚实依据。

GLM / DeepSeek / Kimi 共用一个实现（`src/brain/openai-compat.ts`），因为三家
都讲 OpenAI 的 chat 格式。它要求 `json_object` 模式、在提示词里重述 schema、
用 Zod 校验、失败时把错误回灌重试一次 —— 这三家都不保证严格 `json_schema`，
客户端不能假设返回一定合规。

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
- [ ] `prefs` —— 从行为里学到的偏好，与手写语料合并

`plan` 表和 `/api/plan/today` 契约在阶段①就预留好了，所以调度器落地时
一次 schema 迁移都不需要。`prefs` 还是空的，是唯一一处预留了但还没用上的地方。

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
- 调度器只负责**排**，还没有东西在时段开始时**触发**。
  节目表在你打开应用时就在那儿，但它不会主动叫醒你。
- 外放只做了只读验证（发现、描述解析、`GetTransportInfo`）。
  `SetAVTransportURI` + `Play` 走的是同一条 SOAP 路径，但故意没有真的发出去 ——
  那会让别人客厅里的电视突然开始放歌。
