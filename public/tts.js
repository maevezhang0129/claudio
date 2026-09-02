/**
 * 口播合成 —— 阶段③。
 *
 * 用浏览器自带的 Web Speech API，不接任何云 TTS。理由和整个项目一致：
 * 一个私人电台不该为了念两句话去养一个 API key 和一份账单。
 * macOS / iOS 自带的中文声音质量足够撑住「深夜电台」这个气质，
 * 而且完全离线、零延迟。要换云 TTS 的话，替换点只有这一个文件。
 *
 * 两个时机，对应 DJ 输出契约里的两个字段：
 *   say   —— 这一轮的口播正文，回复到达时念
 *   segue —— 一句指向下一次的过渡，整个队列播完时念
 * 这就是电台的节奏：先说话，再放歌，放完留个钩子。
 */

/** 说话时把音乐压到这个音量，说完还原 —— 真实电台的 ducking */
const DUCK_VOLUME = 0.15;
const RESTORE_MS = 220;

let voice = null;
let enabled = false;
let primed = false;
let duckTarget = null;
let restoreTimer = null;

/**
 * macOS 的「趣味语音」。Eddy / Flo / Grandma / Grandpa / Reed / Rocko /
 * Sandy / Shelley 是 Ventura 起加进来的卡通声线，它们和正经播报声音
 * 混在同一份列表里，而且按字母序排在最前面 ——
 * 原来这里取「第一个中文语音」，于是每次都选中 Eddy。
 * 深夜电台配一个卡通音，听起来当然像机器。
 */
const NOVELTY = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|bells|bubbles|jester|organ|superstar|trinoids|whisper|wobble|zarvox|boing|bad news|good news)\b/i;

/** 苹果的高质量语音。装了才会出现，名字里带这些词 */
const PREMIUM = /(siri|premium|enhanced|neural|增强|优质)/i;

/**
 * 给一个语音打分，越高越优先。
 *
 * 排序而不是写死某一个名字：每台机器装了什么不一样，
 * 而且用户可以随时去系统设置里下载更好的声音，下载完这里要能自动用上。
 */
function score(v) {
  let n = 0;
  if (PREMIUM.test(v.name)) n += 100;   // 装了高质量语音就一定用它
  if (NOVELTY.test(v.name)) n -= 50;    // 卡通音排到最后
  if (v.lang === "zh-CN") n += 10;      // 简体优先于繁体/粤语
  else if (v.lang?.startsWith("zh")) n += 5;
  if (v.default) n += 1;
  return n;
}

/** 所有中文语音，按推荐程度排好 —— 界面上的选择器直接用这个顺序 */
export function chineseVoices() {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices()
    .filter((v) => v.lang && v.lang.toLowerCase().startsWith("zh"))
    .sort((a, b) => score(b) - score(a));
}

/**
 * 选一个中文声音。
 * getVoices() 在部分浏览器上首次调用返回空数组，要等 voiceschanged，
 * 所以这里做成幂等的，可以反复调。
 */
function pickVoice() {
  const all = chineseVoices();
  if (!all.length) return null;
  // 用户明确选过的优先，其次才是评分最高的
  let saved = null;
  try { saved = localStorage.getItem("claudio.voice"); } catch { /* 隐私模式 */ }
  return all.find((v) => v.name === saved) ?? all[0];
}

export const tts = {
  get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  },

  get enabled() {
    return enabled;
  },

  /**
   * 绑定被压音量的那个 <audio>。
   * TTS 不该知道播放器长什么样，只需要一个能调音量的东西。
   */
  attach(audioEl) {
    duckTarget = audioEl;
  },

  /** 当前用的声音名，界面上要显示 */
  get voiceName() {
    return voice?.name ?? null;
  },

  /** 换一个声音并记住。传 null 表示回到自动挑选。 */
  setVoice(name) {
    try {
      if (name) localStorage.setItem("claudio.voice", name);
      else localStorage.removeItem("claudio.voice");
    } catch { /* 隐私模式下记不住，但本次仍然生效 */ }
    voice = pickVoice();
  },

  /** 试听一句，用来比较不同声音 */
  preview(line = "深夜十一点，给你四首。") {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(line);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },

  init() {
    if (!this.supported) return;
    voice = pickVoice();
    // 声音列表异步到达是常态，不是异常
    speechSynthesis.addEventListener("voiceschanged", () => {
      voice = pickVoice();
    });
  },

  /**
   * 开关。必须由用户点击触发 ——
   * iOS Safari 只在用户手势里允许第一次 speak()，
   * 之后才能在任意时刻说话。这里借开关那一下手势把它解锁掉。
   */
  setEnabled(on) {
    enabled = Boolean(on);
    if (!enabled) {
      this.cancel();
      return;
    }
    if (!primed && this.supported) {
      // 念一个空串：不出声，但足以在 iOS 上完成解锁
      try {
        speechSynthesis.speak(new SpeechSynthesisUtterance(""));
        primed = true;
      } catch {
        // 解锁失败不影响桌面端
      }
    }
  },

  /** 念一句。没开、不支持、空文本都安静跳过。 */
  speak(text) {
    if (!enabled || !this.supported) return;
    const line = String(text ?? "").trim();
    if (!line) return;

    const u = new SpeechSynthesisUtterance(line);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    // 比默认稍慢一点。默认语速念中文太赶，不像深夜电台。
    u.rate = 0.95;
    u.pitch = 1;

    u.onstart = () => duck(true);
    u.onend = () => duck(false);
    u.onerror = () => duck(false);

    // 新的一句永远盖掉上一句 —— 电台不会两个人同时说话
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },

  cancel() {
    if (!this.supported) return;
    speechSynthesis.cancel();
    duck(false);
  },
};

function duck(on) {
  if (!duckTarget) return;
  clearTimeout(restoreTimer);
  if (on) {
    duckTarget.volume = DUCK_VOLUME;
    return;
  }
  // 稍等一下再还原，避免最后一个音节被音乐盖住
  restoreTimer = setTimeout(() => {
    duckTarget.volume = 1;
  }, RESTORE_MS);
}
