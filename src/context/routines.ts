/**
 * 当前场景判定 —— 时钟签名元素的数据来源。
 *
 * 优先从 user/routines.md 里解析用户自己写的时间表，
 * 所以 07:30 显示的是「通勤」而不是「清晨」—— 那是用户自己的词。
 * 语料里没写或解析不到时，退回通用时段名。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Slot {
  /** 显示在时钟下方的场景名 */
  name: string;
  /** 来自用户语料还是内置兜底 */
  source: "routines.md" | "fallback";
  /** 命中的时间段，仅当 source 为 routines.md 时有值 */
  range?: string;
}

interface ParsedRange {
  fromMin: number;
  toMin: number;
  name: string;
  label: string;
}

/** 匹配 `07:00–09:00 通勤：…` / `- 23:00 之后：…` 这类行 */
const RANGE_RE = /(\d{1,2})[:：](\d{2})\s*[–\-—~至到]\s*(\d{1,2})[:：](\d{2})/;

/** 名字取时间段之后、第一个标点或空白之前的那一小段 */
function extractName(rest: string): string {
  const cleaned = rest.replace(/^[\s，,：:·・\-–—]+/, "");
  const m = cleaned.match(/^[^\s，,。：:；;（(\-–—]{1,10}/);
  return m ? m[0].trim() : "";
}

function toMinutes(h: string, m: string): number {
  return Number(h) * 60 + Number(m);
}

export function parseRoutines(markdown: string): ParsedRange[] {
  const out: ParsedRange[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    // 只看列表项，跳过注释和标题
    if (!line.startsWith("-")) continue;
    if (line.startsWith("<!--")) continue;

    const m = line.match(RANGE_RE);
    if (!m) continue;

    const name = extractName(line.slice(m.index! + m[0].length));
    if (!name) continue; // 只有时间没有名字（空模板）→ 跳过

    out.push({
      fromMin: toMinutes(m[1]!, m[2]!),
      toMin: toMinutes(m[3]!, m[4]!),
      name,
      label: m[0],
    });
  }
  return out;
}

/** 内置兜底时段 */
export function fallbackSlot(hour: number): string {
  return hour < 5 ? "深夜"
    : hour < 9 ? "清晨"
    : hour < 12 ? "上午"
    : hour < 14 ? "正午"
    : hour < 18 ? "下午"
    : hour < 22 ? "夜晚"
    : "深夜";
}

/** 取用户所在时区的「当日已过分钟数」和小时 */
export function localParts(now: Date, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // hour12:false 在部分环境下会把午夜给成 24
  const hour = get("hour") % 24;
  const minute = get("minute");
  return { hour, minute, minutes: hour * 60 + minute };
}

export async function currentSlot(rootDir: string, now = new Date()): Promise<Slot> {
  const { hour, minutes } = localParts(now);

  let ranges: ParsedRange[] = [];
  try {
    const md = await readFile(path.join(rootDir, "user", "routines.md"), "utf8");
    ranges = parseRoutines(md);
  } catch {
    // 语料不存在，走兜底
  }

  for (const r of ranges) {
    // 跨午夜的段（23:00–02:00）判定要拆成两截
    const hit = r.fromMin <= r.toMin
      ? minutes >= r.fromMin && minutes < r.toMin
      : minutes >= r.fromMin || minutes < r.toMin;
    if (hit) return { name: r.name, source: "routines.md", range: r.label };
  }

  return { name: fallbackSlot(hour), source: "fallback" };
}
