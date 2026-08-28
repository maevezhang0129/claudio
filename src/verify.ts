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
import { lengthRatio, normalize, similarity } from "./music/normalize.ts";
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
  // 用固定值而不是真去拉 —— verify 的承诺是不花钱、不依赖网络
  weather: "雷阵雨，24°C",
  calendar: "20:00 排练",
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

// ---- 归一化不能吃掉正文 ----
// normalize 会剥掉 (Live)、feat. 这类修饰。剥过头比不剥更危险 ——
// 曾经 /\s*(feat|ft)\s+/ 里的 \s* 让「Soft Spot」里的 ft 被当成合唱标记，
// 整首歌被截成「So」，于是它和任何以 so 开头的歌都完全相同。
// 那是这个库里播放次数第二高的曲目。
console.log("\n── 归一化边界 ──");
const normCases: Array<[string, string]> = [
  ["Soft Spot", "softspot"],                    // ft 在词中间，不是合唱标记
  ["Drift Away", "driftaway"],
  ["Left Behind", "leftbehind"],
  ["我和我的祖国", "我和我的祖国"],               // 「和」是常用字，后面没空白就不是分隔符
  ["Song feat. Someone", "song"],               // 这个才是真的合唱标记
  ["Skrr (feat. GISELLE)", "skrr"],
  ["晴天 (Live)", "晴天"],
  ["Bohemian Rhapsody - Remastered 2011", "bohemianrhapsody"],
];
let normFailed = 0;
for (const [input, want] of normCases) {
  const got = normalize(input);
  const ok = got === want;
  if (!ok) normFailed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(input)} -> ${JSON.stringify(got)}` +
    (ok ? "" : `  期望 ${JSON.stringify(want)}`));
}

// ---- 曲名长度比闸门 ----
// 相似度阈值单独守不住包含式匹配：编造的曲名只要「套」着一个真实曲名，
// 就能拿到 0.72 以上。两趟匹配都要再过一道长度比。
// 一开始只装在 alternate 那条路上，实测发现模型编的往往是
// **真艺人 + 加了料的曲名** —— 那种情况艺人对得上，从第一趟就走过去了。
console.log("\n── 曲名长度比闸门 ──");
const ALT_FLOOR = 0.8;
const altCases: Array<[string, string, boolean]> = [
  ["起风了", "起风了", true],                          // 跨平台艺名不一致的真实场景
  ["告白气球", "告白氣球", true],                       // 繁简，长度相等
  ["晴天", "晴天 (Live)", true],                        // 修饰词会被 normalize 剥掉
  ["七里香", "七里香 (电视剧主题曲)", true],
  ["永夜的第七章序曲", "夜的第七章", false],             // 套着真实曲名的幻觉
  ["夜的第七章前奏曲", "夜的第七章", false],
  ["Soft Spot in the Rain", "Soft Spot", false],       // 真艺人 + 加了料的曲名
  ["宇宙漫游第二章", "宇宙漫游", false],
];
let altFailed = 0;
for (const [a, b, want] of altCases) {
  const na = normalize(a), nb = normalize(b);
  const ratio = lengthRatio(na, nb);
  const got = similarity(na, nb) >= SIM_THRESHOLD && ratio >= ALT_FLOOR;
  const ok = got === want;
  if (!ok) altFailed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  比值 ${ratio.toFixed(3)} ${got ? "通过" : "拒绝"}  ${a} <-> ${b}`);
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
  // 天气每 15 分钟就变一次。混进稳定组的话，缓存前缀一天作废近百次，
  // 代价远超「今天下雨」这四个字的价值。
  ["天气进易变组", ctx2.volatile.includes("雷阵雨")],
  ["天气不进稳定组（缓存前缀稳定）", !ctx2.stable.includes("雷阵雨")],
  ["日程进易变组", ctx2.volatile.includes("排练")],
  ["日程不进稳定组（缓存前缀稳定）", !ctx2.stable.includes("排练")],
  // 「没接入」和「接了但这次没取到」必须能区分 ——
  // 含糊其辞会让模型自己编一个天气出来。
  ["未接入时如实说明", ctx1.volatile.includes("天气：暂未接入")],
  ["alternate 不超过上限", keptAlt.length <= MAX_ALTERNATES],
  ["exact 全部排在 alternate 之前",
    ordered.findIndex((t) => altOnly.includes(t)) === -1 ||
    ordered.findIndex((t) => altOnly.includes(t)) >= exactOnly.length],
  // 断言「顺序」而不是「曲名字符串」。
  // 硬编码 title 会因为曲库变动而假失败 —— Apple Music 的
  //「海阔天空」首位结果一度变成《海阔天空 (大马版28/05/93) [Live]》，
  // 匹配逻辑正确判定为 exact，但返回的 title 带上了现场版修饰。
  ["exact 保持模型原始顺序", (() => {
    const wanted = r1.response.play
      .map((q) => normalize(q.title))
      .filter((t) => exactOnly.some((e) => normalize(e.title) === t));
    const got = exactOnly.map((e) => normalize(e.title));
    return wanted.length === got.length && wanted.every((t, i) => t === got[i]);
  })()],
  // 模板里的 <!-- --> 是写给用户看的填写指引。漏进 prompt 的话，
  // 模型会把「✗ 没用：喜欢周杰伦」这种示范当成用户的真实偏好。
  ["语料剥离了模板指引注释",
    !ctx1.stable.includes("写作原则") && !ctx1.stable.includes("✗ 没用")],
  ["语料排除了 .example.md 模板",
    !ctx1.stable.includes(".example.md")],
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

failed += altFailed + normFailed;
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
