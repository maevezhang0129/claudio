/**
 * OpenAI 兼容端点的大脑适配器 —— GLM / DeepSeek / Kimi 共用一个实现。
 *
 * 为什么不复用 Claude 那套 `messages.parse` + Zod 严格模式：
 * 这几家只保证 `response_format: {"type":"json_object"}`（JSON 模式），
 * 不保证 OpenAI 那种带 schema 的严格约束，便宜档尤其没有明确说明。
 * 所以这里的策略是「要求出 JSON + 提示词里描述 schema + 客户端校验 + 重试一次」，
 * 无论对端支不支持 json_object 都能工作。
 *
 * 用原生 fetch，不引入 SDK —— 只需要一个 POST。
 */

import {
  DJResponseSchema,
  type BrainAdapter,
  type BrainRequest,
  type BrainResult,
  type BrainUsage,
  type DJResponse,
} from "./types.ts";

export type CompatProvider = "glm" | "deepseek" | "kimi";

interface ProviderPreset {
  baseURL: string;
  defaultModel: string;
  /** 每百万 token 单价（人民币）。免费档写 0。 */
  pricing: Record<string, { in: number; out: number }>;
  /** 人民币转美元，只为了和 Claude 档位在同一个刻度上显示 */
  cnyPerUsd: number;
}

const PRESETS: Record<CompatProvider, ProviderPreset> = {
  glm: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    defaultModel: "glm-4.7-flash",
    pricing: {
      "glm-4.7-flash": { in: 0, out: 0 },      // 官方定价表标注免费
      "glm-4.7-flashx": { in: 0.5, out: 3 },
      "glm-4.5-air": { in: 0.8, out: 6 },      // 输出 ≥0.2K 档，DJ 口播都落在这里
      "glm-4.7": { in: 3, out: 14 },
      "glm-5": { in: 4, out: 18 },
    },
    cnyPerUsd: 7.1,
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-chat",
    pricing: {
      // 高峰价。DeepSeek 有峰谷分时，空闲时段约半价，这里按贵的算不低估
      "deepseek-chat": { in: 3, out: 9 },
      "deepseek-reasoner": { in: 9, out: 27 },
    },
    cnyPerUsd: 7.1,
  },
  kimi: {
    baseURL: "https://api.moonshot.cn/v1/chat/completions",
    defaultModel: "kimi-k2.5",
    pricing: {
      "kimi-k2.5": { in: 4.3, out: 21 },
      "kimi-k2.6": { in: 6.7, out: 28 },
    },
    cnyPerUsd: 7.1,
  },
};

/**
 * 输出契约的自然语言描述。
 *
 * Claude 那条路用原生 schema 约束，这里只能靠提示词 —— 所以要写得
 * 比给人看的更死板：字段名、类型、数量都写清楚。
 */
const SCHEMA_INSTRUCTION = `
你必须只输出一个 JSON 对象，不要有任何解释、前言或 markdown 代码块。

结构：
{
  "say": "字符串。DJ 口播正文，会被读成语音，写成能被读出来的句子，不要列表符号。",
  "play": [ { "title": "曲名", "artist": "艺人名" } ],
  "reason": "字符串。为什么是这几首，点明和品味语料里哪一条对应上了。",
  "segue": "字符串。一句过渡，指向下一次。"
}

play 数组给 4 到 6 首。title 和 artist 要写曲库里的标准写法，
不要加「（live版）」「feat.」这类修饰，除非你确实指的就是那个版本。
`.trim();

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

export interface OpenAICompatOptions {
  provider: CompatProvider;
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class OpenAICompatBrain implements BrainAdapter {
  readonly name: string;
  readonly model: string;

  private preset: ProviderPreset;
  private baseURL: string;
  private apiKey: string;
  private maxTokens: number;
  private timeoutMs: number;

  constructor(opts: OpenAICompatOptions) {
    this.preset = PRESETS[opts.provider];
    if (!this.preset) throw new Error(`未知的 provider：${opts.provider}`);
    this.name = opts.provider;
    this.model = opts.model || this.preset.defaultModel;
    this.baseURL = opts.baseURL || this.preset.baseURL;
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async call(messages: Array<{ role: string; content: string }>): Promise<ChatResponse> {
    const res = await fetch(this.baseURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: 0.8,
        // 对端不支持时通常是忽略而不是报错；提示词里也描述了 schema，双保险
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok) {
      throw new Error(body.error?.message || `${this.name} 返回 ${res.status} ${res.statusText}`);
    }
    return body;
  }

  /**
   * 从模型输出里抠出 JSON。
   * 即使要求了 json_object，仍可能被包在 ```json 代码块里或带前言。
   */
  private extractJson(raw: string): unknown {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) s = fence[1].trim();
    else {
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      if (start >= 0 && end > start) s = s.slice(start, end + 1);
    }
    return JSON.parse(s);
  }

  private cost(u: ChatResponse["usage"]): number {
    const p = this.preset.pricing[this.model];
    if (!p) return 0;
    const inTok = u?.prompt_tokens ?? 0;
    const outTok = u?.completion_tokens ?? 0;
    const cny = (inTok * p.in + outTok * p.out) / 1_000_000;
    return cny / this.preset.cnyPerUsd;
  }

  async think(req: BrainRequest): Promise<BrainResult> {
    if (!this.apiKey) {
      throw new Error(
        `缺少 ${this.name.toUpperCase()}_API_KEY。写进 .env 即可；` +
          `GLM 在 bigmodel.cn 申请，glm-4.7-flash 档位免费。`,
      );
    }
    const system = `${req.context.stable}\n\n${req.context.volatile}\n\n${SCHEMA_INSTRUCTION}`;
    const messages = [
      { role: "system", content: system },
      ...req.history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: req.input },
    ];

    let response: ChatResponse | undefined;
    let parsed: DJResponse | undefined;
    let lastError = "";

    // 两次机会：第二次把校验错误回灌，让模型自己改
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      response = await this.call(messages);
      const raw = response.choices?.[0]?.message?.content ?? "";

      try {
        const result = DJResponseSchema.safeParse(this.extractJson(raw));
        if (result.success) {
          parsed = result.data;
          break;
        }
        lastError = result.error.issues
          .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
          .join("；");
      } catch (err) {
        lastError = `不是合法 JSON：${err instanceof Error ? err.message : String(err)}`;
      }

      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `上一条回复不符合要求：${lastError}\n请只输出符合结构的 JSON，不要任何其他内容。`,
        },
      );
    }

    if (!parsed) {
      throw new Error(`${this.name} 连续两次输出不符合结构。最后一次的问题：${lastError}`);
    }

    const u = response?.usage;
    // 各家缓存命中字段名不一样，能取到就取
    const cached = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: BrainUsage = {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      estimatedUsd: this.cost(u),
    };

    return { response: parsed, usage, model: this.model };
  }
}
