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
 * 挑一个中文声音。
 * getVoices() 在部分浏览器上首次调用返回空数组，要等 voiceschanged，
 * 所以这里做成幂等的，可以反复调。
 */
function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const all = speechSynthesis.getVoices();
  if (!all.length) return null;

  // 优先简体中文；退而求其次任何中文；再退到系统默认
  return (
    all.find((v) => v.lang === "zh-CN") ??
    all.find((v) => v.lang?.startsWith("zh")) ??
    all.find((v) => v.default) ??
    all[0] ??
    null
  );
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
