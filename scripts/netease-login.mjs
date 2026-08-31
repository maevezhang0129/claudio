/**
 * 登录网易云，把 cookie 写进 .env。
 *
 * 为什么要有这个脚本：另一条路是「打开开发者工具 → Application →
 * Cookies → 复制 MUSIC_U」。那串东西 300 多字符、复制时容易漏字符，
 * 而且在 Mac 上连打开开发者工具都得先知道 F12 是音量键。
 *
 * 两种方式：
 *   手机验证码（默认）—— 不需要装任何 App，全程在终端里完成
 *   扫码           —— 需要**网易云音乐 App** 的扫一扫
 *
 * 扫码那条路有个坑，实测踩过：二维码里是一个网址，
 * 用相机或浏览器扫会把你带到网页去登录 —— 那是网页登录，
 * 完成不了「客户端扫码确认」那个握手，终端会一直停在「等待扫码」，
 * 而手机上看起来一切正常。所以默认走验证码。
 *
 * 二维码图片是一次性的：只在本进程轮询期间有意义。启动时清掉旧的，
 * 退出时删掉自己这张 —— 留在磁盘上的废码看起来和活码一模一样。
 *
 * cookie 是凭据：只写进 .env（已 gitignore），终端上只打印掩码。
 *
 * 跑法：
 *   npm run netease:api             # 另一个窗口，先起服务
 *   npm run netease:login           # 这个脚本，会问你用哪种方式
 *   npm run netease:login -- --qr   # 直接走扫码
 */

import { writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(ROOT, ".env");
const BASE = process.env.CLAUDIO_NETEASE_BASE_URL ?? "http://localhost:3000";
const KEY = "CLAUDIO_NETEASE_COOKIE";
const QR_PREFIX = "claudio-netease-qr-";

/** 轮询间隔。网易云那边的二维码有效期约 3 分钟 */
const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60_000;

async function api(route, params = {}) {
  const url = new URL(BASE + route);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // 这套服务对同一 IP 的请求缓存两分钟，加时间戳绕开陈旧结果
  url.searchParams.set("timestamp", String(Date.now()));
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${route} 返回 ${res.status}`);
  return res.json();
}

/** 只留 MUSIC_U 那一段 —— 其余字段没用，而且越长越容易在复制粘贴里出错 */
export function extractMusicU(raw) {
  const m = /MUSIC_U=([^;,\s]+)/.exec(raw ?? "");
  return m ? `MUSIC_U=${m[1]}` : null;
}

/**
 * 合并进 .env 的文本：已有那个键就替换那一行，没有就追加。
 * 其余内容一个字都不动 —— 这个文件里还有模型的 API key。
 */
export function mergeEnv(text, cookie) {
  const line = `${KEY}=${cookie}`;
  const re = new RegExp(`^${KEY}=.*$`, "m");
  return re.test(text)
    ? text.replace(re, line)
    : (text.endsWith("\n") || text === "" ? text : text + "\n") + line + "\n";
}

async function saveToEnv(cookie) {
  let text = "";
  try {
    text = await readFile(ENV, "utf8");
  } catch {
    // 还没有 .env，等下会新建
  }
  await writeFile(ENV, mergeEnv(text, cookie), "utf8");
}

function mask(cookie) {
  const v = cookie.slice("MUSIC_U=".length);
  return `MUSIC_U=${v.slice(0, 6)}…${v.slice(-4)}（共 ${v.length} 字符）`;
}

async function succeed(rawCookie) {
  const cookie = extractMusicU(rawCookie);
  if (!cookie) {
    console.error("\n  登录成功了，但返回里没有 MUSIC_U。请改用手动方式。\n");
    return false;
  }
  await saveToEnv(cookie);
  console.log(`
  ✅ 登录成功，已写入 .env
     ${KEY}=${mask(cookie)}

  接下来重启服务：npm run dev
  启动横幅应该变成：
     能力     试听=✓  整曲=✓
     音源     ✓ 网易云 已连接（带 cookie，可整曲）

  队列里的时长会从清一色的 0:30 变成真实歌曲长度 —— 那是最直观的判据。
  （VIP 曲目仍然要 VIP，所以不会 100% 都变成整曲。）
`);
  return true;
}

// ── 手机验证码 ────────────────────────────────────────

async function loginBySms(rl) {
  const phone = (await rl.question("\n  手机号：")).trim();
  if (!/^\d{6,}$/.test(phone)) {
    console.error("\n  这不像一个手机号。\n");
    return false;
  }

  const sent = await api("/captcha/sent", { phone });
  if (sent.code !== 200) {
    console.error(`\n  验证码没发出去：${sent.message ?? JSON.stringify(sent)}\n`);
    return false;
  }
  console.log("  验证码已发送。");

  const captcha = (await rl.question("  收到的验证码：")).trim();
  const res = await api("/login/cellphone", { phone, captcha });
  if (res.code !== 200) {
    // 把服务端原话带出来 —— 验证码错、过期、被风控，处理方式各不相同
    console.error(`\n  登录失败（code=${res.code}）：${res.message ?? res.msg ?? ""}\n`);
    return false;
  }
  return succeed(res.cookie);
}

// ── 扫码 ──────────────────────────────────────────────

/** 清掉上一次留下的二维码 —— 它们已经失效，留着只会被误扫 */
async function sweepOldQr() {
  try {
    for (const f of await readdir(tmpdir())) {
      if (f.startsWith(QR_PREFIX)) await unlink(path.join(tmpdir(), f)).catch(() => {});
    }
  } catch {
    // 清不掉不影响主流程
  }
}

async function loginByQr() {
  await sweepOldQr();
  const { data: { unikey } } = await api("/login/qr/key");
  const { data: { qrimg, qrurl } } = await api("/login/qr/create", {
    key: unikey,
    qrimg: true,
  });

  const png = path.join(tmpdir(), `${QR_PREFIX}${Date.now()}.png`);
  await writeFile(png, Buffer.from(qrimg.split(",")[1], "base64"));
  if (process.platform === "darwin") execFile("open", [png], () => {});

  // 正常退出、Ctrl-C、被 kill —— 三条路都要删。漏掉任何一条，
  // 磁盘上就会留下一张和活码长得一模一样的废码。
  const cleanup = () => { void unlink(png).catch(() => {}); };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { cleanup(); process.exit(130); });
  }

  console.log(`
  二维码已生成并打开：${png}

  ⚠️ 必须用**网易云音乐 App** 的「扫一扫」（我的 → 右上角）。
     用相机或浏览器扫，只会打开一个网页登录页 —— 那是网页登录，
     完成不了这里需要的客户端握手，这边会一直停在「等待扫码」。

  ⚠️ 这张码只在**这个窗口还开着**的时候有效。

  链接（备用）：${qrurl}
`);

  const started = Date.now();
  let last = -1;
  while (Date.now() - started < GIVE_UP_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await api("/login/qr/check", { key: unikey });
    } catch {
      continue; // 单次轮询失败不算数，接着等
    }

    if (res.code !== last) {
      last = res.code;
      // 800 过期 / 801 等待扫码 / 802 已扫待确认 / 803 成功
      if (res.code === 801) console.log("  等待扫码…（若已用相机扫过，那条路走不通，Ctrl-C 换验证码登录）");
      else if (res.code === 802) console.log("  已扫到，请在手机上点确认…");
      else if (res.code !== 800 && res.code !== 803) {
        // 没见过的返回码原样打出来。闷头继续轮询的话，
        // 用户只会看到「一直在等」，却不知道服务端已经在说别的了。
        console.log(`  服务端返回 code=${res.code} ${res.message ?? ""}`);
      }
    }

    if (res.code === 800) {
      console.error("\n  二维码过期了，重新跑一次。\n");
      return false;
    }
    if (res.code === 803) return succeed(res.cookie);
  }

  console.error("\n  三分钟没等到确认，退出。\n");
  return false;
}

// ── 入口 ──────────────────────────────────────────────

async function main() {
  try {
    await api("/login/qr/key");
  } catch {
    console.error(`
  连不上 ${BASE}。
  先在另一个窗口跑：npm run netease:api
`);
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ok = false;
  try {
    let mode = argv.includes("--qr") ? "qr" : argv.includes("--sms") ? "sms" : null;
    if (!mode) {
      console.log(`
  选择登录方式：

    1) 手机验证码 —— 不需要装 App，推荐
    2) 扫码       —— 需要**网易云音乐 App** 的扫一扫
                     （相机、浏览器、微信扫都不行）
`);
      const pick = (await rl.question("  输入 1 或 2（回车默认 1）：")).trim();
      mode = pick === "2" ? "qr" : "sms";
    }
    ok = mode === "qr" ? await loginByQr() : await loginBySms(rl);
  } finally {
    rl.close();
  }
  process.exit(ok ? 0 : 1);
}

// 被 import 时不要跑起来 —— 测试只想要上面那两个纯函数
if (import.meta.url === `file://${process.argv[1]}`) await main();
