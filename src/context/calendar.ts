/**
 * ③ 环境注入里的日程。阶段③。
 *
 * 走 AppleScript 读本机 Calendar.app，和 scripts/export-apple-music.mjs
 * 读 Music.app 是同一条路子 —— 数据本来就在这台机器上，
 * 没有任何理由为了知道「今晚有没有会」去接一个云日历 API。
 *
 * 默认关闭，需要 CLAUDIO_CALENDAR=on 显式打开。原因有两个：
 *   1. 第一次读会弹系统授权框。让它在用户没预期的时候弹出来是很糟的体验。
 *   2. Calendar.app 的 Apple Event 慢，日历多的时候要好几秒。
 *      那是每一轮对话都要付的延迟，必须是用户自己选择承担的。
 *
 * 和天气一样：取不到永远不是错误，安静降级。
 */

import { execFile } from "node:child_process";

/** 单元与记录分隔符 —— 日程标题里不可能出现的控制字符 */
const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

/**
 * 只取今天剩下的时间里还没结束的事件。
 * 已经结束的会议对「现在该听什么」没有信息量，只会稀释上下文。
 */
const SCRIPT = `
set out to ""
set nowT to current date
set endT to (current date)
set hours of endT to 23
set minutes of endT to 59
set seconds of endT to 59
tell application "Calendar"
  repeat with c in calendars
    tell c
      set evs to (every event whose end date > nowT and start date < endT)
      repeat with e in evs
        set out to out & (summary of e) & "${US}" & ((start date of e) as string) & "${RS}"
      end repeat
    end tell
  end repeat
end tell
return out
`;

/** 一次最多注入几条 —— 日程是背景，不是主体 */
const MAX_EVENTS = 4;

interface Cached {
  text: string | null;
  at: number;
}

/** 缓存 10 分钟。日程不会分钟级变化，而每次读都要付一次 Apple Event 的钱。 */
const TTL_MS = 10 * 60_000;
let cache: Cached | null = null;

export interface CalendarOptions {
  /** 没显式打开就直接返回 undefined，一个 Apple Event 都不发 */
  enabled: boolean;
  timeoutMs?: number;
}

/**
 * 返回一句给模型读的今日剩余日程，永不抛异常。
 *   undefined —— 功能没开
 *   null      —— 开了但这次没读到（超时/未授权/不是 macOS）
 *   string    —— 读到了
 */
export async function todayCalendar(
  opts: CalendarOptions,
): Promise<string | null | undefined> {
  if (!opts.enabled) return undefined;
  if (process.platform !== "darwin") return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.text;

  const text = await read(opts.timeoutMs ?? 6000);
  cache = { text, at: Date.now() };
  return text;
}

function read(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", SCRIPT],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // 未授权、超时、Calendar.app 没装 —— 都走同一条降级路径
        if (err) return resolve(null);
        resolve(format(stdout));
      },
    );
  });
}

function format(stdout: string): string | null {
  const events = stdout
    .split(RS)
    .map((rec) => rec.split(US))
    .filter((f) => f.length >= 2 && f[0]!.trim())
    .map((f) => ({ title: f[0]!.trim(), start: new Date(f[1]!.trim()) }))
    // 按开始时间排序，最近的在前 —— 模型看的是「接下来」，不是「今天有哪些」
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (!events.length) return "今天接下来没有安排";

  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const shown = events.slice(0, MAX_EVENTS).map((e) =>
    Number.isNaN(e.start.getTime()) ? e.title : `${fmt.format(e.start)} ${e.title}`,
  );
  const rest = events.length - shown.length;
  return shown.join("；") + (rest > 0 ? `；另有 ${rest} 项` : "");
}

/** 测试用：清掉缓存 */
export function resetCalendarCache(): void {
  cache = null;
}
