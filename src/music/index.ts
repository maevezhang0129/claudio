/** Provider 注册表。加新音源只在这里加一个 case。 */

import type { MusicProvider, ProviderName } from "./types.ts";
import { ITunesProvider } from "./itunes.ts";

export interface ProviderConfig {
  name: ProviderName;
  itunesStorefront?: string;
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

    case "netease":
      // 阶段②备选：自建 NeteaseCloudMusicApi。华语曲库最全，
      // 但接口是逆向的、随时可能失效，song_url 大量歌曲受版权限制。
      throw new Error(
        "netease provider 尚未实现（阶段②备选）。需要先自建 NeteaseCloudMusicApi 服务。",
      );
  }
}

export * from "./types.ts";
