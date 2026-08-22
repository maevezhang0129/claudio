/** 大脑工厂。加新厂商只在这里加一个分支，工厂以上的代码一行不动。 */

import type { BrainAdapter } from "./types.ts";
import { ClaudeBrain } from "./claude.ts";
import { StubBrain } from "./stub.ts";
import { OpenAICompatBrain, type CompatProvider } from "./openai-compat.ts";

export interface BrainConfig {
  /** "claude" | "stub" | "glm" | "deepseek" | "kimi" */
  kind?: string;
  model: string;
  apiKey?: string;
  /** OpenAI 兼容端点的 key，与 Anthropic 的分开配 */
  compatApiKey?: string;
  /** 覆盖端点地址，用于自建代理或换区 */
  baseURL?: string;
}

const COMPAT: readonly CompatProvider[] = ["glm", "deepseek", "kimi"];

function isCompat(kind: string): kind is CompatProvider {
  return (COMPAT as readonly string[]).includes(kind);
}

export function createBrain(cfg: BrainConfig): BrainAdapter {
  const kind = cfg.kind ?? "claude";

  if (kind === "stub") return new StubBrain();

  if (isCompat(kind)) {
    // 缺 key 不在这里抛：服务应该照常启动并给出可操作提示，
    // 而不是甩一堆堆栈让人连界面都打不开。真正的报错在 think() 里。
    return new OpenAICompatBrain({
      provider: kind,
      apiKey: cfg.compatApiKey ?? "",
      // 没显式指定 model 时用各家的默认档，而不是沿用 Claude 的模型名
      model: cfg.model && !cfg.model.startsWith("claude-") ? cfg.model : undefined,
      baseURL: cfg.baseURL,
    });
  }

  return new ClaudeBrain({ model: cfg.model, apiKey: cfg.apiKey });
}

export * from "./types.ts";
export { ClaudeBrain } from "./claude.ts";
export { StubBrain } from "./stub.ts";
export { OpenAICompatBrain } from "./openai-compat.ts";
