/**
 * 网易云音乐 provider —— 阶段②的整曲音源。
 *
 * 为什么是它：华语曲库最全。iTunes 那边搜「陈奕迅 富士山下」要靠相似度兜，
 * 这边第一条就是原版。代价是这套接口是逆向出来的、没有任何保证，
 * 所以本文件对返回值一律做防御性处理，任何一层缺字段都退化成「解析不到」，
 * 而不是抛异常把整轮推荐带崩。
 *
 * 依赖一个自建的 NeteaseCloudMusicApi 服务（默认 http://localhost:3000）。
 * 它不是本仓库的依赖，而是一个独立进程 —— npm run netease:api 起它。
 *
 * ── 关于播放权限，这是本 provider 唯一真正的坑 ──
 * 匿名（未登录）状态下，搜索和元数据完全正常，但 privilege.pl 几乎全是 0、
 * /song/url 一律返回 url: null。也就是说不带 cookie 时这个 provider
 * 只能查不能播，能力还不如 iTunes 的 30 秒试听。
 * 要拿到整曲，必须给 CLAUDIO_NETEASE_COOKIE 一个已登录账号的 cookie，
 * 且该账号对这首歌有权限（VIP 曲目仍然要 VIP）。
 */

import type {
  MusicProvider,
  ProviderCapabilities,
  ResolveResult,
  Track,
  TrackQuery,
} from "./types.ts";
import { lengthRatio, normalize, similarity } from "./normalize.ts";

/** 与 iTunes 保持同一套阈值 —— 判定「同一首歌」的标准不该随音源变化 */
const TITLE_THRESHOLD = 0.72;
const ARTIST_THRESHOLD = 0.55;

/**
 * 第二趟（没有艺人佐证）额外要求的长度比下限。
 *
 * 只在 alternate 那条路上生效：艺人对上时，「晴天」→「晴天 (Live)」
 * 这种包含式匹配是可信的；艺人对不上时它就是幻觉的主要入口。
 * 0.8 是让繁简差异（长度相等，比值 1.0）安全通过、
 * 而「永夜的第七章序曲」→「夜的第七章」（0.625）被拦下的分界。
 */
const ALT_LENGTH_FLOOR = 0.8;

/**
 * 能播的加分。量级是刻意压小的：
 * 同一首歌在网易云常有多个条目（不同上传、Live、重制），其中只有一部分有版权，
 * 这点加分足以在它们之间选中能播的那个，但不足以让一首明显更不像的歌胜出。
 */
const PLAYABLE_BONUS = 0.1;

interface NeteaseSong {
  id?: number;
  name?: string;
  ar?: { name?: string }[];
  al?: { name?: string; picUrl?: string };
  dt?: number;
  fee?: number;
  privilege?: { pl?: number };
}

export interface NeteaseOptions {
  /** 自建 NeteaseCloudMusicApi 的地址 */
  baseUrl?: string;
  /** 已登录账号的 cookie。没有它就只能查不能播 */
  cookie?: string;
  timeoutMs?: number;
}

export class NeteaseProvider implements MusicProvider {
  readonly name = "netease" as const;
  readonly capabilities: ProviderCapabilities;

  private baseUrl: string;
  private cookie?: string;
  private timeoutMs: number;
  private cache = new Map<string, ResolveResult | null>();

  constructor(opts: NeteaseOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
    this.cookie = opts.cookie?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 8000;

    this.capabilities = {
      // 网易云没有「30 秒试听」这个概念，要么整曲要么没有
      preview: false,
      // 没有 cookie 就一首都播不了，如实上报 —— 启动横幅会显示 整曲=✗
      fullPlayback: Boolean(this.cookie),
      userLibrary: false,
    };
  }

