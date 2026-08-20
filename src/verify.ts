/**
 * 端到端管线验证（不花钱）。
 *
 * 用一个桩大脑代替真实模型，把 /api/chat 除「调 Anthropic」之外的
 * 全部环节跑一遍：六片上下文组装 -> 曲目解析 -> 幻觉过滤 -> 落库 -> 记忆回灌。
 *
 * 跑法：npm run verify
 */

import { rmSync } from "node:fs";
import path from "node:path";
import { assemble } from "./context/assemble.ts";
import { createMusicProvider } from "./music/index.ts";
import { Store } from "./state/store.ts";
import type { BrainAdapter, BrainRequest, BrainResult } from "./brain/types.ts";
import { config } from "./config.ts";
import { normalize, similarity } from "./music/normalize.ts";
import type { Track } from "./music/types.ts";

const TMP_DB = path.join(config.rootDir, "data", "_test.db");
rmSync(TMP_DB, { force: true });
rmSync(TMP_DB + "-wal", { force: true });
rmSync(TMP_DB + "-shm", { force: true });

/** 桩大脑：故意混入 2 首编造的歌，验证幻觉过滤真的生效 */
class StubBrain implements BrainAdapter {
  readonly name = "stub";
  readonly model = "stub-model";
  lastRequest: BrainRequest | null = null;

  async think(req: BrainRequest): Promise<BrainResult> {
    this.lastRequest = req;
    return {
      model: this.model,
      usage: {
        inputTokens: 1200, outputTokens: 300,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedUsd: 0.0027,
      },
      response: {
        say: "夜里这个点，给你四首。",
        reason: "从 taste.md 里那句「有真实鼓手的东西」出发挑的。",
        segue: "下次聊聊他们的现场。",
        play: [
          { title: "富士山下", artist: "陈奕迅" },
          { title: "海阔天空", artist: "Beyond" },
          { title: "起风了", artist: "买辣椒也用券" },       // 跨平台艺名不一致
          { title: "永夜的第七章序曲", artist: "陈奕迅" },   // 编的
          { title: "Whispers Beneath the Tide", artist: "Beyond" }, // 编的
        ],
      },
    };
  }
}

const store = new Store(TMP_DB);
const music = createMusicProvider({ name: "itunes", itunesStorefront: "CN" });
const brain = new StubBrain();

// ---- 第 1 轮 ----
console.log("── 第 1 轮 ──");
const ctx1 = await assemble({
  rootDir: config.rootDir,
  recentPlays: store.recentPlaysAsContext(15),
});
console.log(`上下文  稳定组 ${ctx1.stable.length} 字符 / 易变组 ${ctx1.volatile.length} 字符`);
console.log(`记忆片  ${ctx1.volatile.includes("第一次对话") ? "空（首轮，符合预期）" : "非空"}`);

const r1 = await brain.think({ context: ctx1, history: [], input: "随便" });
console.log(`大脑    返回 ${r1.response.play.length} 首待解析`);

const resolved1 = await Promise.all(r1.response.play.map((q) => music.resolve(q)));
const tracks1 = [];
let dropped1 = 0;
for (const [i, r] of resolved1.entries()) {
  const q = r1.response.play[i]!;
  if (!r) { dropped1++; console.log(`  ❌ ${q.artist} - ${q.title}  [丢弃]`); continue; }
  tracks1.push(r.track);
  const tag = r.confidence === "exact" ? "✅" : "⚠️ ";
  console.log(`  ${tag} ${r.track.artist} - ${r.track.title}` + (r.note ? `  (${r.note})` : ""));
}
console.log(`解析    保留 ${tracks1.length} 首 / 丢弃 ${dropped1} 首`);

