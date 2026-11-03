/**
 * 混合音源 —— 网易云负责认歌，iTunes 负责出声。
 *
 * 为什么要有它：两个 provider 的强项正好互补。同一批 30 首
 * （按播放次数从用户曲库取样）各跑三轮，看区间不看单轮 ——
 *
 *   |            | iTunes  | 网易云（匿名） | mixed   |
 *   | exact /30  |  23     |    20–26      | 24–26   |
 *   | 解析不到   |   4     |     1–8       |  1–2    |
 *   | 可播 /30   |  26     |      0        |  27     |
 *   | 中位耗时   | 173–211ms | 1308–1656ms | 168–197ms |
 *
 * 网易云的华语曲库更全，认得出 iTunes 认不出的歌；但匿名状态下
 * 一首都放不出来，而且那个跨度是逆向接口本身的抖动 ——
 * 两轮之间什么都没改。iTunes 三轮返回的结果一字不差。
 *
 * ── 流程：以 iTunes 为基线，网易云只在 iTunes 没把握时才被叫醒 ──
 *   ① 先问 iTunes。拿到 exact 就结束 —— 这是 77% 的情况
 *   ② iTunes 只给出 alternate、或者干脆没找到，才问网易云
 *   ③ 用网易云归一化后的规范名再问一次 iTunes，看看换个名字能不能找到
 *   ④ 在「原始 query 的结果」和「规范名的结果」里挑更好的那个
 *
 * 第一版反过来写过（网易云优先、再拿规范名去换音源），实测更差：
 * 「买辣椒也用券 - 起风了」被网易云归一化成一个 20 人合唱的垃圾上传，
 * iTunes 再也找不回来，结果比单用 iTunes 还糟 —— 后者本来能正确找到
 * 冯沁苑LaJiao 的可播版本。以 iTunes 打底就没有这个问题：
 * **mixed 的结果永远不会比单用 iTunes 差**，网易云只做加法。
 *
 * 幻觉过滤仍然由 resolve() 的三态承担，判定标准没有放松：
 * 两个 provider 都认不出来，才算模型编的。
 */

import type {
  MatchConfidence,
  MusicProvider,
  ProviderCapabilities,
  ResolveResult,
  Track,
  TrackQuery,
} from "./types.ts";
import { ITunesProvider } from "./itunes.ts";
import { NeteaseProvider } from "./netease.ts";

export interface MixedOptions {
  itunesStorefront?: string;
  neteaseBaseUrl?: string;
  neteaseCookie?: string;
}

/** 两个置信度取弱的那个 —— 任何一边判为 alternate，结果就是 alternate */
function weaker(a: MatchConfidence, b: MatchConfidence): MatchConfidence {
  return a === "alternate" || b === "alternate" ? "alternate" : "exact";
}

export class MixedProvider implements MusicProvider {
  readonly name = "mixed" as const;
  readonly capabilities: ProviderCapabilities;

  private itunes: ITunesProvider;
  private netease: NeteaseProvider;
  private cache = new Map<string, ResolveResult | null>();

  constructor(opts: MixedOptions = {}) {
    this.itunes = new ITunesProvider({ storefront: opts.itunesStorefront });
    this.netease = new NeteaseProvider({
      baseUrl: opts.neteaseBaseUrl,
      cookie: opts.neteaseCookie,
    });
    this.capabilities = {
      // 试听来自 iTunes，永远有
      preview: true,
      // 整曲只有网易云给得了，且必须有 cookie
      fullPlayback: this.netease.capabilities.fullPlayback,
      userLibrary: false,
    };
  }

