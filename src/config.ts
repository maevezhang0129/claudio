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

  /** 音源 provider */
  musicProvider: (process.env.CLAUDIO_MUSIC_PROVIDER ?? "itunes") as
    | "itunes" | "applemusic" | "netease",
  itunesStorefront: process.env.CLAUDIO_ITUNES_STOREFRONT ?? "CN",

  dbPath: path.join(ROOT_DIR, "data", "state.db"),
} as const;
