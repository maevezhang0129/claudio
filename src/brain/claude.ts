/**
 * Claude 大脑适配器。
 *
 * 换档位只改 model 字符串。想换成 GLM / DeepSeek，
 * 新写一个实现 BrainAdapter 的类即可，上层不用动。
 */

import Anthropic from "@anthropic-ai/sdk";
// 结构化输出在 SDK 0.71 里还在 beta 路径下：client.beta.messages.parse()
// 配 betaZodOutputFormat，parse 会自动补上 structured-outputs-2025-11-13 头
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  DJResponseSchema,
  type BrainAdapter,
  type BrainRequest,
  type BrainResult,
  type BrainUsage,
} from "./types.ts";

/** 每百万 token 单价（美元）。用于把成本显示给用户看。 */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
};

/**
 * 缓存最小前缀长度。短于这个长度的前缀会被静默地不缓存 ——
 * 不报错，只是 cache_read_input_tokens 一直是 0。
 * Haiku 档位的门槛比其他档位高一倍。
 */
const CACHE_MIN_TOKENS: Record<string, number> = {
  "claude-haiku-4-5": 2048,
};
const CACHE_MIN_DEFAULT = 1024;

export interface ClaudeBrainOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}

export class ClaudeBrain implements BrainAdapter {
  readonly name = "claude";
  readonly model: string;

  private client: Anthropic;
  private maxTokens: number;

  constructor(opts: ClaudeBrainOptions = {}) {
    this.model = opts.model ?? "claude-haiku-4-5";
    this.maxTokens = opts.maxTokens ?? 2048;
    // 不传 apiKey 时 SDK 自己从 ANTHROPIC_API_KEY 等环境凭据解析
    this.client = opts.apiKey
      ? new Anthropic({ apiKey: opts.apiKey })
      : new Anthropic();
  }

  /** 这个模型的缓存最小前缀，供上层提示用户「语料太短，缓存还没生效」 */
  get cacheMinTokens(): number {
    return CACHE_MIN_TOKENS[this.model] ?? CACHE_MIN_DEFAULT;
  }

  private cost(u: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }): number {
    const p = PRICING[this.model];
    if (!p) return 0;
    const M = 1_000_000;
    const cacheRead = (u.cache_read_input_tokens ?? 0) * (p.in * 0.1);
    const cacheWrite = (u.cache_creation_input_tokens ?? 0) * (p.in * 1.25);
    return (
      (u.input_tokens * p.in + u.output_tokens * p.out + cacheRead + cacheWrite) / M
    );
  }

  async think(req: BrainRequest): Promise<BrainResult> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      // 稳定前缀单独成块并打缓存断点。易变内容放在它之后，
      // 这样每轮变化的时间/播放记录不会让整个前缀失效。
      system: [
        {
          type: "text",
          text: req.context.stable,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: req.context.volatile,
        },
      ],
      messages: [
        ...req.history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user" as const, content: req.input },
      ],
      output_format: betaZodOutputFormat(DJResponseSchema),
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("模型返回的结构化输出解析失败");
    }

    const u = response.usage;
    const usage: BrainUsage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      estimatedUsd: this.cost(u),
    };

    return { response: parsed, usage, model: this.model };
  }
}
