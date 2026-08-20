# Claudio

A personal AI radio station. It reads your listening habits from a handful of
markdown files, picks tracks with reasons it can trace back to them, and talks
to you like a late-night DJ.

Not a recommendation algorithm — a prompt assembler plus a thin layer of API glue.
All the intelligence lives in the corpus you write; the code just keeps it honest.

**Status: stage ① — conversational recommendation with 30-second previews, zero music-source cost.**

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
```

Open http://localhost:8080. The startup banner also prints a LAN address so you
can reach it from your phone on the same Wi-Fi.

```bash
npm run verify      # 11 pipeline assertions + 8 similarity edge cases — costs nothing
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
① External context   user/*.md · model API · iTunes Search API
② Local brain        server.ts · context/ · brain/ · music/ · state/
③ Runtime assembly   six fragments glued into one prompt per turn
④ Surface            PWA (localhost:8080) + HTTP contract
```

### Layer ③ is the whole product

```
① System prompt      src/prompts/dj-persona.md   ┐ stable group
② User corpus        user/*.md                   ┘ cache breakpoint → billed at 1/10
③ Environment        time (weather/calendar TBD) ┐
④ Retrieved memory   state.db · plays            │ volatile — changes every turn
⑥ Execution trace    scheduler/webhook (stage ③) ┘
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
| `applemusic` | stage ② | $99/yr Developer Program + your Apple Music subscription | full playback |
| `netease` | stage ② alternative | free, self-hosted | best Mandarin catalog, unstable API |

iTunes is the right starting point because the `trackId` it returns **is** the
Apple Music catalog ID — the matching logic carries over unchanged when you
upgrade to MusicKit.

**Why not Spotify:** since February 2026, registering a Spotify developer app
requires the account to hold an active Premium subscription, and Development Mode
is capped at one client ID and five authorized users.

## Brain

Swap tiers with `CLAUDIO_MODEL`; `CLAUDIO_BRAIN=stub` runs offline for free.

| Model | Price (per 1M in/out) | ~20 turns/day |
|---|---|---|
| `claude-haiku-4-5` | $1 / $5 | ~$3/mo |
| `claude-sonnet-5` | $3 / $15 | ~$10/mo |
| `claude-opus-5` | $5 / $25 | ~$16/mo |

Cheaper models fabricate more tracks — but fabrications get caught by `resolve()`,
so the failure mode is "fewer recommendations," never "fake recommendations."
Watch the `dropped` counter in the UI; it is a direct measure of hallucination rate.

To use GLM / DeepSeek / Kimi: implement `BrainAdapter`, add a case in
`src/brain/index.ts`. Nothing above the factory changes.

## Roadmap

- [x] **Stage ①** conversational recommendation · hallucination filter · 30s previews
- [ ] **Stage ②** full-track playback (MusicKit JS)
- [ ] **Stage ③** the full station: scheduler · TTS announcements · weather/calendar · UPnP

Stage ③'s HTTP contract (`/api/plan/today`) and tables (`plan`, `prefs`) are
already reserved, so no schema migration is needed later.

## Known limits

- Traditional/simplified Chinese variants are handled by a similarity threshold
  (0.72), not a character mapping table. Edge cases can misjudge.
- Prompt caching needs a stable prefix above the model's minimum (2048 tokens on
  Haiku). A thin corpus silently won't cache — `cacheReadTokens` stays at 0. Write
  more and it starts working.
- The iTunes Search API is public but carries no SLA and no documented rate limits.
- Local-only for now. On `http://<lan-ip>` the browser has no secure context, so
  "Add to Home Screen" and service workers are unavailable.

---
---

# Claudio 中文说明

一个私人 AI 电台。它从几个 markdown 文件里读懂你的听歌习惯，挑歌并给出能追溯到
语料某一条的理由，像深夜电台 DJ 那样跟你说话。

它不是推荐算法，而是**一个 prompt 组装器加一层薄薄的 API 胶水**。全部智能都在
你自己写的语料里，代码只负责让它保持诚实。

**当前状态：阶段① —— 对话式推荐 + 30 秒试听，音源零成本。**

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
```

打开 http://localhost:8080。启动横幅还会打印局域网地址，手机连同一 WiFi 可直接访问。

```bash
npm run verify      # 11 项管线断言 + 8 条相似度边界用例，不花钱
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
① 外部上下文   user/*.md · 模型 API · iTunes Search API
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
| `applemusic` | 阶段② | $99/年 Developer Program + 你的 Apple Music 订阅 | 整曲播放 |
| `netease` | 阶段②备选 | 免费，需自建 | 华语曲库最全，但接口不稳定 |

选 iTunes 起步的理由：它返回的 `trackId` **就是** Apple Music catalog ID，
将来升级 MusicKit 时匹配逻辑可以原样继承。

**为什么不是 Spotify**：2026 年 2 月起，注册 Spotify 开发者应用的账号必须持有
Premium 订阅，且 Development Mode 限 1 个 Client ID、5 个授权用户。

## 大脑

`CLAUDIO_MODEL` 换档位，`CLAUDIO_BRAIN=stub` 离线免费。

| 模型 | 单价（每百万 in/out） | 约 20 轮/天 |
|---|---|---|
| `claude-haiku-4-5` | $1 / $5 | ~$3/月 |
| `claude-sonnet-5` | $3 / $15 | ~$10/月 |
| `claude-opus-5` | $5 / $25 | ~$16/月 |

越便宜的模型越容易编歌 —— 但编的会被 `resolve()` 拦掉，所以失败表现是
「推荐变少」，绝不会是「推荐了假歌」。界面上的 `dropped` 计数就是幻觉率的直接度量。

想用 GLM / DeepSeek / Kimi：实现 `BrainAdapter` 接口，在 `src/brain/index.ts`
加一个 case，工厂以上的代码一行不用改。

## 路线

- [x] **阶段①** 对话推荐 · 幻觉过滤 · 30 秒试听
- [ ] **阶段②** 整曲播放（MusicKit JS）
- [ ] **阶段③** 完整电台：调度器 · TTS 播报 · 天气/日历注入 · UPnP 外放

阶段③的 HTTP 契约（`/api/plan/today`）和数据表（`plan` / `prefs`）已经预留，
届时不需要 schema 迁移。

## 已知边界

- 繁简差异靠相似度阈值（0.72）兜，不是字表转换，极端情况可能误判。
- prompt 缓存要求稳定前缀超过模型门槛（Haiku 是 2048 token）。语料太薄不会报错，
  只是静默地不缓存，`cacheReadTokens` 一直是 0。写厚了就会自动生效。
- iTunes Search API 是公开接口，但无 SLA、无速率限制文档。
- 目前仅本地运行。`http://<局域网IP>` 不是安全上下文，所以「添加到主屏幕」和
  Service Worker 都不可用。
