/** 集中读环境变量，所有默认值都在这里，别散落到各处 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM 里没有 __dirname，从 import.meta.url 推
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");

// 加载 .env（Node 内置，不需要 dotenv 依赖）。
// 文件不存在是正常情况 —— 用环境变量直接跑也可以。
// 注意 loadEnvFile 不覆盖已存在的环境变量，所以命令行传的值优先级更高。
try {
  process.loadEnvFile(path.join(ROOT_DIR, ".env"));
} catch {
  // 没有 .env，忽略
}

export const config = {
  rootDir: ROOT_DIR,
  port: Number(process.env.PORT ?? 8080),

  /** 大脑实现：claude | stub | glm | deepseek | kimi */
  brainKind: process.env.CLAUDIO_BRAIN ?? "claude",

  /** 大脑档位。默认最便宜的 Haiku 4.5 */
  model: process.env.CLAUDIO_MODEL ?? "claude-haiku-4-5",
  apiKey: process.env.ANTHROPIC_API_KEY,

  /** OpenAI 兼容端点的 key。按 brainKind 取对应的那一个 */
  compatApiKey:
    process.env.GLM_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    process.env.KIMI_API_KEY,
  /** 覆盖端点地址，用于自建代理或换区 */
  compatBaseURL: process.env.CLAUDIO_BASE_URL,

  /**
   * 音源 provider。默认 mixed —— 实测每个维度都不输纯 iTunes 且一样快
   * （见 mixed.ts 顶部）。它依赖的自建网易云服务没起时会自动退化成纯 iTunes，
   * 所以默认值不会让任何人跑不起来。
   */
  musicProvider: (process.env.CLAUDIO_MUSIC_PROVIDER ?? "mixed") as
    | "itunes" | "applemusic" | "netease" | "mixed",
  /**
   * iTunes storefront。默认 TW 而不是 CN。
   *
   * 2026-09-11 实测：CN 区对**任何**查询返回 0 条，英文中文都一样，
   * 而同一秒 TW / HK / US / JP 全部正常，接口还是 200 —— 没有任何报错。
   * 默认指着一个死掉的区，会让 mixed 的 iTunes 那半边静默失效，
   * 推荐全部悄悄改由网易云出，而界面上什么都不说。
   *
   * TW 是华语曲目最接近的替代（陳奕迅、Beyond 都在）。代价是曲名返回繁体，
   * 靠 0.72 的相似度阈值兜 —— 「告白气球 ↔ 告白氣球」是 0.750，verify 钉着它。
   * CN 哪天活过来，把这个值改回去即可，启动横幅会告诉你哪个区能用。
   */
  itunesStorefront: process.env.CLAUDIO_ITUNES_STOREFRONT ?? "TW",

  /** 自建 NeteaseCloudMusicApi 的地址。npm run netease:api 起在 3000 */
  neteaseBaseUrl: process.env.CLAUDIO_NETEASE_BASE_URL ?? "http://localhost:3000",
  /**
   * 已登录网易云账号的 cookie。没有它这个 provider 只能查不能播 ——
   * 匿名状态下 /song/url 对几乎所有歌都返回 null。
   */
  neteaseCookie: process.env.CLAUDIO_NETEASE_COOKIE,

  /** ③ 环境注入的坐标。默认上海 —— 与提示词里的 Asia/Shanghai 时区一致 */
  latitude: Number(process.env.CLAUDIO_LAT ?? 31.23),
  longitude: Number(process.env.CLAUDIO_LON ?? 121.47),
  /**
   * 是否读本机日历。默认关 —— 第一次读会弹系统授权框，
   * 而且 Calendar.app 的 Apple Event 慢，那个延迟每轮都要付。
   */
  calendarEnabled: process.env.CLAUDIO_CALENDAR === "on",

  /**
   * 到点自动为空着的那一档排期。默认关。
   *
   * 排期是这个项目里唯一会花钱的自动路径，所以它必须由人显式打开一次，
   * 而不是「打开页面就跑」。开了之后每换到一个还没排期的档
   * 会调一次模型（glm-4.5-air 约 $0.00055），一天最多等于 routines.md 里的档数。
   */
  autoPlan: process.env.CLAUDIO_AUTOPLAN === "on",

  dbPath: path.join(ROOT_DIR, "data", "state.db"),
} as const;
