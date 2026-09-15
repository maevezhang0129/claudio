/**
 * 资料页要展示的三样东西 —— 设计稿（design/mockup.html）里有，实现里一直缺。
 *
 *   听什么        ← taste.md 的「长期偏好」
 *   不听什么      ← taste.md 的「明确不听」
 *   会反复回去听的 ← library.md 的循环榜
 *
 * 前两样只有本人写得出来，第三样是算出来的。这个分工不是偶然：
 * 它正是 CLAUDE.md 里那条「prefs 和语料不重叠」的具体样子 ——
 * 算术能给出「你循环了 77 次 Soft Spot」，给不出「为什么」和「什么时候别放」。
 *
 * 所以空着的时候**不编**。返回 null，界面上如实写「这一栏只有你能写」，
 * 把空白变成一个入口而不是一处缺失。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ProfileCorpus {
  /** 长期偏好正文；没写就是 null */
  likes: string | null;
  /** 明确不听正文；没写就是 null */
  dislikes: string | null;
  /** 循环最多的曲目 */
  anchors: Array<{ title: string; artist: string; plays: number }>;
}

/**
 * 剥掉 HTML 注释。
 *
 * 与 assemble.ts 里喂给模型的那一份同一个道理：模板里的 `<!-- 待填 -->`
 * 是写给人看的填写指引，不是内容。不剥的话，一个「还没填」的小节
 * 会在界面上显示成一段指引文字，看起来像是已经写过了。
 */
function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** 取出 `## 标题` 到下一个同级标题之间的正文 */
function section(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = stripComments((end < 0 ? rest : rest.slice(0, end)).join("\n"));
  return body || null;
}

/** `- Soft Spot — keshi（77 次）` */
const ANCHOR_LINE = /^-\s+(.+?)\s+—\s+(.+?)（(\d+)\s*次）/;

export async function profileCorpus(
  rootDir: string,
  anchorLimit = 8,
): Promise<ProfileCorpus> {
  const read = async (name: string) => {
    try {
      return await readFile(path.join(rootDir, "user", name), "utf8");
    } catch {
      return "";   // 语料还没建，等同于什么都没写
    }
  };

  const taste = await read("taste.md");
  const library = await read("library.md");

  const anchors: ProfileCorpus["anchors"] = [];
  const loopStart = library.indexOf("## 循环最多的曲目");
  if (loopStart >= 0) {
    for (const raw of library.slice(loopStart).split("\n").slice(1)) {
      if (raw.startsWith("## ")) break;   // 到下一节就停
      const m = ANCHOR_LINE.exec(raw.trim());
      if (!m) continue;
      anchors.push({ title: m[1]!, artist: m[2]!, plays: Number(m[3]) });
      if (anchors.length >= anchorLimit) break;
    }
  }

  return {
    likes: section(taste, "长期偏好"),
    dislikes: section(taste, "明确不听"),
    anchors,
  };
}
