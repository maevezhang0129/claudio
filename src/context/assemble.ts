/**
 * 上下文组装 —— 图一第三层。
 *
 * 「每次触发，把 6 片粘成一个 prompt」。这是整个项目真正的智能所在，
 * 代码只负责把片段拼好。
 *
 * 六片按「是否每轮都变」分成两组，这个分组直接决定 prompt 缓存能不能命中：
 *
 *   稳定组（① 系统提示词 ② 用户语料）——> 放在最前面，打上缓存断点。
 *     这两片加起来通常几千 token，缓存命中后按 1/10 计费。
 *
 *   易变组（③ 环境注入 ④ 已检索记忆 ⑥ 执行轨迹）——> 放在断点之后。
 *     里面有 now()、天气、最近播放，每轮都不一样，绝不能混进稳定组，
 *     否则整个缓存前缀作废。
 *
 *   ⑤ 用户输入走 messages，不在这里。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface ContextBundle {
  /** ① + ② 拼成的稳定前缀，会被打上 cache_control */
  stable: string;
  /** ③ + ④ + ⑥ 拼成的易变尾部 */
  volatile: string;
}

export interface AssembleOptions {
  /** 项目根目录 */
  rootDir: string;
  /** ④ 已检索记忆：最近播过的曲目描述 */
  recentPlays?: string[];
  /** ⑥ 执行轨迹：调度器/webhook 触发时的来龙去脉。阶段①一般为空 */
  trace?: string[];
  /** 覆盖当前时间，便于测试 */
  now?: Date;
}

/** ① 系统提示词 */
async function systemPersona(rootDir: string): Promise<string> {
  const p = path.join(rootDir, "src", "prompts", "dj-persona.md");
  return (await readFile(p, "utf8")).trim();
}

/**
 * ② 用户语料 —— user/ 下所有 .md 和 .json。
 *
 * 这是「让 Claudio 真正属于你」的那几个文件。按文件名排序读取，
 * 顺序必须稳定，否则缓存前缀每次都不一样。
 */
async function userCorpus(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, "user");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return "（用户还没有提供品味语料）";
  }
  const files = names
    .filter((n) => n.endsWith(".md") || n.endsWith(".json"))
    // *.example.md 是给新克隆者看的空模板，不是语料。
    // 不排掉的话，模板会和用户的真实语料一起喂进 prompt。
    .filter((n) => !n.includes(".example."))
    .sort(); // 排序 = 缓存前缀稳定的前提

  const parts: string[] = [];
  for (const name of files) {
    const body = (await readFile(path.join(dir, name), "utf8")).trim();
    if (body) parts.push(`### ${name}\n${body}`);
  }
  return parts.length ? parts.join("\n\n") : "（用户还没有提供品味语料）";
}

/** ③ 环境注入。阶段①只有时间；阶段③再接天气和日历 */
function environment(now: Date): string {
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "full",
    timeStyle: "short",
  });
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  const slot =
    hour < 5 ? "深夜" : hour < 9 ? "清晨" : hour < 12 ? "上午"
    : hour < 14 ? "正午" : hour < 18 ? "下午" : hour < 22 ? "夜晚" : "深夜";

  return [
    `当前时间：${fmt.format(now)}（${slot}）`,
    `天气：暂未接入`,
    `日历：暂未接入`,
  ].join("\n");
}

/** ④ 已检索记忆 */
function memory(recentPlays: string[]): string {
  if (!recentPlays.length) return "（还没有播放记录，这是你们的第一次对话）";
  return recentPlays.map((p) => `- ${p}`).join("\n");
}

/** ⑥ 执行轨迹 */
function trace(entries: string[]): string {
  if (!entries.length) return "（本轮由用户主动发起，无调度轨迹）";
  return entries.map((e) => `- ${e}`).join("\n");
}

export async function assemble(opts: AssembleOptions): Promise<ContextBundle> {
  const now = opts.now ?? new Date();

  const [persona, corpus] = await Promise.all([
    systemPersona(opts.rootDir),
    userCorpus(opts.rootDir),
  ]);

  const stable = [
    persona,
    "",
    "---",
    "",
    "## 你要服务的这个人",
    "",
    "以下是他/她自己写下的品味语料。这是你所有判断的依据 ——",
    "推荐必须能从这里找到根据，而不是套用大众口味。",
    "",
    corpus,
  ].join("\n");

  const volatile = [
    "## 此刻的环境",
    "",
    environment(now),
    "",
    "## 最近播过什么",
    "",
    memory(opts.recentPlays ?? []),
    "",
    "## 本轮是怎么被触发的",
    "",
    trace(opts.trace ?? []),
  ].join("\n");

  return { stable, volatile };
}
