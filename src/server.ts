/**
 * Claudio 本地服务器 —— 图一第二层的中枢 + 第四层的 HTTP 契约。
 *
 * 一次 /api/chat 的完整链路：
 *   取历史 -> 组装六片上下文 -> 大脑吐 {say, play[], reason, segue}
 *   -> provider 逐首解析 play[]（同时过滤幻觉） -> 落库 -> 返回前端
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { config } from "./config.ts";
import { assemble } from "./context/assemble.ts";
import { currentSlot, parseRoutines } from "./context/routines.ts";
import { currentWeather } from "./context/weather.ts";
import { countFresh, familiarArtists } from "./context/library.ts";
import { todayCalendar } from "./context/calendar.ts";
import { createBrain } from "./brain/index.ts";
import { createMusicProvider } from "./music/index.ts";
import type { ResolveResult, Track } from "./music/types.ts";
import { Store } from "./state/store.ts";
import { buildPlan, today } from "./schedule/planner.ts";
import { Ticker } from "./schedule/ticker.ts";
import { cast, discover, stop as castStop, transportInfo } from "./cast/upnp.ts";
import type { Device } from "./cast/upnp.ts";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 有证书就走 https。
 *
 * 不是为了「安全」—— 本地服务没人攻击。是因为 Service Worker、
 * 「添加到主屏幕」、以及阶段②整曲播放的播放 SDK 都硬性要求安全上下文，
 * 而 http://<局域网IP> 不是。localhost 是特例（浏览器豁免），
 * 所以只有手机访问时这件事才真正卡人。
 *
 * 证书缺失不报错，退回 http —— 克隆下来没跑过 npm run certs 的人
 * 应该能直接 npm run dev 起来，只是手机上装不了 PWA。
 */