// ---- 折中策略：alternate 降级到末尾 + 限量 ----
// 与 server.ts 里的 MAX_ALTERNATES 保持一致
const MAX_ALTERNATES = 1;
const exactOnly: Track[] = [];
const altOnly: Track[] = [];
for (const r of resolved1) {
  if (!r) continue;
  (r.confidence === "exact" ? exactOnly : altOnly).push(r.track);
}
const keptAlt = altOnly.slice(0, MAX_ALTERNATES);
const trimmed = altOnly.length - keptAlt.length;
const ordered = [...exactOnly, ...keptAlt];
console.log(`排序    exact ${exactOnly.length} 首在前，alternate 保留 ${keptAlt.length} 首在后，裁掉 ${trimmed} 首`);
console.log(`        ${ordered.map((t) => t.title).join(" → ")}`);

store.appendMessage("t", "user", "随便");
store.appendMessage("t", "assistant", r1.response.say);
for (const t of tracks1) store.recordPlay("t", t);

// ---- 第 2 轮：验证记忆和历史真的回灌了 ----
console.log("\n── 第 2 轮 ──");
const ctx2 = await assemble({
  rootDir: config.rootDir,
  recentPlays: store.recentPlaysAsContext(15),
});
const history = store.recentMessages("t", 20);
console.log(`历史    ${history.length} 条：${history.map((h) => h.role).join(" → ")}`);
console.log("记忆片注入的内容：");
for (const line of store.recentPlaysAsContext(15)) console.log(`  - ${line}`);

// ---- 相似度回归 ----
// 阈值调整最容易引入的回归是「编造的曲名因为包含某个真实词而被放行」，
// 这几条把边界钉死。
console.log("\n── 相似度回归 ──");
const SIM_THRESHOLD = 0.72;
const simCases: Array<[string, string, boolean]> = [
  ["晴天", "晴天", true],
  ["晴天", "晴天 (Live)", true],
  ["Bohemian Rhapsody", "Bohemian Rhapsody - Remastered 2011", true],
  ["告白气球", "告白氣球", true],                     // 繁简
  ["七里香", "七里香 (电视剧主题曲)", true],
  ["Whispers Beneath the Tide", "Tide", false],       // 曾漏过的幻觉
  ["永夜的第七章序曲", "第七章", false],
  ["夜曲", "以父之名", false],
];
let simFailed = 0;
for (const [a, b, want] of simCases) {
  const score = similarity(normalize(a), normalize(b));
  const got = score >= SIM_THRESHOLD;
  const ok = got === want;
  if (!ok) simFailed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${score.toFixed(3)} ${got ? "通过" : "拒绝"}  ${a} <-> ${b}`);
}

// ---- 断言 ----
console.log("\n── 断言 ──");
const checks: [string, boolean][] = [
  ["两首编造的歌被丢弃", dropped1 === 2],
  ["三首真实的歌被保留", tracks1.length === 3],
  ["首轮记忆片为空", ctx1.volatile.includes("第一次对话")],
  ["第二轮记忆片含播放记录", ctx2.volatile.includes("富士山下")],
  ["历史回灌为 user→assistant", history.length === 2 && history[0]!.role === "user"],
  ["稳定组含用户语料", ctx1.stable.includes("taste.md")],
  ["稳定组不含时间戳（缓存前缀稳定）", !ctx1.stable.includes("当前时间")],
  ["易变组含时间戳", ctx2.volatile.includes("当前时间")],
  ["alternate 不超过上限", keptAlt.length <= MAX_ALTERNATES],
  ["exact 全部排在 alternate 之前",
    ordered.findIndex((t) => altOnly.includes(t)) === -1 ||
    ordered.findIndex((t) => altOnly.includes(t)) >= exactOnly.length],
  ["exact 保持模型原始顺序",
    exactOnly[0]?.title === "富士山下" && exactOnly[1]?.title === "海阔天空"],
];
let failed = simFailed;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
}

store.close();
rmSync(TMP_DB, { force: true });
rmSync(TMP_DB + "-wal", { force: true });
rmSync(TMP_DB + "-shm", { force: true });

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
