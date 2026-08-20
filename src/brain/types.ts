/**
 * 大脑抽象层。
 *
 * 整个项目对「模型」的唯一依赖就是这个接口。换 Claude 的不同档位、
 * 换成 GLM / DeepSeek 的 OpenAI 兼容端点，都只需要新增一个实现，
 * 上层代码一行不动。
 */

import { z } from "zod";
import type { ContextBundle } from "../context/assemble.ts";

/**
 * DJ 的输出契约 —— 图一第三层那个 `{say, play[], reason, segue}`。
 *
 * 从第一天就锁死这个形状。阶段①只用到 say / reason / play，
 * segue 先渲染成文本；阶段③接上 TTS 时，say 和 segue 直接进语音管线，
 * 不用改契约。
 */
export const DJResponseSchema = z.object({
  /** DJ 口播正文。阶段③会被送进 TTS 合成语音 */
  say: z.string(),
  /** 本轮要播的曲目。只给歌名和艺人，由 provider 负责解析成真实曲目 */
  play: z.array(
    z.object({
      title: z.string(),
      artist: z.string(),
    }),
  ),
  /** 为什么是这些歌 —— 展示给用户看的推荐理由 */
  reason: z.string(),
  /** 过渡语 / 下一步钩子，比如「等你听完这首，我们聊聊他后来的转型」 */
  segue: z.string(),
});

export type DJResponse = z.infer<typeof DJResponseSchema>;

/** 对话历史里的一轮 */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface BrainRequest {
  /** 组装好的六片上下文 */
  context: ContextBundle;
  /** 历史对话 */
  history: Turn[];
  /** 本轮用户输入 */
  input: string;
}

export interface BrainUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 估算美元成本，用于让用户看见花了多少钱 */
  estimatedUsd: number;
}

export interface BrainResult {
  response: DJResponse;
  usage: BrainUsage;
  model: string;
}

export interface BrainAdapter {
  readonly name: string;
  readonly model: string;
  think(req: BrainRequest): Promise<BrainResult>;
}
