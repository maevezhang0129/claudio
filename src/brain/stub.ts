/**
 * 桩大脑 —— 不调 API、不花钱。
 *
 * 用途：调前端、调曲目解析、调上下文组装时，不需要每次都付模型钱。
 * 用 CLAUDIO_BRAIN=stub 启用。
 *
 * 它会故意在 play[] 里混入一首不存在的歌，这样你在开发时
 * 能持续看到幻觉过滤那条路径的真实表现，而不是等上线才发现它没接对。
 */

import type {
  BrainAdapter,
  BrainRequest,
  BrainResult,
  DJResponse,
} from "./types.ts";

/** 按用户输入里的关键词切换语气，让离线调试也有点真实感 */
const SCRIPTS: Array<{ match: RegExp; make: () => DJResponse }> = [
  {
    match: /累|疲|倦/,
    make: () => ({
      say: "那就不上强度了。\n这几首都可以不集中注意力听，走神了也不亏。",
      reason: "mood-rules.md 里写着「我说累 = 不要励志，不要激昂」，所以避开了所有大编制和副歌轰炸。",
      segue: "要是听着听着睡着了，那是它们干得漂亮。",
      play: [
        { title: "富士山下", artist: "陈奕迅" },
        { title: "无与伦比的美丽", artist: "苏打绿" },
        { title: "Weird Fishes/ Arpeggi", artist: "Radiohead" },
        { title: "夜航西飞的第十一封信", artist: "陈奕迅" }, // 故意编的
      ],
    }),
  },
  {
    match: /专注|工作|写|学习/,
    make: () => ({
      say: "只给器乐。\n有人声你会去听词，那就不叫专注了。",
      reason: "routines.md 里 10:00–12:00 那条写得很清楚：任何有歌词的都会分心。",
      segue: "两小时后我再来问你进展。",
      play: [
        { title: "Music for Airports", artist: "Brian Eno" },
        { title: "Avril 14th", artist: "Aphex Twin" },
        { title: "Treefingers", artist: "Radiohead" },
        { title: "Nocturne in Amber Glass", artist: "Brian Eno" }, // 故意编的
      ],
    }),
  },
  {
    match: /.*/,
    make: () => ({
      say: "夜里这个点，给你四首。\n按情绪从钝到锐排的，最后一首别在通勤时听。",
      reason: "从 taste.md 那句「任何有真实鼓手的东西」出发挑的，四首的鼓组都是真人打的。",
      segue: "下次聊聊他们的现场版本，那才是这几个人真正的样子。",
      play: [
        { title: "海阔天空", artist: "Beyond" },
        { title: "晴天", artist: "周杰伦" },
        { title: "起风了", artist: "买辣椒也用券" },
        { title: "永夜的第七章序曲", artist: "陈奕迅" }, // 故意编的
      ],
    }),
  },
];

export class StubBrain implements BrainAdapter {
  readonly name = "stub";
  readonly model = "stub（离线，不花钱）";

  async think(req: BrainRequest): Promise<BrainResult> {
    // 模拟一点网络延迟，让前端的 loading 状态能被看见
    await new Promise((r) => setTimeout(r, 450));
    const script = SCRIPTS.find((s) => s.match.test(req.input)) ?? SCRIPTS.at(-1)!;
    return {
      model: this.model,
      response: script.make(),
      usage: {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedUsd: 0,
      },
    };
  }
}
