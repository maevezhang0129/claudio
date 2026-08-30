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
  /**
   * ③ 环境注入里的天气，由调用方取好再传进来。
   *
   * 为什么不在这里直接拉：assemble 会被 npm run verify 反复调用，
   * 而 verify 的承诺是「不花钱、不依赖网络」。把取数留在 server 层，
   * 这里就永远是确定性的。
   */
  weather?: string | null;
  /** ③ 环境注入里的日程，同上，由调用方取好传进来 */
  calendar?: string | null;
  /**
   * ④ 的另一半：从行为里推导出来的偏好（prefs 表）。
   *
   * 放易变组而不是跟语料一起放稳定组 —— 它会随着 npm run prefs
   * 重新推导、也会被用户手改。混进稳定组的话，改一次偏好
   * 整个缓存前缀就作废，而它本身只有几百 token，不值这个代价。
   */
  prefs?: string[];
  /**
   * 上一轮实际给出了几首库外曲目（服务端核对的结果）。
   * 不足时会在「这一轮必须满足」里当面点出来。
   */
  lastFresh?: number;
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
    const raw = await readFile(path.join(dir, name), "utf8");
    // 模板里的 <!-- --> 是写给用户看的填写指引，不是语料。
    // 不剥掉的话，模型会读到「✗ 没用：喜欢周杰伦」这种示范，
    // 把它当成这个人的真实偏好。
    const body = stripComments(raw);
    if (body) parts.push(`### ${name}\n${body}`);
  }
  return parts.length ? parts.join("\n\n") : "（用户还没有提供品味语料）";
}

/** 剥掉 HTML 注释与由此产生的空行，返回去空白后的正文 */
function stripComments(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line, i, arr) => {
      // 折叠连续空行，避免剥完留下大片空白
      if (line.trim()) return true;
      return i > 0 && arr[i - 1]!.trim() !== "";
    })
    .join("\n")
    .trim();
}

/** ③ 环境注入：时间 + 天气 + 日程。都属于易变组。 */
function environment(now: Date, weather?: string | null, calendar?: string | null): string {
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
    // 明确区分「没开」和「开了但这次没取到」—— 模型据此决定要不要提天气。
    // 含糊其辞会让它凭空编一个天气出来。
    `天气：${weather ?? (weather === null ? "取不到" : "暂未接入")}`,
    `日程：${calendar ?? (calendar === null ? "取不到" : "暂未接入")}`,
  ].join("\n");
}

/** ④ 已检索记忆 */
function memory(recentPlays: string[]): string {
  if (!recentPlays.length) return "（还没有播放记录，这是你们的第一次对话）";
  return recentPlays.map((p) => `- ${p}`).join("\n");
}

/**
 * ④ 的另一半：数字推导出来的偏好。
 *
 * 与语料的分工是硬的 —— 语料写「只有我知道的事」，
 * 这里写「只有数字知道的事」。两边都不该去写对方那一半。
 */
function learned(prefs: string[]): string {
  if (!prefs.length) return "（还没有推导出的偏好，跑 npm run prefs 生成）";
  return prefs.map((p) => `- ${p}`).join("\n");
}

/**
 * 每轮重申一次硬性要求。
 *
 * 这几条人设里已经写了，但实测被无视：人设是一大段文字，
 * 而「至少两首库外」这种可数的约束埋在中间，小模型读不出它的分量。
 * 放在易变组末尾 —— 也就是整个 prompt 的最后 —— 命中率高得多。
 *
 * 短。这是每轮都要付全价的位置，写长了不值。
 */
function requirements(lastFresh?: number): string {
  const lines = [
    "- 给 4 到 6 首，不要少给。",
    "- 其中**至少 2 首**，艺人不能出现在上面曲库画像的任何一张榜单里。" +
      "照着他已经听了几百次的艺人推，他自己就会放，不需要电台。",
    "- 但陌生 ≠ 编造：拿不准是否真实存在的，换一首你确信存在的陌生歌。",
    "- 在 reason 里点明哪几首是库外的。",
  ];
  // 上一轮没做到就当面说破。
  // 这条比任何措辞都管用 —— 模型自己数不清「这个名字在不在那张榜上」，
  // 但你直接告诉它「你上次只给了 1 首」，它下一轮就会补上。
  if (typeof lastFresh === "number" && lastFresh < 2) {
    lines.push(
      `- ⚠️ 上一轮你只给出了 ${lastFresh} 首真正库外的（系统核对过）。` +
        "这一轮务必补足，别再拿他榜单上的艺人充数。",
    );
  }
  return lines.join("\n");
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
    environment(now, opts.weather, opts.calendar),
    "",
    "## 最近播过什么",
    "",
    memory(opts.recentPlays ?? []),
    "",
    "## 从行为里学到的",
    "",
    learned(opts.prefs ?? []),
    "",
    "## 本轮是怎么被触发的",
    "",
    trace(opts.trace ?? []),
    "",
    "## 这一轮必须满足",
    "",
    requirements(opts.lastFresh),
  ].join("\n");

  return { stable, volatile };
}