  async resolve(q: TrackQuery): Promise<ResolveResult | null> {
    const key = `${q.artist}\u0000${q.title}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const result = await this.resolveUncached(q);
    this.cache.set(key, result);
    return result;
  }

  private async resolveUncached(q: TrackQuery): Promise<ResolveResult | null> {
    const itDirect = await this.itunes.resolve(q).catch(() => null);

    // iTunes 已经精确命中。没配 cookie 的话网易云给不了任何额外的东西，
    // 直接收工 —— 这条快路径让 mixed 在多数情况下和单用 iTunes 一样快。
    if (itDirect?.confidence === "exact" && !this.capabilities.fullPlayback) {
      return this.rebrand(itDirect);
    }

    // 到这里说明：iTunes 没把握（alternate）、没找到，或者配了 cookie 要换整曲。
    const ne = await this.netease.resolve(q).catch(() => null);
    if (!ne) return itDirect ? this.rebrand(itDirect) : null;

    // 用网易云归一化后的名字再问一次 iTunes。
    // 模型写「买辣椒也用券」，网易云那步已经把它变成曲库里的规范名，
    // 换个名字 iTunes 的召回率可能完全不同。
    const sameName =
      ne.track.title === q.title && ne.track.artist === q.artist;
    const itCanon = sameName
      ? null
      : await this.itunes
          .resolve({ title: ne.track.title, artist: ne.track.artist })
          .catch(() => null);

    const best = this.better(itDirect, itCanon);
    if (best) {
      // 网易云的整曲只能接到同一个录音上。网易云判为 exact，说明它找到的
      // 就是模型要的那首；iTunes 按网易云给的名字精确命中，说明两边说的是
      // 同一个录音。除此之外 —— 网易云只找到别人的版本，而 iTunes 的结果
      // 来自原始 query —— 两边是两个录音，拼起来就是界面写着原唱、
      // 播放器放着翻唱（整曲优先于试听）。那时 iTunes 的答案原样就是对的。
      const sameRecording =
        ne.confidence === "exact" ||
        (best === itCanon && best.confidence === "exact");
      return sameRecording ? this.merge(best, ne) : this.rebrand(best);
    }

    // iTunes 两条路都没有音源，但网易云认得这首歌。仍然返回 ——
    // 它不是幻觉，只是听不了，前端会给一个跳转外部的入口。
    return this.rebrand(ne);
  }

  /** 只换 provider 标记，其余原样 */
  private rebrand(r: ResolveResult): ResolveResult {
    return { ...r, track: { ...r.track, provider: this.name } };
  }

  /**
   * 两个 iTunes 结果里挑更好的。
   * exact 胜过 alternate；打平时选原始 query 那个 ——
   * 它更贴近模型本来想说的东西，规范化只是一次补救。
   */
  private better(
    direct: ResolveResult | null,
    canon: ResolveResult | null,
  ): ResolveResult | null {
    if (!direct) return canon;
    if (!canon) return direct;
    if (direct.confidence === canon.confidence) return direct;
    return direct.confidence === "exact" ? direct : canon;
  }

  /**
   * 合并 iTunes 的音源和网易云的判断。
   *
   * 音源相关的字段（试听、封面、跳转）整体取 iTunes 那一条 ——
   * 它们必须彼此一致，混着拼会出现「封面是这首、试听是那首」。
   * 网易云只贡献两样：整曲直链，以及它对「是不是同一首歌」的判断。
   */
  private merge(it: ResolveResult, ne: ResolveResult): ResolveResult {
    const track: Track = {
      ...it.track,
      provider: this.name,
      // 网易云有整曲就用整曲，没有就退回 iTunes 的 30 秒试听
      fullPlayback: ne.track.fullPlayback,
      // 时长以整曲那边为准；只有试听时 iTunes 给的才是真实时长
      durationMs: ne.track.fullPlayback
        ? (ne.track.durationMs ?? it.track.durationMs)
        : it.track.durationMs,
    };
    return {
      track,
      confidence: weaker(ne.confidence, it.confidence),
      // iTunes 的 note 解释的是用户最终**听到**的是什么，
      // 那才是需要向用户交代的事；网易云的判断只影响选谁。
      note: it.note ?? ne.note,
    };
  }

  /**
   * 网易云那半边在不在。
   *
   * 不在也能用 —— iTunes 那半边是完整的，mixed 只是退化成纯 iTunes。
   * 但这件事必须**看得见**：默认音源是 mixed，如果服务没起而界面上
   * 什么都不说，用户会以为自己在用混合音源，实际拿到的是 iTunes 的召回率。
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    const [it, ne] = await Promise.all([
      this.itunes.health!(),
      this.netease.health!(),
    ]);
    if (it.ok && ne.ok) return { ok: true, detail: `iTunes 正常 · 网易云 ${ne.detail}` };
    // 任何一半失效都要说出来。两半各自都能独立工作，
    // 所以失效时功能还在 —— 正因为还能用，不报出来就永远不会被发现。
    if (!it.ok && !ne.ok) {
      return { ok: false, detail: `两边都不可用（${it.detail}；${ne.detail}）` };
    }
    return it.ok
      ? { ok: false, detail: `网易云不可用，退化为纯 iTunes（${ne.detail}）` }
      : { ok: false, detail: `iTunes 不可用，推荐全部来自网易云（${it.detail}）` };
  }

  /**
   * 自由文本搜索走 iTunes：搜出来是要能立刻点开听的，
   * 而网易云的结果匿名状态下点开是哑的。
   */
  async search(term: string, limit = 10): Promise<Track[]> {
    return this.itunes.search(term, limit);
  }
}
