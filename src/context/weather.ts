/**
 * ③ 环境注入里的天气。阶段③。
 *
 * 选 Open-Meteo 的理由和当初选 iTunes 是同一个：免费、零鉴权、不用注册。
 * 一个私人电台不该为了一句「今天下雨」去管理 API key。
 *
 * 两条硬约束：
 *   1. 天气属于**易变组**。它绝不能进稳定组 —— 一个变动的数值会让
 *      整段缓存前缀作废，代价远超这句话本身的价值。
 *   2. 取不到不是错误。天气是锦上添花，接口挂了、超时了、断网了，
 *      都必须安静降级成「取不到」，让这一轮推荐照常进行。
 */

/** WMO weather code → 中文。模型读的是这句话，不是数字。 */
const WMO: Record<number, string> = {
  0: "晴", 1: "大致晴朗", 2: "多云", 3: "阴",
  45: "有雾", 48: "雾凇",
  51: "毛毛雨", 53: "小雨", 55: "中雨",
  56: "冻毛毛雨", 57: "冻雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
  80: "阵雨", 81: "强阵雨", 82: "暴雨",
  85: "阵雪", 86: "强阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
};

export interface WeatherOptions {
  latitude: number;
  longitude: number;
  timeoutMs?: number;
}

interface Cached {
  text: string;
  at: number;
}

/**
 * 缓存 15 分钟。Open-Meteo 自己的 current 就是 15 分钟一个间隔，
 * 拉得再勤也拿不到新数据，只是白白给每轮对话加一次网络往返。
 */
const TTL_MS = 15 * 60_000;
let cache: Cached | null = null;

/**
 * 返回一句给模型读的天气描述，永不抛异常。
 * 拿不到就返回 null，由调用方决定怎么写这一行。
 */
export async function currentWeather(opts: WeatherOptions): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.text;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(opts.latitude));
  url.searchParams.set("longitude", String(opts.longitude));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code");
  url.searchParams.set("timezone", "Asia/Shanghai");

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number };
    };
    const c = body.current;
    if (!c || typeof c.temperature_2m !== "number") return null;

    const desc = WMO[c.weather_code ?? -1] ?? "未知天况";
    const real = Math.round(c.temperature_2m);
    const feels = typeof c.apparent_temperature === "number"
      ? Math.round(c.apparent_temperature)
      : null;

    // 体感和实测差 3 度以上才提 —— 差不多的时候多一个数字只是噪声，
    // 差得多的时候（湿热、风寒）它恰恰是决定听什么的那个变量。
    const text =
      feels !== null && Math.abs(feels - real) >= 3
        ? `${desc}，${real}°C（体感 ${feels}°C）`
        : `${desc}，${real}°C`;

    cache = { text, at: Date.now() };
    return text;
  } catch {
    return null; // 超时、断网、返回体变形 —— 一律安静降级
  }
}

/** 测试用：清掉缓存 */
export function resetWeatherCache(): void {
  cache = null;
}