function tlsOptions() {
  const cert = path.join(config.rootDir, "certs", "local-cert.pem");
  const key = path.join(config.rootDir, "certs", "local-key.pem");
  if (!existsSync(cert) || !existsSync(key)) return null;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// https: null 是 fastify 明确支持的「就是要 http」写法。写成三元表达式
// 会让两个重载各推出一种 server 类型，下面所有路由都跟着变成联合类型。
const tls = tlsOptions();
const app = Fastify({ logger: { level: "warn" }, https: tls });

const store = new Store(config.dbPath);
const music = createMusicProvider({
  name: config.musicProvider,
  itunesStorefront: config.itunesStorefront,
  neteaseBaseUrl: config.neteaseBaseUrl,
  neteaseCookie: config.neteaseCookie,
});
const brain = createBrain({
  kind: config.brainKind,
  model: config.model,
  apiKey: config.apiKey,
  compatApiKey: config.compatApiKey,
  baseURL: config.compatBaseURL,
});

/** 当前大脑是否已具备调用条件 —— 缺 key 时前端要给出可操作的提示 */
const brainReady =
  config.brainKind === "stub" ||
  (config.brainKind === "claude" ? Boolean(config.apiKey) : Boolean(config.compatApiKey));

/**
 * 一次回复里最多保留几首 alternate（曲名对上、艺人不同）。
 * 折中策略：不全丢也不全留 —— 降级到末尾 + 限量。
 */
const MAX_ALTERNATES = 1;

/**
 * 上一轮实际给出了几首库外曲目。
 *
 * **不按会话分**。这条约束是关于这个听众的，不是关于某一段对话的：
 * 前端每打开一次页面就换一个新会话，按会话记的话，
 * 一场收听的第一句永远拿不到回灌 —— 而第一句恰恰最重要。
 *
 * 只放内存：唯一的用途是下一轮把话说回给模型，服务重启后从头数一遍
 * 没有任何损失，不值得为它开一张表。
 */
let lastFresh: number | undefined;

/** 解析后的曲目 + 匹配置信度，发给前端 */
interface ResolvedTrack extends Track {
  confidence: "exact" | "alternate";
  note?: string;
}

await app.register(fastifyStatic, {
  root: path.join(config.rootDir, "public"),
});

app.get("/api/health", async () => ({
  ok: true,
  model: brain.model,
  musicProvider: music.name,
  capabilities: music.capabilities,
  hasApiKey: brainReady,
  // provider 的外部依赖在不在。mixed 在网易云挂掉时会静默退化成纯 iTunes，
  // 不报出来的话用户会以为自己在用混合音源。
  source: await music.health?.().catch(() => null) ?? null,
}));

/** 直接搜歌，不经过大脑 —— 图一第二层 router.js 里「简单指令走直连」那条 */
app.get<{ Querystring: { q?: string } }>("/api/search", async (req, reply) => {
  const q = req.query.q?.trim();
  if (!q) return reply.code(400).send({ error: "缺少查询参数 q" });
  return { tracks: await music.search(q, 10) };
});

app.post<{ Body: { message?: string; session?: string } }>(
  "/api/chat",
  async (req, reply) => {
    const message = req.body?.message?.trim();
    const session = req.body?.session ?? "default";
    if (!message) return reply.code(400).send({ error: "message 不能为空" });

    if (!brainReady) {
      return reply.code(503).send({
        error: config.brainKind === "claude"
          ? "没有配置 ANTHROPIC_API_KEY。注意这跟 Claude Pro/Max 订阅是两套账，" +
            "需要在 console.anthropic.com 单独充值后拿 key，写进 .env。"
          : `没有配置 ${config.brainKind.toUpperCase()}_API_KEY，写进 .env 即可。` +
            "GLM 在 bigmodel.cn 申请，glm-4.7-flash 档位免费。",
      });
    }

    // ③ 环境里的天气和日程在这里取，不在 assemble 里 ——
    // assemble 要被 npm run verify 反复调用，必须保持不依赖网络。
    // 两个都自带超时和降级，取不到不影响这一轮。
    const [weather, calendar] = await Promise.all([
      currentWeather({ latitude: config.latitude, longitude: config.longitude }),
      todayCalendar({ enabled: config.calendarEnabled }),
    ]);

    // 六片上下文：③环境 ④记忆 由这里注入，①②从文件读，⑤是 message，⑥阶段①为空
    const context = await assemble({
      rootDir: config.rootDir,
      recentPlays: store.recentPlaysAsContext(15),
      prefs: store.prefsAsContext(),
      justQueued: store.recentQueuedAsContext(session, 10),
      weather,
      calendar,
      lastFresh,
    });

    const history = store.recentMessages(session, 20).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let result;
    try {
      result = await brain.think({ context, history, input: message });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({
        error: `大脑调用失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const dj = result.response;

    // 逐首解析 —— 并行，且解析不到的直接丢弃（幻觉过滤）
    const settled = await Promise.all(
      dj.play.map((q) => music.resolve(q).catch(() => null)),
    );

    // exact 保持模型给的顺序（那个顺序本身是叙事）；
    // alternate 一律降级到末尾并限量 —— 跨平台艺名不一致是常态，
    // 全丢会误杀真歌（「买辣椒也用券」= 「冯沁苑LaJiao」），
    // 但全留会让同名不同曲的噪音淹掉正经推荐
    // （问 Brian Eno 的《Music for Airports》，端上来一个冥想合辑）。
    const exact: ResolvedTrack[] = [];
    const alternates: ResolvedTrack[] = [];
    let dropped = 0;
    /**
     * 曲库里确实存在、但这套音源放不出声的。
     *
     * 典型是网易云认得而 iTunes 没有、且没配 cookie 的那种。
     * 以前它们会进队列，点下去只能跳去网易云网页 ——
     * 一个会把你踢出去的电台不是电台。宁可这一轮少一首。
     */
    let unplayable = 0;
    for (const r of settled) {
      if (!r) { dropped++; continue; }
      if (!playable(r.track)) { unplayable++; continue; }
      (r.confidence === "exact" ? exact : alternates).push(toResolvedTrack(r));
    }
    const keptAlternates = alternates.slice(0, MAX_ALTERNATES);
    /** 超出上限被裁掉的 alternate 数量 —— 与 dropped（幻觉）性质不同，分开报 */
    const trimmed = alternates.length - keptAlternates.length;
    const tracks = [...exact, ...keptAlternates];

    // 核对这一轮真的带来了几首库外的。模型自己说不准 ——
    // 它会一边写「这是库外推荐」一边推一个播过 186 次的艺人。
    //
    // 必须数**真正进了队列**的那些，不能数裁剪前的候选集：
    // 数候选集会得出「库外 6 首」而队列里只有 3 首这种自相矛盾的数字，
    // 而且回灌给下一轮的也是个虚高的值，模型会以为自己已经做到了。
    const fresh = countFresh(tracks, await familiarArtists(config.rootDir));
    lastFresh = fresh;

    const turn = {
      say: dj.say,
      reason: dj.reason,
      segue: dj.segue,
      tracks,
      /** 模型编了几首、被曲库拦下来了 —— 用于观察模型质量 */
      dropped,
      /** 有几首 alternate 因为超出上限被裁掉 */
      trimmed,
      /** 有几首存在但没有可播音源 —— 与幻觉性质不同，分开报 */
      unplayable,
      /** 有几首的艺人不在曲库画像里 —— 电台带来的新东西 */
      fresh,
      usage: result.usage,
      model: result.model,
    };

    // 落库。assistant 那条带上整轮 payload，刷新后曲目卡片才能原样恢复。
    store.appendMessage(session, "user", message);
    store.appendMessage(session, "assistant", dj.say, turn);
    // 只记「进了队列」。有没有真的被听，等前端上报 —— 见 POST /api/played。
    for (const t of tracks) store.recordQueued(session, t);

    return turn;
  },
);

/** 刷新后恢复整屏 —— 曲目、理由、过渡语都在 payload 里 */
app.get<{ Querystring: { session?: string } }>("/api/history", async (req) => {
  const session = req.query.session ?? "default";
  return { turns: store.historyWithPayload(session, 40) };
});

/**
 * 给一首歌换一个新鲜的播放地址。
 *
 * 网易云的直链是限时的，而队列可能来自很久以前：开机恢复的上一场、
 * 对话流里点回去的旧队列、调度器早上排好的节目单 —— 到播的时候
 * 那串地址早就 403 了。曲目本身没问题，只是那把钥匙过期了。
 *
 * 重新走一遍 resolve 而不是单独调 song/url：一来复用同一套匹配逻辑，
 * 二来 provider 之间的差异不该泄漏到这个接口上。
 */
app.get<{ Querystring: { title?: string; artist?: string } }>(
  "/api/stream",
  async (req, reply) => {
    const { title, artist } = req.query;
    if (!title || !artist) {
      return reply.code(400).send({ error: "需要 title 和 artist" });
    }
    const r = await music.resolve({ title, artist }).catch(() => null);
    if (!r || !playable(r.track)) {
      return reply.code(404).send({ error: "现在拿不到这首歌的播放地址" });
    }
    return {
      url: r.track.fullPlayback?.ref ?? r.track.previewUrl,
      durationMs: r.track.durationMs,
    };
  },
);

/**
 * 最近一次有曲目的推荐。开机预置播放器用 ——
 * 前端不重画对话，但播放器不该是空的。
 */
app.get("/api/last-queue", async () => ({ turn: store.lastQueue() }));

/** 清空会话。调语料时频繁用到 —— 旧历史会污染新语料的效果判断。 */
app.delete<{ Params: { id: string } }>("/api/session/:id", async (req) => {
  store.clearSession(req.params.id);
  return { ok: true };
});

/**
 * 时钟签名的数据源：当前时间 + 从 routines.md 解析出的场景名。
 * 前端每分钟拉一次，不在前端硬编码时间表 —— 那是用户语料，不是代码。
 */
app.get("/api/now", async () => {
  const now = new Date();
  const slot = await currentSlot(config.rootDir, now);
  const air = ticker.onAir;
  // 这一档有节目单就一并带上 —— 前端每分钟本来就要拉这个接口，
  // 换档时不必再多发一次请求就能把队列换掉。
  const plan = air?.hasPlan
    ? (store.planForDay(today()).find((p) => p.slot === air.slot)?.payload ?? null)
    : null;
  return { epoch: now.getTime(), slot, onAir: air, plan };
});

/** 资料页：语料 + 从 plays 表算出来的数字 */
app.get("/api/profile", async () => {
  const { played, peakHour } = store.stats();
  let routines = 0;
  try {
    routines = parseRoutines(
      await readFile(path.join(config.rootDir, "user", "routines.md"), "utf8"),
    ).length;
  } catch {
    // 语料不存在
  }
  return { played, peakHour, routines };
});

/**
 * 这首歌有没有能塞进 <audio> 的东西。
 * 整曲或 30 秒试听，有一个就行；两个都没有的进了队列也只能跳外部。
 */
function playable(t: Track): boolean {
  return Boolean(t.previewUrl || t.fullPlayback);
}

function toResolvedTrack(r: ResolveResult): ResolvedTrack {
  return { ...r.track, confidence: r.confidence, note: r.note };
}

// ---- 调度器（阶段③）。契约在阶段①就固定下来了，这里把它填上 ----

/** 读当日节目单。纯读库，不花钱 —— 前端可以随便轮询。 */
app.get("/api/plan/today", async () => {
  const day = today();
  return { day, plan: store.planForDay(day) };
});

/**
 * 排期。单独用 POST 而不是让 GET 顺手生成 ——
 * 这是一次会花钱的操作（一档一次模型调用），必须是显式触发的，
 * 绝不能因为有人打开了页面就跑起来。
 */
app.post<{ Body: { slot?: string; force?: boolean } }>(
  "/api/plan/today",
  async (req, reply) => {
    if (!brainReady) {
      return reply.code(503).send({ error: "没有配置大脑 API key，排不了期" });
    }
    const day = today();
    const slot = req.body?.slot;

    // 已经排过就直接返回，除非显式要求重排。防的是手抖多点几下，
    // 每一下都是真的模型调用。
    if (!req.body?.force) {
      const existing = store.planForDay(day);
      const hit = slot ? existing.filter((p) => p.slot === slot) : existing;
      if (hit.length) return { day, plan: hit, cached: true };
    }

    try {
      const plans = await buildPlan({
        rootDir: config.rootDir,
        brain,
        music,
        store,
        day,
        onlySlot: slot,
      });
      if (!plans.length) {
        return reply.code(422).send({
          error: "routines.md 里没有能解析出的时间段，无法排期。" +
            "写成 `- 07:00–09:00 通勤：…` 这种形式。",
        });
      }
      return { day, plan: plans, cached: false };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({
        error: `排期失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
);

/** 清掉当日节目单，便于改完语料重排 */
app.delete("/api/plan/today", async () => {
  const day = today();
  store.clearPlan(day);
  return { ok: true, day };
});

// ---- UPnP 外放（阶段③）----
//
// 发现要等 3 秒广播，不能每次投歌都重来一遍，所以最近一次的结果留着。
// 键用 location（设备描述文件地址），它比 IP 稳 —— DHCP 换址后描述文件
// 地址也会变，正好该重新发现。
const renderers = new Map<string, Device>();

app.get("/api/cast/devices", async () => {
  const found = await discover(3000);
  renderers.clear();
  for (const d of found) renderers.set(d.location, d);
  return {
    devices: found.map((d) => ({
      location: d.location,
      ip: d.ip,
      friendlyName: d.friendlyName,
    })),
  };
});

/**
 * 投一首过去。
 *
 * url 必须是**设备自己能访问到的公网直链** —— 本机那张 mkcert 证书
 * 对电视毫无意义。iTunes 试听和网易云直链本来就是公网地址，直接转交。
 */
app.post<{
  Body: {
    location?: string;
    url?: string;
    title?: string;
    artist?: string;
    album?: string;
    artworkUrl?: string;
  };
}>("/api/cast/play", async (req, reply) => {
  const { location, url } = req.body ?? {};
  if (!location || !url) {
    return reply.code(400).send({ error: "需要 location 和 url" });
  }
  const device = renderers.get(location);
  if (!device) {
    return reply.code(404).send({ error: "这台设备不在最近一次发现结果里，先 GET /api/cast/devices" });
  }
  try {
    await cast(device, url, {
      title: req.body.title ?? "Claudio",
      artist: req.body.artist ?? "",
      album: req.body.album,
      artworkUrl: req.body.artworkUrl,
    });
    return { ok: true, device: device.friendlyName };
  } catch (err) {
    req.log.error(err);
    return reply.code(502).send({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post<{ Body: { location?: string } }>("/api/cast/stop", async (req, reply) => {
  const device = req.body?.location ? renderers.get(req.body.location) : undefined;
  if (!device) return reply.code(404).send({ error: "设备不在最近一次发现结果里" });
  try {
    await castStop(device);
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 只读地问设备现在在干嘛。用来确认链路通不通，不会让它出声。 */
app.get<{ Querystring: { location?: string } }>("/api/cast/state", async (req, reply) => {
  const device = req.query.location ? renderers.get(req.query.location) : undefined;
  if (!device) return reply.code(404).send({ error: "设备不在最近一次发现结果里" });
  try {
    return { state: await transportInfo(device) };
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 前端上报一首歌实际听了多久。
 *
 * 这是整个「从行为里学」的唯一入口。在此之前 plays 表在曲目**被推荐**时
 * 就写行，于是它记的是推荐历史而不是收听历史 —— 第④片会告诉模型
 * 「你听过这些」，而其中大部分你从没点开过。
 */
app.post<{
  Body: {
    session?: string;
    provider?: string;
    providerId?: string;
    title?: string;
    artist?: string;
    listenedMs?: number;
    durationMs?: number;
  };
}>("/api/played", async (req, reply) => {
  const b = req.body ?? {};
  // 曲名和艺人也是必需的：这里会插入一行新的收听记录，
  // 不再依赖「plays 表里已经有一条推荐记录」这个前提。
  if (
    !b.providerId || !b.title || !b.artist ||
    typeof b.listenedMs !== "number" || b.listenedMs < 0
  ) {
    return reply.code(400).send({
      error: "需要 providerId、title、artist 和非负的 listenedMs",
    });
  }
  const outcome = store.recordListen(
    b.session ?? "default",
    {
      provider: (b.provider ?? "itunes") as Track["provider"],
      providerId: b.providerId,
      title: b.title,
      artist: b.artist,
    },
    b.listenedMs,
    b.durationMs,
  );
  return { ok: true, outcome };
});

// ---- prefs：从行为里推导出来的偏好（阶段③）----
//
// 全是本地读写，不花钱。npm run prefs 生成第一版，之后可以逐条改 ——
// 它是给人看也给人改的，不是黑盒。

app.get("/api/prefs", async () => ({ prefs: store.allPrefs() }));

app.put<{ Params: { key: string }; Body: { value?: string } }>(
  "/api/prefs/:key",
  async (req, reply) => {
    const value = req.body?.value;
    if (typeof value !== "string" || !value.trim()) {
      return reply.code(400).send({ error: "value 必须是非空字符串" });
    }
    store.setPref(req.params.key, value.trim());
    return { ok: true, key: req.params.key };
  },
);

app.delete<{ Params: { key: string } }>("/api/prefs/:key", async (req) => {
  store.deletePref(req.params.key);
  return { ok: true };
});

/**
 * 挑一个手机真正连得上的局域网地址。
 *
 * 不能简单地取「第一个非内部 IPv4」—— 开了 TUN 模式代理的机器上，
 * 那个地址很可能是 utun 上的 198.18.0.1（Clash / Surge 的 fake-IP 段），
 * 手机连过去什么也没有，而且 npm run certs 还会去给它签证书。
 *
 * 所以按可达性排序：真实私有网段优先，其余的排后面兜底。
 */
const PRIVATE_RANGES = [
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/** 明确排除：TUN 假地址段和链路本地地址，手机都到不了 */
const UNREACHABLE = [
  /^198\.1[89]\./,   // 198.18.0.0/15 —— 基准测试段，TUN 类代理拿它做 fake-IP
  /^169\.254\./,     // 链路本地
];

/**
 * 谁占着这个端口。查不出来就返回 null —— 这只是给错误信息添一句有用的话，
 * 查不到不该让「端口被占」这件事本身报得更难看。
 */
function occupant(port: number): string | null {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pids = out.split("\n").filter(Boolean);
    return pids.length ? `\n  占着它的进程：PID ${pids.join(", ")}\n` : null;
  } catch {
    return null;   // 没有 lsof，或者没权限看
  }
}

/** 局域网地址 —— 手机连同一 WiFi 时用这个访问，省得每次手动查 IP */
function lanUrl(scheme: string, port: number): string | null {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      if (UNREACHABLE.some((re) => re.test(net.address))) continue;
      found.push(net.address);
    }
  }
  const best =
    found.find((a) => PRIVATE_RANGES.some((re) => re.test(a))) ?? found[0];
  return best ? `${scheme}://${best}:${port}` : null;
}

/**
 * 时段触发器。它只负责「到点了，换这一档」——
 * 排期要花钱，绝不由时钟触发。
 */
const ticker = new Ticker({
  rootDir: config.rootDir,
  store,
  // 只有显式打开 CLAUDIO_AUTOPLAN 才接这个钩子。
  // 不接的时候触发器碰都不会碰模型 —— 这个项目里唯一会花钱的自动路径，
  // 必须是人打开的，不能是时钟打开的。
  autoPlan:
    config.autoPlan && brainReady
      ? async (slot) => {
          console.log(`  ${slot} 这一档还空着，自动排期中…`);
          const plans = await buildPlan({
            rootDir: config.rootDir,
            brain,
            music,
            store,
            day: today(),
            onlySlot: slot,
          });
          console.log(
            plans.length
              ? `  ${slot} 排好了：${plans[0]!.tracks.length} 首`
              : `  ${slot} 排期没产出（routines.md 里找不到这个时段？）`,
          );
        }
      : undefined,
  onChange: (next, prev) => {
    const when = new Date(next.since).toLocaleTimeString("zh-CN", { hour12: false });
    console.log(
      `  ${when}  换档${prev ? ` ${prev.slot} →` : ""} ${next.slot}` +
        `　${next.hasPlan ? "节目单已就绪" : "这一档还没排期"}`,
    );
  },
});
await ticker.start();

// 启动时探一次外部依赖。失败不阻止启动 —— 所有 provider 都能降级，
// 但要让人在横幅上看见自己实际拿到的是什么。
const sourceHealth = await music.health?.().catch(() => null) ?? null;

/**
 * 端口被占是这个项目最常见的启动失败 —— 它会被反复启停，
 * 上一个实例没退干净是常态。Node 默认吐一段 EADDRINUSE 堆栈，
 * 那段东西不告诉你是谁占着，也不告诉你怎么办。
 */
try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
  console.error(`
  端口 ${config.port} 已经被占用了。

  多半是上一个 Claudio 还在跑（改代码时 --watch 偶尔会留下孤儿进程）。${
    occupant(config.port) ?? ""
  }
  两条路：
    kill 掉它            pkill -f "src/server.ts"
    或者换个端口          PORT=8081 npm run dev
`);
  process.exit(1);
}

const scheme = tls ? "https" : "http";
const lan = lanUrl(scheme, config.port);
console.log(`
  Claudio 已启动

  本机     ${scheme}://localhost:${config.port}${lan ? `
  手机     ${lan}   （连同一 WiFi）` : ""}
  安全上下文  ${tls ? "✓ https（PWA 可安装）" : "✗ http —— 跑 npm run certs 才能在手机上装 PWA"}

  大脑     ${brain.name} · ${brain.model}${brainReady ? "" : "   ⚠️  缺少 API key"}
  音源     ${music.name}（storefront=${config.itunesStorefront}）${
    sourceHealth ? `
           ${sourceHealth.ok ? "✓" : "⚠️ "} ${sourceHealth.detail}` : ""}
  能力     试听=${music.capabilities.preview ? "✓" : "✗"}  整曲=${music.capabilities.fullPlayback ? "✓" : "✗"}  资料库=${music.capabilities.userLibrary ? "✓" : "✗"}
  语料     user/*.md
`);
