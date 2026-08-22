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
import { createBrain } from "./brain/index.ts";
import { createMusicProvider } from "./music/index.ts";
import type { ResolveResult, Track } from "./music/types.ts";
import { Store } from "./state/store.ts";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";

const app = Fastify({ logger: { level: "warn" } });

const store = new Store(config.dbPath);
const music = createMusicProvider({
  name: config.musicProvider,
  itunesStorefront: config.itunesStorefront,
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

    // 六片上下文：③环境 ④记忆 由这里注入，①②从文件读，⑤是 message，⑥阶段①为空
    const context = await assemble({
      rootDir: config.rootDir,
      recentPlays: store.recentPlaysAsContext(15),
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
    for (const r of settled) {
      if (!r) { dropped++; continue; }
      (r.confidence === "exact" ? exact : alternates).push(toResolvedTrack(r));
    }
    const keptAlternates = alternates.slice(0, MAX_ALTERNATES);
    /** 超出上限被裁掉的 alternate 数量 —— 与 dropped（幻觉）性质不同，分开报 */
    const trimmed = alternates.length - keptAlternates.length;
    const tracks = [...exact, ...keptAlternates];

    const turn = {
      say: dj.say,
      reason: dj.reason,
      segue: dj.segue,
      tracks,
      /** 模型编了几首、被曲库拦下来了 —— 用于观察模型质量 */
      dropped,
      /** 有几首 alternate 因为超出上限被裁掉 */
      trimmed,
      usage: result.usage,
      model: result.model,
    };

    // 落库。assistant 那条带上整轮 payload，刷新后曲目卡片才能原样恢复。
    store.appendMessage(session, "user", message);
    store.appendMessage(session, "assistant", dj.say, turn);
    for (const t of tracks) store.recordPlay(session, t);

    return turn;
  },
);

/** 刷新后恢复整屏 —— 曲目、理由、过渡语都在 payload 里 */
app.get<{ Querystring: { session?: string } }>("/api/history", async (req) => {
  const session = req.query.session ?? "default";
  return { turns: store.historyWithPayload(session, 40) };
});

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
  return { epoch: now.getTime(), slot };
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

function toResolvedTrack(r: ResolveResult): ResolvedTrack {
  return { ...r.track, confidence: r.confidence, note: r.note };
}

// ---- 阶段③ 的占位路由，先把 HTTP 契约固定下来 ----
app.get("/api/plan/today", async () => ({
  plan: [],
  note: "调度器属于阶段③，尚未实现",
}));

/** 局域网地址 —— 手机连同一 WiFi 时用这个访问，省得每次手动查 IP */
function lanUrl(port: number): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return null;
}

await app.listen({ port: config.port, host: "0.0.0.0" });
const lan = lanUrl(config.port);
console.log(`
  Claudio 已启动

  本机     http://localhost:${config.port}${lan ? `
  手机     ${lan}   （连同一 WiFi）` : ""}

  大脑     ${brain.name} · ${brain.model}${brainReady ? "" : "   ⚠️  缺少 API key"}
  音源     ${music.name}（storefront=${config.itunesStorefront}）
  能力     试听=${music.capabilities.preview ? "✓" : "✗"}  整曲=${music.capabilities.fullPlayback ? "✓" : "✗"}  资料库=${music.capabilities.userLibrary ? "✓" : "✗"}
  语料     user/*.md
`);
