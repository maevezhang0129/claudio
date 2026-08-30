/**
 * 调度器 —— 阶段③。
 *
 * 阶段①的电台是被动的：你不问，它就不说话。调度器把它变成一个真的电台 ——
 * 每天按 user/routines.md 里你自己写的时间表，为每一档预排一组歌。
 *
 * 这里也是 ⑥「执行轨迹」那一片第一次真正有内容的地方。
 * 从阶段①起它就一直是「（本轮由用户主动发起，无调度轨迹）」；
 * 由调度器触发的这一轮，模型能读到自己是被时间表叫醒的、为哪一档排的，
 * 于是它写出来的口播会是「快到你说的那个通勤时段了」，
 * 而不是凭空开始介绍歌。
 *
 * 成本：一档一次模型调用。glm-4.5-air 一轮约 $0.00055，
 * 四档一天不到一分钱 —— 但这仍然是真金白银，所以排期只在显式触发时发生，
 * 绝不会因为有人打开了页面就自动跑一遍。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { assemble } from "../context/assemble.ts";
import { parseRoutines } from "../context/routines.ts";
import type { BrainAdapter } from "../brain/types.ts";
import type { MusicProvider, ResolveResult, Track } from "../music/types.ts";
import type { Store } from "../state/store.ts";

/** 一档里排几首。比对话推荐略多 —— 一个时段撑得住更长的编排。 */
const TRACKS_PER_SLOT = 5;

/** 每档保留几首 alternate。与 server.ts 的对话路径保持同一个尺度。 */
const MAX_ALTERNATES = 1;

export interface PlannedTrack extends Track {
  confidence: "exact" | "alternate";
  note?: string;
}

export interface SlotPlan {
  /** 场景名，取自 routines.md，比如「通勤」 */
  slot: string;
  /** 命中的时间段字面量，比如「07:00–09:00」 */
  range: string;
  say: string;
  reason: string;
  segue: string;
  tracks: PlannedTrack[];
  dropped: number;
}

export interface PlanOptions {
  rootDir: string;
  brain: BrainAdapter;
  music: MusicProvider;
  store: Store;
  /** 本地日期 YYYY-MM-DD */
  day: string;
  /** 只排这一档；不给就排满一天 */
  onlySlot?: string;
}

/** 用户所在时区的今天，YYYY-MM-DD */
export function today(now = new Date(), timeZone = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * 为一天排期。逐档串行 —— 不是为了省事，是因为后一档要看得见前一档排了什么，
 * 否则一天四档很可能各自推荐同一批歌。
 */
export async function buildPlan(opts: PlanOptions): Promise<SlotPlan[]> {
  const ranges = await readRanges(opts.rootDir);
  if (!ranges.length) return [];

  const targets = opts.onlySlot
    ? ranges.filter((r) => r.name === opts.onlySlot)
    : ranges;

  const plans: SlotPlan[] = [];
  /** 本次排期里已经用掉的歌，喂给下一档避免全天重复 */
  const alreadyPlanned: string[] = [];

  for (const r of targets) {
    const plan = await planOneSlot(opts, r.name, r.label, alreadyPlanned);
    if (!plan) continue;
    plans.push(plan);
    for (const t of plan.tracks) alreadyPlanned.push(`${t.artist} - ${t.title}`);
    opts.store.savePlan(opts.day, plan.slot, plan);
  }

  opts.store.prunePlans();
  return plans;
}

async function readRanges(rootDir: string) {
  try {
    const md = await readFile(path.join(rootDir, "user", "routines.md"), "utf8");
    return parseRoutines(md);
  } catch {
    return []; // 没写 routines.md 就没有可排的档，不是错误
  }
}

async function planOneSlot(
  opts: PlanOptions,
  slot: string,
  range: string,
  alreadyPlanned: string[],
): Promise<SlotPlan | null> {
  // ⑥ 执行轨迹：告诉模型这一轮不是人问出来的
  const trace = [
    `调度器触发：为「${slot}」（${range}）预排今天的节目`,
    alreadyPlanned.length
      ? `今天其他档已经排了：${alreadyPlanned.join("、")}。别重复。`
      : "这是今天的第一档。",
  ];

  const context = await assemble({
    rootDir: opts.rootDir,
    recentPlays: opts.store.recentPlaysAsContext(15),
    trace,
  });

  const input =
    `为「${slot}」这一档排 ${TRACKS_PER_SLOT} 首。` +
    `这是提前排的节目单，不是现在就要播 —— ` +
    `口播里别说「现在」，说这一档到了的时候你要说的话。`;

  let result;
  try {
    result = await opts.brain.think({ context, history: [], input });
  } catch {
    return null; // 某一档失败不该带垮整天的排期
  }

  const dj = result.response;
  const settled = await Promise.all(
    dj.play.map((q) => opts.music.resolve(q).catch(() => null)),
  );

  // 与对话路径同样的处理：幻觉丢弃，alternate 降级到末尾并限量
  const exact: PlannedTrack[] = [];
  const alternates: PlannedTrack[] = [];
  let dropped = 0;
  for (const r of settled) {
    if (!r) { dropped++; continue; }
    // 与对话路径同一条规矩：放不出声的不进队列。
    // 节目单更要守这条 —— 到点自动开播时没人守在旁边点「跳过」。
    if (!r.track.previewUrl && !r.track.fullPlayback) { dropped++; continue; }
    (r.confidence === "exact" ? exact : alternates).push(flatten(r));
  }

  return {
    slot,
    range,
    say: dj.say,
    reason: dj.reason,
    segue: dj.segue,
    tracks: [...exact, ...alternates.slice(0, MAX_ALTERNATES)],
    dropped,
  };
}

function flatten(r: ResolveResult): PlannedTrack {
  return { ...r.track, confidence: r.confidence, note: r.note };
}