  private async get(route: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.baseUrl + route);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // 这套服务接受 cookie 作为普通查询参数，不需要真的走 Cookie 头
    if (this.cookie) url.searchParams.set("cookie", this.cookie);
    // 网易云对同一 IP 的重复请求有缓存，加时间戳绕开陈旧结果
    url.searchParams.set("timestamp", String(Date.now()));

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`NeteaseCloudMusicApi ${res.status} ${res.statusText}`);
    return res.json();
  }

  private async query(term: string, limit: number): Promise<NeteaseSong[]> {
    // cloudsearch 而不是 search：前者才带 al.picUrl 和 privilege
    const body = await this.get("/cloudsearch", {
      keywords: term,
      type: "1",
      limit: String(limit),
    });
    return body?.result?.songs ?? [];
  }

  /** privilege.pl 是当前账号能播的码率，0 = 播不了 */
  private static playable(s: NeteaseSong): boolean {
    return (s.privilege?.pl ?? 0) > 0;
  }

  private toTrack(s: NeteaseSong): Track | null {
    const artist = (s.ar ?? []).map((a) => a.name).filter(Boolean).join(" / ");
    if (!s.id || !s.name || !artist) return null;
    return {
      providerId: String(s.id),
      provider: this.name,
      title: s.name,
      artist,
      album: s.al?.name,
      // 网易云的图片 CDN 支持缩放参数，别拉原图
      artworkUrl: s.al?.picUrl ? `${s.al.picUrl}?param=600y600` : undefined,
      durationMs: s.dt,
      previewUrl: undefined,
      fullPlayback: undefined, // 由 attachPlayback 填
      externalUrl: `https://music.163.com/#/song?id=${s.id}`,
    };
  }

  /**
   * 换取真实播放直链。拿不到就保持 fullPlayback = undefined ——
   * 这不是失败，是「这首歌存在但你没权限听」，上层照样应该把它显示出来。
   */
  private async attachPlayback(track: Track): Promise<Track> {
    if (!this.cookie) return track;
    try {
      const body = await this.get("/song/url/v1", {
        id: track.providerId,
        level: "standard",
      });
      const url = body?.data?.[0]?.url;
      if (typeof url === "string" && url) {
        // 接口偶尔返回 http 直链，页面是 https，混合内容会被浏览器拦掉
        track.fullPlayback = { kind: "url", ref: url.replace(/^http:/, "https:") };
      }
    } catch {
      // 换链失败不影响这首歌已经匹配成功这件事
    }
    return track;
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
   * 两趟匹配，与 iTunes provider 同构：
   *   第一趟 —— 艺人 + 歌名，曲名和艺人都要达标 => exact
   *   第二趟 —— 只用歌名，放宽艺人 => alternate
   * 两趟都空才判幻觉。
   */
  private async resolveUncached(q: TrackQuery): Promise<ResolveResult | null> {
    const wantTitle = normalize(q.title);
    const wantArtist = normalize(q.artist);
    if (!wantTitle) return null;

    const pick = (songs: NeteaseSong[], requireArtist: boolean) => {
      let best: { track: Track; artistScore: number; score: number } | null = null;
      for (const s of songs) {
        const t = this.toTrack(s);
        if (!t) continue;
        const gotTitle = normalize(t.title);
        const titleScore = similarity(wantTitle, gotTitle);
        if (titleScore < TITLE_THRESHOLD) continue;
        if (!requireArtist && lengthRatio(wantTitle, gotTitle) < ALT_LENGTH_FLOOR) continue;
        const artistScore = similarity(wantArtist, normalize(t.artist));
        if (requireArtist && artistScore < ARTIST_THRESHOLD) continue;
        // 曲名权重更高：艺人字段常含合唱者，噪声比曲名大
        const score =
          titleScore * 0.7 +
          artistScore * 0.3 +
          (NeteaseProvider.playable(s) ? PLAYABLE_BONUS : 0);
        if (!best || score > best.score) best = { track: t, artistScore, score };
      }
      return best;
    };

    try {
      const hit = pick(await this.query(`${q.artist} ${q.title}`, 12), true);
      if (hit) {
        return { track: await this.attachPlayback(hit.track), confidence: "exact" };
      }
    } catch {
      return null; // 网络失败按解析不到处理，宁可少推荐也不要推错
    }

    try {
      const hit = pick(await this.query(q.title, 20), false);
      if (!hit) return null;
      const track = await this.attachPlayback(hit.track);
      if (hit.artistScore >= ARTIST_THRESHOLD) {
        return { track, confidence: "exact" };
      }
      return {
        track,
        confidence: "alternate",
        note: `曲库里没有 ${q.artist} 的版本，这是 ${track.artist} 的`,
      };
    } catch {
      return null;
    }
  }

  async search(term: string, limit = 10): Promise<Track[]> {
    let songs: NeteaseSong[];
    try {
      songs = await this.query(term, limit);
    } catch {
      return [];
    }
    return songs.map((s) => this.toTrack(s)).filter((t): t is Track => t !== null);
  }
}
