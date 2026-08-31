/**
 * 扫码登录网易云，把 cookie 写进 .env。
 *
 * 为什么要有这个脚本：另一条路是「打开开发者工具 → Application →
 * Cookies → 复制 MUSIC_U」。那串东西 300 多字符、复制时容易漏字符，
 * 而且在 Mac 上连打开开发者工具都得先知道 F12 是音量键。
 * 自建的那个服务本身就支持扫码登录，没理由不用。
 *
 * 跑法：
 *   npm run netease:api     # 另一个窗口，先起服务
 *   npm run netease:login   # 这个脚本，手机扫一下
 *
 * cookie 是凭据，所以它只会被写进 .env（已 gitignore），
 * 终端上只打印掩码，不打印原文。
 *
 * 二维码图片是**一次性**的：只在本进程轮询期间有意义。所以启动时先清掉
 * 旧的，退出时删掉自己这张。留在磁盘上的二维码看起来永远有效，
 * 扫了却没有任何进程在等 —— 手机上会正常登录，这边什么也不会发生，
 * 而这恰恰是最难自己看出来的一种失败。
 */

import { writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(ROOT, ".env");
const BASE = process.env.CLAUDIO_NETEASE_BASE_URL ?? "http://localhost:3000";
const KEY = "CLAUDIO_NETEASE_COOKIE";

const QR_PREFIX = "claudio-netease-qr-";

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

/** 轮询间隔。网易云那边的二维码有效期约 3 分钟 */
const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60_000;

async function api(route, params = {}) {
  const url = new URL(BASE + route);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // 这套服务对同一 IP 的请求有缓存，加时间戳绕开陈旧结果
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

  await sweepOldQr();
  const { data: { unikey } } = await api("/login/qr/key");
  const { data: { qrimg, qrurl } } = await api("/login/qr/create", {
    key: unikey,
    qrimg: true,
  });

  // qrimg 是 data:image/png;base64,... —— 落成文件再交给系统打开，
  // 比在终端里画 ASCII 二维码可靠（也不用为此引一个依赖）
  const png = path.join(tmpdir(), `${QR_PREFIX}${Date.now()}.png`);
  await writeFile(png, Buffer.from(qrimg.split(",")[1], "base64"));
  if (process.platform === "darwin") execFile("open", [png], () => {});

  // 无论怎么退出都把图删掉，别给下一次留一张会被误扫的废码
  const cleanup = () => { void unlink(png).catch(() => {}); };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  console.log(`
  二维码已生成并打开：${png}

  ⚠️ 这张码只在**这个窗口还开着**的时候有效。
     关掉这个进程它就作废了 —— 那时候再扫，手机上照样会显示登录成功，
     但这边没有任何东西在等，.env 不会有任何变化。

  用**网易云音乐 App** 扫它 —— 不是微信，不是相机。
  App 里：我的 → 右上角扫一扫 → 扫完在手机上点确认。

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
      if (res.code === 801) console.log("  等待扫码…");
      else if (res.code === 802) console.log("  已扫到，请在手机上点确认…");
      else if (res.code !== 800 && res.code !== 803) {
        // 没见过的返回码原样打出来。闷头继续轮询的话，
        // 用户只会看到「一直在等」，却不知道服务端已经在说别的了。
        console.log(`  服务端返回 code=${res.code} ${res.message ?? ""}`);
      }
    }

    if (res.code === 800) {
      console.error("\n  二维码过期了，重新跑一次 npm run netease:login\n");
      process.exit(1);
    }

    if (res.code === 803) {
      const cookie = extractMusicU(res.cookie);
      if (!cookie) {
        console.error("\n  登录成功了，但返回里没有 MUSIC_U。请改用手动方式。\n");
        process.exit(1);
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
      return;
    }
  }

  console.error("\n  三分钟没等到确认，退出。重新跑一次即可。\n");
  process.exit(1);
}

// 被 import 时不要跑起来 —— 测试只想要上面那两个纯函数
if (import.meta.url === `file://${process.argv[1]}`) await main();
