/** Provider 注册表。加新音源只在这里加一个 case。 */

import type { MusicProvider, ProviderName } from "./types.ts";
import { ITunesProvider } from "./itunes.ts";
import { NeteaseProvider } from "./netease.ts";
import { MixedProvider } from "./mixed.ts";

export interface ProviderConfig {
  name: ProviderName;
  itunesStorefront?: string;
  neteaseBaseUrl?: string;
  neteaseCookie?: string;
}

export function createMusicProvider(cfg: ProviderConfig): MusicProvider {
  switch (cfg.name) {
    case "itunes":
      return new ITunesProvider({ storefront: cfg.itunesStorefront });

    case "applemusic":
      // 阶段②：MusicKit JS，需要 Apple Developer Program 签发的 developer token。
      // 复用 iTunes 的 trackId 作为 catalog id，曲库匹配逻辑可以直接继承。
      throw new Error(
        "applemusic provider 尚未实现（阶段②）。需要 Apple Developer Program 会员资格签发 developer token。",
      );

    case "mixed":
      // 网易云认歌 + iTunes 出声。两边的强项正好互补，见 mixed.ts 顶部的实测数据。
      return new MixedProvider({
        itunesStorefront: cfg.itunesStorefront,
        neteaseBaseUrl: cfg.neteaseBaseUrl,
        neteaseCookie: cfg.neteaseCookie,
      });

    case "netease":
      // 自建 NeteaseCloudMusicApi。华语曲库最全，但接口是逆向的、随时可能失效，
      // 且不带已登录 cookie 时几乎全部歌曲都拿不到播放直链。
      return new NeteaseProvider({
        baseUrl: cfg.neteaseBaseUrl,
        cookie: cfg.neteaseCookie,
      });
  }
}

export * from "./types.ts";
