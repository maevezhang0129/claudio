/** 曲名/艺人名归一化与相似度打分。resolve() 的匹配质量全靠这里。 */

/** 括号里的修饰、feat.、破折号后缀 —— 匹配时应当忽略 */
const DECORATIONS = [
  /[（(\[【][^）)\]】]*[）)\]】]/g, // (Live) （现场） [Remastered]
  /\s+-\s+(live|remaster(ed)?|single|radio edit|explicit|instrumental).*$/i,
  /\s*(feat\.?|ft\.?|featuring|与|和)\s+.+$/i,
];

/** 全角 → 半角 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

export function normalize(raw: string): string {
  let s = toHalfWidth(raw).toLowerCase();
  for (const re of DECORATIONS) s = s.replace(re, " ");
  // 去掉所有标点与空白，只留中日韩汉字、假名、字母、数字
  s = s.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9]/gu, "");
  return s;
}

/** 编辑距离 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 0..1 相似度。空串对空串算 0，避免归一化后全空的项拿满分。 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const dist = levenshtein(a, b);
  const editScore = Math.max(0, 1 - dist / Math.max(a.length, b.length));

  // 一方完整包含另一方。注意加分必须随长度比线性缩放 ——
  // 否则「Whispers Beneath the Tide」会因为包含「Tide」而被判成同一首歌，
  // 编造的曲名就能骗过幻觉过滤器（这是实测抓到过的真实回归）。
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return Math.max(editScore, 0.5 + 0.5 * ratio);
  }
  return editScore;
}
