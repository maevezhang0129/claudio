/**
 * iTunes Search API provider —— 阶段①的音源。
 *
 * 为什么选它：零鉴权、免费、无需任何账号，覆盖的就是 Apple Music 曲库，
 * 返回 30 秒试听直链。它的 trackId 就是 Apple Music catalog ID，
 * 将来升级到 MusicKit 整曲播放时 ID 直接通用，不用重新匹配曲库。
 *
 * 限制：只有 30 秒试听，没有整曲；读不到用户资料库。
 */

import type {
  MusicProvider,
  ProviderCapabilities,
  ResolveResult,
  Track,
  TrackQuery,
} from "./types.ts";
import { lengthRatio, normalize, similarity } from "./normalize.ts";

const ENDPOINT = "https://itunes.apple.com/search";

/**
 * 网络抖动重试一次。
 *
 * 上层把 resolve() 返回的 null 一律当成「模型编的」，
 * 所以一次瞬时失败会让一首真实存在的歌被记成幻觉、悄悄消失 ——
 * 实测 npm run verify 里「Beyond - 海阔天空」就这么被丢过。
 *
 * 只重试**够不着服务**的情况（fetch 抛异常、超时）。
 * HTTP 4xx 是服务给出的明确答复，重试没有意义。
 */
async function withRetry<T>(fn: () => Promise<T>, delayMs = 250): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    return await fn();
  }
}


/** 判定为「同一首歌」的阈值。0.72 是为了让繁简差异（约 0.75）能通过。 */
const TITLE_THRESHOLD = 0.72;
const ARTIST_THRESHOLD = 0.55;

/**
 * 曲名长度比下限 —— 包含式匹配的闸门，两趟都生效。
 *
 * 相似度单独拦不住「一个编造的曲名裹着一个真实曲名」：
 * 「Soft Spot in the Rain」包含真实的「Soft Spot」，能拿到 0.735；
 * 「永夜的第七章序曲」包含「夜的第七章」，能拿到 0.81 —— 都越过了 0.72。
 *
 * 一开始只装在 alternate 那条路上，理由是「艺人对上时包含是可信的」。
 * 那个判断是错的：模型编的往往正是**真艺人 + 加了料的曲名**，
 * 那种情况艺人当然对得上，于是从第一趟大摇大摆地走了过去。
 *
 * 0.8 这个值让真实的修饰词安全通过 —— 「晴天 (Live)」「七里香 (电视剧主题曲)」
 * 的括号部分会先被 normalize 剥掉，比值是 1.0；繁简差异也等长。
 * 而被额外的词裹起来的曲名比值在 0.5–0.63 之间，过不去。
 */
const TITLE_LENGTH_FLOOR = 0.8;

interface ITunesResult {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  trackTimeMillis?: number;
  previewUrl?: string;
  trackViewUrl?: string;
}

export interface ITunesOptions {
  /** storefront：CN=简体 TW/HK=繁体 US=英文。默认 CN */
  storefront?: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
}

export class ITunesProvider implements MusicProvider {
  readonly name = "itunes" as const;
  readonly capabilities: ProviderCapabilities = {
    preview: true,
    fullPlayback: false,
    userLibrary: false,
  };

  private storefront: string;
  private timeoutMs: number;
  /** 进程内缓存：同一次会话里模型常反复提到同几首歌 */
  private cache = new Map<string, ResolveResult | null>();

  constructor(opts: ITunesOptions = {}) {
    this.storefront = opts.storefront ?? "CN";
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async query(term: string, limit: number): Promise<ITunesResult[]> {
    return withRetry(() => this.queryOnce(term, limit));
  }

  private async queryOnce(term: string, limit: number): Promise<ITunesResult[]> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("term", term);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("country", this.storefront);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`iTunes API ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { results?: ITunesResult[] };
    return body.results ?? [];
  }

  private toTrack(r: ITunesResult): Track | null {
    if (!r.trackId || !r.trackName || !r.artistName) return null;
    return {
      providerId: String(r.trackId),
      provider: this.name,
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      // artworkUrl100 换成 600x600，画质好得多
      artworkUrl: r.artworkUrl100?.replace("100x100bb", "600x600bb"),
      durationMs: r.trackTimeMillis,
      previewUrl: r.previewUrl,
      fullPlayback: undefined, // iTunes 拿不到整曲
      externalUrl: r.trackViewUrl,
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

  /**
   * 两趟匹配：
   *   第一趟 —— 用「艺人 + 歌名」搜，要求曲名和艺人都达标 => exact
   *   第二趟 —— 只用歌名搜，只要求曲名达标 => alternate（翻唱/现场/艺名不一致）
   * 两趟都落空才判定为幻觉。
   */
  private async resolveUncached(q: TrackQuery): Promise<ResolveResult | null> {
    const wantTitle = normalize(q.title);
    const wantArtist = normalize(q.artist);
    if (!wantTitle) return null;

    const scoreAgainst = (raw: ITunesResult[], requireArtist: boolean) => {
      let best: { track: Track; titleScore: number; artistScore: number; score: number } | null = null;
      for (const r of raw) {
        const t = this.toTrack(r);
        if (!t) continue;
        const gotTitle = normalize(t.title);
        const titleScore = similarity(wantTitle, gotTitle);
        if (titleScore < TITLE_THRESHOLD) continue;
        if (lengthRatio(wantTitle, gotTitle) < TITLE_LENGTH_FLOOR) continue;
        const artistScore = similarity(wantArtist, normalize(t.artist));
        if (requireArtist && artistScore < ARTIST_THRESHOLD) continue;
        // 曲名权重更高：艺人名有译名/别名/合唱者等噪声
        const score = titleScore * 0.7 + artistScore * 0.3;
        if (!best || score > best.score) best = { track: t, titleScore, artistScore, score };
      }
      return best;
    };

    // 第一趟：艺人 + 歌名
    try {
      const hit = scoreAgainst(await this.query(`${q.artist} ${q.title}`, 12), true);
      if (hit) return { track: hit.track, confidence: "exact" };
    } catch {
      return null; // 网络失败按解析不到处理，宁可少推荐也不要推错
    }

    // 第二趟：只搜歌名，放宽艺人要求
    try {
      const hit = scoreAgainst(await this.query(q.title, 20), false);
      if (!hit) return null;
      // 艺人其实也对上了（只是第一趟的组合搜索没召回），仍算 exact
      if (hit.artistScore >= ARTIST_THRESHOLD) {
        return { track: hit.track, confidence: "exact" };
      }
      return {
        track: hit.track,
        confidence: "alternate",
        note: `曲库里没有 ${q.artist} 的版本，这是 ${hit.track.artist} 的`,
      };
    } catch {
      return null;
    }
  }

  async search(term: string, limit = 10): Promise<Track[]> {
    let raw: ITunesResult[];
    try {
      raw = await this.query(term, limit);
    } catch {
      return [];
    }
    return raw
      .map((r) => this.toTrack(r))
      .filter((t): t is Track => t !== null);
  }
}
