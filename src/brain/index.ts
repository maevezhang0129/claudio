/** 大脑工厂。想换 GLM / DeepSeek，在这里加一个 case 即可。 */

import type { BrainAdapter } from "./types.ts";
import { ClaudeBrain } from "./claude.ts";
import { StubBrain } from "./stub.ts";

export interface BrainConfig {
  /** "claude" | "stub"。stub 不调 API、不花钱，用于离线调前端 */
  kind?: string;
  model: string;
  apiKey?: string;
}

export function createBrain(cfg: BrainConfig): BrainAdapter {
  if (cfg.kind === "stub") return new StubBrain();
  return new ClaudeBrain({ model: cfg.model, apiKey: cfg.apiKey });
}

export * from "./types.ts";
export { ClaudeBrain } from "./claude.ts";
export { StubBrain } from "./stub.ts";
