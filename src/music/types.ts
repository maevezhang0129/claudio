/**
 * 音源抽象层。
 *
 * 设计原则：大脑（Claude）只负责产出「歌名 + 艺人」这种人类语义，
 * provider 负责把它变成一个真实存在、可播放的 Track。
 * 上层的 router / context / server 永远不知道底下接的是谁。
 */

export type ProviderName = "itunes" | "applemusic" | "netease";

/** 整曲播放句柄。阶段①（itunes）拿不到，为 undefined。 */
export interface FullPlayback {
  /** 交给前端播放 SDK 的类型标记 */
  kind: "musickit" | "url";
  /** musickit: Apple catalog id；url: 可直接塞进 <audio> 的直链 */
  ref: string;
}

export interface Track {
  /** provider 内的唯一 ID。iTunes 的 trackId 即 Apple Music catalog ID，两者通用 */
  providerId: string;
  provider: ProviderName;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  /** 30 秒试听直链 */
  previewUrl?: string;
  /** 整曲播放句柄，阶段①为 undefined */
  fullPlayback?: FullPlayback;
  /** 跳转到对应 App 的链接 */
  externalUrl?: string;
}

/** 大脑吐出来的、待解析的曲目意图 */
export interface TrackQuery {
  title: string;
  artist: string;
}

export interface ProviderCapabilities {
  /** 能拿到 30s 试听 */
  preview: boolean;
  /** 能整曲播放 */
  fullPlayback: boolean;
  /** 能读用户资料库（用于生成品味画像） */
  userLibrary: boolean;
}

/** 匹配置信度 */
export type MatchConfidence =
  /** 曲名与艺人都对上了 */
  | "exact"
  /** 曲名对上了但艺人不同 —— 翻唱/现场/跨平台艺名不一致。仍可播，但应当向用户交代 */
  | "alternate";

export interface ResolveResult {
  track: Track;
  confidence: MatchConfidence;
  /** confidence 为 alternate 时说明差异，交给 DJ 向用户交代 */
  note?: string;
}

export interface MusicProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /**
   * 把大脑给的 {歌名, 艺人} 解析成真实曲目。
   *
   * 这是整个阶段①质量的命门 —— 它同时承担两个职责：
   *   1. 曲库匹配：拿到封面、时长、可播放链接
   *   2. 幻觉过滤：连曲名都对不上 => 模型编的，返回 null，由上层丢弃
   *
   * 注意返回的是三态而非布尔：曲名对上但艺人不同（翻唱、现场、
   * 跨平台艺名不一致，如「买辣椒也用券」在 Apple Music 上叫「冯沁苑LaJiao」）
   * 是一种真实且常见的情况，不该当成幻觉丢掉，但也不该假装匹配成功。
   */
  resolve(query: TrackQuery): Promise<ResolveResult | null>;

  /** 自由文本搜索，用于用户直接搜歌 */
  search(term: string, limit?: number): Promise<Track[]>;
}
