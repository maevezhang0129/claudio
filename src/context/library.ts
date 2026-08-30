/**
 * 从 library.md 里认出「他已经很熟的艺人」。
 *
 * 用途只有一个：数清楚一轮推荐里有几首真的来自曲库之外。
 *
 * 为什么要在服务端数：实测模型说不清。它会一边写着
 * 「Taylor Swift 是库外推荐」，一边推着一个他播过 186 次的艺人 ——
 * 因为判断「这个名字在不在上面那张榜里」需要逐条比对，
 * 而小模型在长上下文里做不好这件事。它不是在撒谎，是真的不知道。
 *
 * 所以约束由提示词提出，由代码核对。核对结果再回灌给下一轮，
 * 形成一个不花额外钱的闭环。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalize } from "../music/normalize.ts";

/** `- **TREASURE** —— 播放 540 次 / 库里 56 首` 里的那个名字 */
const ARTIST_LINE = /^-\s+\*\*(.+?)\*\*\s*——/;

/** 歌单那一节是 `- **Favourite Songs**（382 首）`，不是艺人，得排掉 */
const NOT_ARTIST = /（\d+\s*首）/;

let cache: { at: number; names: Set<string> } | null = null;
/** 语料改动不频繁，但也不该只读一次 —— 用户改完得能生效 */
const TTL_MS = 60_000;

/**
 * 曲库画像里出现过的艺人名（归一化后）。
 *
 * 归一化用的是曲库匹配那一套：模型写「宇多田光」而 library.md 里是
 * 「Utada」时两者对不上，这是已知的漏网，宁可漏判成「库外」——
 * 把熟悉的错当成陌生，代价只是这轮少一首新歌；反过来
 * 把陌生的错当成熟悉，会让这条约束彻底失效。
 */
export async function familiarArtists(rootDir: string): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.names;

  const names = new Set<string>();
  try {
    const md = await readFile(path.join(rootDir, "user", "library.md"), "utf8");
    for (const raw of md.split("\n")) {
      const m = ARTIST_LINE.exec(raw.trim());
      if (!m || NOT_ARTIST.test(raw)) continue;
      const n = normalize(m[1]!);
      if (n) names.add(n);
    }
  } catch {
    // 没有 library.md 就没有「熟悉」这个概念，一切都算库外
  }
  cache = { at: Date.now(), names };
  return names;
}

/** 这一批曲目里，有几首的艺人是曲库画像里没有的 */
export function countFresh(
  tracks: Array<{ artist: string }>,
  familiar: Set<string>,
): number {
  return tracks.filter((t) => {
    const n = normalize(t.artist);
    // 合唱写成「A / B」时，只要有一位是熟面孔就不算新
    const parts = t.artist.split(/[/&,、]/).map((p) => normalize(p.trim()));
    return n && !familiar.has(n) && !parts.some((p) => p && familiar.has(p));
  }).length;
}

/** 测试用 */
export function resetLibraryCache(): void {
  cache = null;
}
