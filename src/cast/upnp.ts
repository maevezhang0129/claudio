/**
 * UPnP / DLNA 外放 —— 阶段③。
 *
 * 把这个电台从「戴着耳机对着笔记本」变成「屋里在放」。
 * 目标设备是家里已经有的 DLNA 渲染器（电视、音箱），不需要买任何东西。
 *
 * 两段协议，都手写，不引依赖：
 *   1. 发现 —— SSDP，往 239.255.255.250:1900 发一个 UDP M-SEARCH，
 *      谁应答谁就在。
 *   2. 控制 —— AVTransport，往设备的 controlURL POST 一段 SOAP。
 *
 * XML 用正则拆而不是上一个解析器：这里要读的字段是固定的几个，
 * 而整个项目的依赖只有 fastify / zod / sdk 三个，
 * 为了取一个 controlURL 引一棵 XML 解析树不划算。
 * 代价是遇到畸形 XML 会拆不出来 —— 那种情况一律当作「这台设备用不了」。
 *
 * 注意：交给设备的必须是**设备自己能访问到的公网直链**。
 * 本机 https 那张 mkcert 证书对电视没有意义，
 * 好在 iTunes 试听和网易云直链本来就是公网地址，直接转交即可。
 */

import dgram from "node:dgram";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const AVTRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
/** M-SEARCH 找的是渲染器这个设备类型，不是它底下的某个服务 */
const MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";

export interface Device {
  /** 设备描述文件地址，同时用作这台设备的唯一标识 */
  location: string;
  ip: string;
  friendlyName: string;
  /** AVTransport 的控制入口，绝对地址 */
  controlUrl: string;
}

/** 从 XML 里取第一个 <tag> 的文本。取不到返回空串。 */
function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? m[1]!.trim() : "";
}

/**
 * SSDP 发现。
 *
 * 广播天然是「等一段时间，收到几个算几个」——
 * 没有「全部设备都回复了」这种信号，所以只能定时收网。
 * 设备关机、Wi-Fi 隔离、组播被路由器拦掉都表现为「没发现」，不是错误。
 */
export function discover(timeoutMs = 3000): Promise<Device[]> {
  return new Promise((resolve) => {
    const msg = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 2\r\n" +
        `ST: ${MEDIA_RENDERER}\r\n\r\n`,
    );

    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    /** location 去重 —— 同一台设备会对一次 M-SEARCH 应答很多遍 */
    const seen = new Map<string, string>();
    let done = false;

    const finish = async () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* 已经关了 */ }
      const devices = await Promise.all(
        [...seen].map(([location, ip]) => describe(location, ip)),
      );
      resolve(devices.filter((d): d is Device => d !== null));
    };

    sock.on("message", (buf, rinfo) => {
      const loc = /LOCATION:\s*(\S+)/i.exec(buf.toString())?.[1];
      if (loc && !seen.has(loc)) seen.set(loc, rinfo.address);
    });
    // 组播被拒（常见于未授予本地网络权限）不该抛，等同于没发现
    sock.on("error", () => { void finish(); });

    sock.bind(() => {
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR, () => {});
      setTimeout(() => void finish(), timeoutMs);
    });
  });
}

/** 拉设备描述文件，找出 AVTransport 的控制入口 */
async function describe(location: string, ip: string): Promise<Device | null> {
  let xml: string;
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  // 只要 AVTransport 那个 <service> 块 —— 一台设备通常还有
  // ConnectionManager 和 RenderingControl，controlURL 各不相同
  const block = xml
    .split(/<service>/i)
    .find((b) => b.includes(AVTRANSPORT));
  if (!block) return null;

  const control = tag(block, "controlURL");
  if (!control) return null;

  // URLBase 是可选的，没有就拿 location 当基准
  const base = tag(xml, "URLBase") || location;
  let controlUrl: string;
  try {
    controlUrl = new URL(control, base).toString();
  } catch {
    return null;
  }

  return {
    location,
    ip,
    friendlyName: tag(xml, "friendlyName") || ip,
    controlUrl,
  };
}

/** XML 文本转义 —— 曲名里的 & 会让整段 SOAP 报文失效 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function soap(
  device: Device,
  action: string,
  body: string,
  timeoutMs = 6000,
): Promise<string> {
  const envelope =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AVTRANSPORT}">` +
    `<InstanceID>0</InstanceID>${body}` +
    `</u:${action}></s:Body></s:Envelope>`;

  const res = await fetch(device.controlUrl, {
    method: "POST",
    headers: {
      "content-type": 'text/xml; charset="utf-8"',
      SOAPACTION: `"${AVTRANSPORT}#${action}"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    // 设备的报错藏在 <errorDescription> 里，比 HTTP 状态码有用得多
    const why = tag(text, "errorDescription") || `${res.status} ${res.statusText}`;
    throw new Error(`${device.friendlyName} 拒绝了 ${action}：${why}`);
  }
  return text;
}

export interface CastTrack {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
}

/**
 * DIDL-Lite 元数据。不给的话大部分设备照样能播，
 * 但屏幕上只会显示一串 URL —— 对一个「电台」来说那是不可接受的。
 */
function didl(url: string, t: CastTrack): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${esc(t.title)}</dc:title>` +
    `<upnp:artist>${esc(t.artist)}</upnp:artist>` +
    (t.album ? `<upnp:album>${esc(t.album)}</upnp:album>` : "") +
    (t.artworkUrl ? `<upnp:albumArtURI>${esc(t.artworkUrl)}</upnp:albumArtURI>` : "") +
    "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
    `<res protocolInfo="http-get:*:audio/mpeg:*">${esc(url)}</res>` +
    "</item></DIDL-Lite>"
  );
}

/** 投一首歌过去并开始播 */
export async function cast(device: Device, url: string, track: CastTrack): Promise<void> {
  await soap(
    device,
    "SetAVTransportURI",
    `<CurrentURI>${esc(url)}</CurrentURI>` +
      `<CurrentURIMetaData>${esc(didl(url, track))}</CurrentURIMetaData>`,
  );
  await soap(device, "Play", "<Speed>1</Speed>");
}

export async function stop(device: Device): Promise<void> {
  await soap(device, "Stop", "");
}

export async function pause(device: Device): Promise<void> {
  await soap(device, "Pause", "");
}

/** 只读地问一句设备现在在干嘛 —— 用来确认链路通不通，不产生任何声音 */
export async function transportInfo(device: Device): Promise<string> {
  const xml = await soap(device, "GetTransportInfo", "");
  return tag(xml, "CurrentTransportState") || "UNKNOWN";
}
