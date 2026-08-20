# Claudio

个人 AI 电台 —— 读懂听歌习惯 → 规划声音 → 像 DJ 那样播报。

当前处于**阶段①**：对话式推荐 + 30 秒试听，零音源成本。

## 快速开始

```bash
npm install

# 从模板生成你自己的语料（这几个文件不会被提交）
for f in taste routines mood-rules; do cp user/$f.example.md user/$f.md; done

# 离线模式：不调 API、不花钱，用固定剧本驱动，用来调前端
npm run dev:stub

# 真实模式：需要 ANTHROPIC_API_KEY
cp .env.example .env   # 填入 key
npm run dev
```

打开 http://localhost:8080

```bash
npm run verify      # 端到端验证（不花钱）
npm run typecheck
```

> **注意**：`ANTHROPIC_API_KEY` 和 Claude Pro / Max 订阅是**两套账**。
> 订阅不含 API 额度，需要在 console.anthropic.com 单独充值（最低 $5）。

## 让它属于你

Claudio 的全部个性来自 `user/` 下的三个文件。仓库里只有 `*.example.md` 空模板，
**你的真实语料不会被提交**（`user/*.md` 在 `.gitignore` 里）—— 里面有作息这类私人信息。

| 文件 | 写什么 |
|---|---|
| `user/taste.md` | 长期偏好、明确不听的、会反复回去听的 |
| `user/routines.md` | 什么时间在做什么、各需要什么样的声音 |
| `user/mood-rules.md` | 「我说 X，你该理解成 Y」的翻译表 |

写得越具体越好。「喜欢周杰伦」没用，「喜欢周杰伦 2001–2005 的编曲密度」才有用。

`routines.md` 里的时间表还会驱动界面上那个时钟 —— 写了 `- 07:00–09:00 通勤：…`
之后，早上打开时时钟下面显示的就是「通勤」而不是通用的「清晨」。

## 架构

四层，和施工图一一对应。

```
① 外部上下文    user/*.md · Claude API · iTunes Search API
② 本地大脑      server.ts · context/ · brain/ · music/ · state/
③ 运行时聚合    每次触发把 6 片粘成一个 prompt
④ 交互表层      PWA (localhost:8080) + HTTP 契约
```

### 第三层是重点

```
① 系统提示词   src/prompts/dj-persona.md   ┐ 稳定组
② 用户语料     user/*.md                   ┘ 打缓存断点，命中后按 1/10 计费
③ 环境注入     时间（天气/日历待接入）      ┐
④ 已检索记忆   state.db · plays            │ 易变组，每轮都变
⑥ 执行轨迹     调度器/webhook（阶段③）      ┘
⑤ 用户输入     走 messages
        ↓
  模型前向 → {say, play[], reason, segue}
        ↓
  provider 逐首解析 play[] → 过滤幻觉 → 落库 → 推给前端
```

**稳定组和易变组必须分开**。时间戳、播放记录这类每轮都变的内容一旦混进
稳定组，整个缓存前缀就作废了。`npm run verify` 里有一条断言专门守这个。

### 关键设计：resolve() 三态

模型只输出「歌名 + 艺人」，由 provider 解析成真实曲目。返回三种结果：

| 结果 | 含义 | 处理 |
|---|---|---|
| `exact` | 曲名和艺人都对上 | 正常播 |
| `alternate` | 曲名对上、艺人不同 | 播，但向用户交代差异 |
| `null` | 曲名都对不上 | 判定为幻觉，丢弃 |

`alternate` 存在的理由是真实的：「买辣椒也用券」在 Apple Music 上叫
「冯沁苑LaJiao」，同一个人。把它当幻觉丢掉是错的，假装匹配成功也是错的。

## 音源 provider

音源是可插拔的（`CLAUDIO_MUSIC_PROVIDER`）：

| provider | 状态 | 成本 | 能力 |
|---|---|---|---|
| `itunes` | ✅ 已实现 | 免费、零鉴权 | 搜索校验 + 封面 + 30s 试听 |
| `applemusic` | 阶段② | $99/年 Developer Program + 你的 Apple Music 订阅 | 整曲播放 |
| `netease` | 阶段②备选 | 免费，需自建服务 | 华语曲库最全，但接口不稳定 |

选 iTunes 起步的理由：它返回的 `trackId` **就是** Apple Music catalog ID，
将来升级到 MusicKit 时曲库匹配逻辑可以直接继承，不用重新对齐。

### 为什么不是 Spotify

Spotify 自 2026-02 起，注册开发者应用的账号**必须持有 Premium 订阅**，
Development Mode 限 1 个 Client ID、5 个授权用户。没有 Premium 就无法注册。

## 大脑

`CLAUDIO_MODEL` 换档位，`CLAUDIO_BRAIN=stub` 离线不花钱。

| 模型 | 单价（每百万 in/out） | 20 轮/天约合 |
|---|---|---|
| `claude-haiku-4-5`（默认） | $1 / $5 | ~$3/月 |
| `claude-sonnet-5` | $3 / $15 | ~$10/月 |
| `claude-opus-5` | $5 / $25 | ~$16/月 |

Haiku 对小众和华语曲目的知识弱一些，会更容易编歌 —— 但编的会被
`resolve()` 拦掉，表现为「推荐数量偏少」而不是「推荐了假歌」。
觉得不够再往上换，改一个环境变量的事。

想换 GLM / DeepSeek：实现 `BrainAdapter` 接口，在 `src/brain/index.ts`
加一个 case，上层一行不用动。

## 路线

- [x] **阶段①** 对话推荐 + 幻觉过滤 + 30 秒试听
- [ ] **阶段②** 整曲播放（MusicKit JS）
- [ ] **阶段③** 完整电台：调度器 · TTS 播报 · 天气/日历注入 · UPnP 外放

第③阶段的 HTTP 契约（`/api/plan/today`）和数据表（`plan` / `prefs`）
已经预留好了，届时不用改 schema。

## 已知边界

- 繁简差异靠相似度阈值兜（0.72），不是靠字表转换。极端情况可能误判。
- 稳定组目前约 1000 token，**低于 Haiku 的 2048 缓存门槛**，所以缓存
  暂时不会命中（不报错，只是 `cacheReadTokens` 一直是 0）。等你把
  `user/*.md` 写厚就会自动生效。
- iTunes Search API 是公开接口但无 SLA，没有速率限制文档。
