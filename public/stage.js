/**
 * 大屏播放画面。
 *
 * 电脑、横放的平板上，Claudio 大部分时间是放在一边的氛围屏，
 * 偶尔才有人走过来切歌或说句话。所以这块画面平时只有画、字和歌单，
 * 操作栏动一下鼠标 / 点一下屏幕才浮出来，几秒不动又退下去。
 *
 * 操作栏里的按钮、输入框、状态灯**不是复制品**：进入大屏时把手机布局里
 * 那几块 DOM 整块搬过来，退出时搬回原位。和悬浮窗同一个做法 ——
 * app.js 里的 els 引用和已绑好的监听器全都继续有效，两边不会不同步。
 *
 * 手机界面不受影响：窄屏时这里什么都不做，stage 本身由 CSS 藏起来。
 */

import { SCENES, periodOf } from "./scenes.js";

/** 和 style.css 里的 @media 写的是同一个条件，改一处必须改另一处 */
const WIDE = "(min-width: 960px) and (orientation: landscape)";
/** 歌单从三列变四列的宽度，同样和 style.css 里 .st-tracks 的 @media 对应 */
const FOUR_COLS = "(min-width: 1700px)";

/** 操作栏无动作多久后退下 */
const IDLE_MS = 4000;
/** DJ 刚说完话时多留一会儿，让人看得完那句话 */
const SAY_MS = 12000;

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

/** 歌单一屏最多排几首 —— 参考图是四列两行 */
const GRID = 8;

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // 一律 textContent，不拼 HTML
  return n;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {object} hooks
 * @param {(i: number) => void} hooks.onPlay      点歌单里某一首
 * @param {() => void}          hooks.onProfile   点左上角署名
 * @param {() => boolean}       hooks.keepAwake   为 true 时操作栏不退下（比如 DJ 正在想）
 */
export function createStage({ onPlay, onProfile, keepAwake }) {
  const stage = $("stage");
  const dock = $("st-dock");
  const photos = [$("st-photo-a"), $("st-photo-b")];
  const cover = $("st-cover");
  const tracks = $("st-tracks");
  const sayBox = $("st-say");
  const wave = $("st-wave");
  const mq = window.matchMedia(WIDE);

  // ── 搬家：手机布局里的哪几块，搬进操作栏的哪个位置
  //
  // 每一块在原位留一个注释节点当书签，搬回去时插回书签后面。
  // 不靠「原父节点 + 下一个兄弟」，那个兄弟本身也可能被搬走。
  const moves = [
    [".status",       "st-status-slot"],
    [".transport",    "st-tp-slot"],
    [".np",           "st-np-slot"],
    [".scrub",        "st-np-slot"],
    ["#cast-panel",   "st-cast-slot"],
    [".composer",     "st-in-slot"],
    ["#quick",        "st-in-slot"],
  ].map(([sel, slot]) => {
    const node = document.querySelector(sel);
    const mark = document.createComment(`stage:${sel}`);
    node.before(mark);
    return { node, mark, slot: $(slot) };
  });

  function relocate(wide) {
    for (const m of moves) {
      if (wide) m.slot.append(m.node);
      else m.mark.after(m.node);
    }
    if (!wide) { sleep(true); return; }
    sizeWave();
    paintWave(null);
    // 窄屏时照片和封面都没下载（见 showScene / paintCover），转成横屏才补上
    paintCover();
    if (lastFile === null) showScene();
    setQueue(shown.queue, shown.index);   // 窄屏时按默认列数排的，按真实列数重排
    makeRoom();
  }

  // ── 背景照片：每首歌换一张，在当前时段那一组里轮着来
  //
  // 两层 <img> 交替淡入淡出。照片是自己仓库里的文件，
  // 但照样走 img.src 而不是 CSS background —— 跟封面一个写法，
  // 免得以后有人照抄这段去放外部地址。
  let front = 0;
  let photoToken = 0;
  const decks = { day: [], night: [] };
  let lastFile = null;
  /** 画面上显示的时间属于白天还是晚上，由 tick() 更新 */
  let shownPeriod = null;

  function nextScene(period) {
    if (!decks[period].length) {
      decks[period] = shuffle(SCENES[period]);
      // 洗牌后的第一张恰好是刚放过的那张，就换到末尾，免得连着两首同一张
      if (decks[period][0]?.file === lastFile) decks[period].push(decks[period].shift());
    }
    return decks[period].shift();
  }

  async function showScene() {
    // 窄屏看不见这块画面，不该为它下载照片 —— 一张几百 KB，手机上每切一首歌就是一张
    if (!mq.matches) return;
    // 时段跟着画面上显示的那个时间走（app.js 校准过的服务端时间），不读本机时钟。
    // 两者差一两秒，跨 19:00 那一下就会按本机的 18:59 又挑一张白天的照片
    const period = shownPeriod ?? periodOf(new Date());
    const scene = nextScene(period);
    if (!scene) return;
    lastFile = scene.file;
    const my = ++photoToken;
    const back = photos[1 - front];
    back.src = `/scenes/${scene.file}`;
    try {
      await back.decode();
    } catch {
      return;   // 被下一次切歌抢先换了 src，或文件坏了 —— 都不用管
    }
    if (my !== photoToken) return;
    back.classList.add("on");
    photos[front].classList.remove("on");
    front = 1 - front;
    // 顺手预取下一张，下次切歌时淡入不用等下载
    const peek = decks[period][0];
    if (peek) new Image().src = `/scenes/${peek.file}`;
  }

  // ── 当前曲目：换了才换照片
  //
  // 同一首歌会被设置不止一次（先预置、再开播），只认曲目身份变没变。
  let trackKey = null;
  let current = null;

  /** 封面同样只在大屏上下载。<img> 即使在 display:none 里也会去拉 src */
  function paintCover() {
    const t = current;
    if (!mq.matches || !t) return;
    // 封面地址来自音源接口，是外部数据 —— 只进 img.src，不进任何 CSS 字符串
    if (t.artworkUrl) {
      // 网易云给的是 http 地址，页面是 https，浏览器会报混合内容。两边的 CDN 都支持 https
      cover.src = t.artworkUrl.replace(/^http:\/\//, "https://");
      cover.hidden = false;
    } else {
      cover.removeAttribute("src");   // 置空会让浏览器去请求当前页面
      cover.hidden = true;
    }
    cover.alt = `${t.title} — ${t.artist}`;
  }

  function setTrack(t) {
    if (!t) return;
    current = t;
    paintCover();
    const key = `${t.provider}:${t.providerId}`;
    if (key === trackKey) return;
    // 开机时第一张照片已经在加载了，第一首歌不用再换一张
    const first = trackKey === null;
    trackKey = key;
    if (!first || lastFile === null) showScene();
    // 替代版本要说清楚为什么换了人唱。不弹出操作栏打扰，
    // 只把这句放进 DJ 那一行，下次有人走过来就能看到。
    // 切到原版曲目时再把 DJ 原来那句话放回去 —— 不然说明会一直挂着，
    // 跟正在放的歌对不上，DJ 的话也再看不到了。
    if (t.confidence === "alternate") {
      say(t.note ?? "没找到原版，这是替代版本", { kind: "alt", quiet: true });
    } else if (sayBox.dataset.kind === "alt" && lastSaid) {
      say(lastSaid.text, { ...lastSaid.opts, quiet: true });
    }
  }

  // ── 歌单：两行，列数由 CSS 定（三列，宽屏四列）。
  // 正在放的那首尽量排第一个，后面接着是下几首
  let shown = { queue: [], index: -1 };

  /**
   * 一屏放得下几首：两行 × 列数。
   *
   * 不从布局里读列数 —— 资料页打开时这块画面是 display:none，
   * 那时读到的是没解析的 "repeat(4, …)"，会被当成三列，回来就只剩六首。
   */
  function capacity() {
    return window.matchMedia(FOUR_COLS).matches ? 8 : 6;
  }

  /**
   * 替代版本在歌单里的那行小字。
   *
   * 艺人那一行写的已经是替代者，这里只需要补上原唱是谁。
   * 依赖 itunes.ts / netease.ts 里 note 的固定句式；对不上就原样显示整句。
   */
  function whyShort(t) {
    const m = t.note?.match(/^曲库里没有 (.+) 的版本/);
    if (m) return `原唱 ${m[1]}`;
    return t.note ?? "没找到原版，这是替代版本";
  }

  function setQueue(queue, index) {
    shown = { queue, index };
    tracks.replaceChildren();
    if (!queue.length) return;
    const n = capacity();
    const start = Math.max(0, Math.min(Math.max(index, 0), queue.length - n));
    queue.slice(start, start + n).forEach((t, k) => {
      const i = start + k;
      const b = el("button", "st-trk");
      b.type = "button";
      b.title = `${t.artist} — ${t.title}`;   // 列窄，长歌名会被截断
      if (i === index) b.classList.add("on");
      // 还没开播时，按下播放会放的是第一首 —— 用暗一点的金色标出来
      if (index < 0 && i === 0) b.classList.add("cue");

      const who = el("span", "st-a");
      who.append(el("span", "st-an", t.artist));
      b.append(who);
      b.append(el("span", "st-t", t.title));
      if (t.confidence === "alternate") {
        b.classList.add("alt");
        // 替代版本必须说清楚为什么换了人唱，不能装作匹配上了。
        // 写在歌名下面而不是只放进 title —— 平板上没有悬停提示。
        // 「替代」标签放在这一行开头，不和艺人名挤一行：
        // 四列时它会把替代者的名字挤到被截断，而那个名字恰恰是要看清的。
        const why = el("span", "st-why");
        why.append(el("span", "st-tag", "替代"), document.createTextNode(whyShort(t)));
        b.append(why);
        if (t.note) b.title += `\n${t.note}`;
      }
      b.onclick = () => onPlay(i);
      tracks.append(b);
    });
    fitAll();
  }

  /**
   * 超过两行的文字自己截，补上省略号。
   *
   * CSS 的 -webkit-line-clamp 在 Chrome 里只给左对齐的文字画「…」，
   * 歌单整块是右对齐的，于是 "Tonight, Tonight (Remastered 2012)" 会显示成
   * 「Tonight, / Tonight」，看着像一个完整的歌名。完整文字在按钮的 title 里。
   * 只截最后一个文本节点 —— 「替代」那一行前面还有个标签，标签不能动。
   */
  function fitText(node) {
    if (node.scrollHeight <= node.clientHeight + 1) return;
    const text = [...node.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE);
    if (!text) return;
    const full = text.data;
    const fits = (len) => {
      text.data = `${full.slice(0, len).trimEnd()}…`;
      return node.scrollHeight <= node.clientHeight + 1;
    };
    let lo = 0, hi = full.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    fits(lo);
  }

  /** 看不见的时候量不出高度，什么都不做；等看得见了 ResizeObserver 会再叫一次 */
  function fitAll() {
    if (!isOn()) return;
    for (const n of tracks.querySelectorAll(".st-an, .st-t, .st-why")) fitText(n);
  }

  function setPlaying(on) {
    stage.classList.toggle("playing", on);
  }

  // ── 日期、时间、星期
  //
  // 跨过白天 / 晚上的分界时也换一张照片。照片平时只在切歌时换，
  // 一块开着没在放的屏幕会从下午一直挂着那张阳光满屋的照片到深夜。
  function tick(d) {
    const p = periodOf(d);
    const crossed = shownPeriod !== null && p !== shownPeriod;
    shownPeriod = p;   // 先记下，showScene 按它挑照片
    if (crossed) showScene();
    const pad = (n) => String(n).padStart(2, "0");
    $("st-dd").textContent = pad(d.getDate());
    $("st-mon").textContent = MONTH[d.getMonth()];
    $("st-time").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $("st-week").textContent = WEEKDAY[d.getDay()];
  }

  function setSlot(name) {
    $("st-slotname").textContent = name ?? "";
  }

  // ── DJ 的那一句话
  //
  // 大屏上不留对话历史，只留最近一句。kind 决定前面那个小标签。
  const TAG = { dj: "DJ", wait: "DJ", error: "出错了", notice: "节目单", alt: "替代版本", hint: "" };

  /** 最近一句不是「替代版本说明」的话，切回原版曲目时用来恢复 */
  let lastSaid = null;

  /** quiet：只换字，不把操作栏叫出来 */
  function say(text, { kind = "dj", action, quiet = false } = {}) {
    if (kind !== "alt") lastSaid = { text, opts: { kind, action } };
    sayBox.replaceChildren();
    sayBox.dataset.kind = kind;
    if (TAG[kind]) sayBox.append(el("b", null, TAG[kind]));
    sayBox.append(el("span", null, text));
    if (action) {
      const btn = el("button", "chip", action.label);
      btn.type = "button";
      btn.onclick = () => { action.run(); };
      sayBox.append(btn);
    }
    if (kind !== "hint" && !quiet) wake(kind === "wait" ? IDLE_MS : SAY_MS);
  }

  // ── 频谱：真实音频的频域数据，app.js 每帧把样本递过来
  let dpr = 1;

  function sizeWave() {
    dpr = window.devicePixelRatio || 1;
    const r = wave.getBoundingClientRect();
    if (!r.width) return;
    wave.width = Math.round(r.width * dpr);
    wave.height = Math.round(r.height * dpr);
  }

  /** bins 为 null 时画一排静止的短线，表示「在这儿，但没在响」 */
  function paintWave(bins) {
    if (!wave.width || !isOn()) return;
    const g = wave.getContext("2d");
    const w = wave.width, h = wave.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#F6EFE2";
    const bar = Math.max(1, Math.round(1.5 * dpr));
    const gap = Math.round(3.5 * dpr);
    const count = Math.floor(w / (bar + gap));
    // 低频那几格能量最集中，只取前 60%，和悬浮窗的取法一致
    const used = bins ? Math.floor(bins.length * 0.6) : 0;
    for (let i = 0; i < count; i++) {
      let v = 0.06;
      if (bins) v = Math.max(0.06, bins[Math.floor((i / count) * used)] / 255);
      const bh = Math.max(bar, v * h);
      g.fillRect(i * (bar + gap), h - bh, bar, bh);
    }
  }

  // ── 操作栏的浮出与退下
  let timer = null;
  let overDock = false;

  function isOn() {
    return mq.matches && !stage.hidden && !document.body.classList.contains("pf-open");
  }

  function holding() {
    const input = dock.querySelector("input");
    // 输入框只在里面有字时才留住操作栏。输入框一获得焦点就算 :focus-visible，
    // 而发完消息 app.js 会把焦点放回去 —— 按那个判断，聊一句之后操作栏就再也不退了。
    // 键盘在按钮之间 Tab 时仍然留着，不然焦点走到一半整条栏消失了。
    return overDock
      || Boolean(input?.value.trim())
      || Boolean(dock.querySelector(":focus-visible:not(input)"))
      || !$("cast-panel").hidden
      || Boolean(keepAwake?.());
  }

  /**
   * 操作栏浮起来时给歌单腾地方 —— 兜底用的。
   *
   * 布局本身已经把歌单放在中段，常见尺寸下操作栏碰不到它。
   * 但操作栏高度是固定像素、歌单按视口比例排，960×600 这种矮屏、
   * 或者歌名都折成两行时仍可能盖住第二行，盖住的几首也点不到。
   * 所以量一下真实位置，把歌单往上推刚好够的距离；
   * 推上去还撞到大字或右上角的，被撞的那块先让开。
   * 用 offset* 量，不受 transform 影响，量的是推之前的原位。
   */
  const head = $("st-head");
  const corner = $("st-corner");

  function box(n, dy = 0) {
    return { l: n.offsetLeft, r: n.offsetLeft + n.offsetWidth,
             t: n.offsetTop - dy, b: n.offsetTop + n.offsetHeight - dy };
  }

  function overlaps(a, b, gap) {
    return a.l < b.r + gap && b.l < a.r + gap && a.t < b.b + gap && b.t < a.b + gap;
  }

  function makeRoom() {
    if (!isOn()) return;
    const gap = 16;
    const lift = Math.max(0, tracks.offsetTop + tracks.offsetHeight + gap - dock.offsetTop);
    stage.style.setProperty("--lift", `${lift}px`);
    // 网格是整块宽的，但只量实际排了歌的那几格，空列不算撞
    const cells = [...tracks.children];
    const lifted = cells.map((c) => {
      const r = box(c, lift);
      return { l: r.l + tracks.offsetLeft, r: r.r + tracks.offsetLeft,
               t: r.t + tracks.offsetTop, b: r.b + tracks.offsetTop };
    });
    for (const n of [head, corner]) {
      const hit = lift > 0 && lifted.some((c) => overlaps(c, box(n), gap));
      n.classList.toggle("st-crowd", hit);
    }
  }

  function wake(ms = IDLE_MS) {
    if (!isOn()) return;
    if (!stage.classList.contains("awake")) makeRoom();
    stage.classList.add("awake");
    clearTimeout(timer);
    timer = setTimeout(() => sleep(), ms);
  }

  function sleep(force = false) {
    clearTimeout(timer);
    if (!force && holding()) {
      timer = setTimeout(() => sleep(), IDLE_MS);
      return;
    }
    stage.classList.remove("awake");
    // 操作栏已经看不见了，焦点不能还留在里面 —— 不然打字会打进一个隐形的输入框
    if (dock.contains(document.activeElement)) document.activeElement.blur();
  }

  // 只认鼠标的悬停。平板点过一下之后浏览器会一直认为「还悬停着」，
  // 拿那个判断的话操作栏在平板上永远退不下去。
  dock.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") overDock = true; });
  dock.addEventListener("pointerout", (e) => {
    if (e.pointerType === "mouse" && !dock.contains(e.relatedTarget)) overDock = false;
  });

  for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
    document.addEventListener(type, () => wake(), { passive: true });
  }

  $("st-by").onclick = () => onProfile();

  mq.addEventListener("change", (e) => relocate(e.matches));
  // 窗口一变，列数（跨过 1700px）和字号（按视口算）都可能变，
  // 截过的歌名也要按新宽度重截 —— 整组重排最省事，一屏最多八个按钮
  //
  // 看不见的时候（窄屏、资料页开着）不重排：量不出尺寸，截出来的是错的。
  // 回到这块画面时由 refresh() 补一次。
  function refresh() {
    if (!isOn()) return;
    sizeWave();
    paintWave(null);
    setQueue(shown.queue, shown.index);
    makeRoom();
  }

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(refresh);
  });
  // 网页字体晚到会改变文字宽度，重排一次。资料页第一次打开时也会触发（它用 Doto）
  document.fonts?.addEventListener("loadingdone", refresh);
  // 操作栏和歌单的高度都会变：DJ 说了一句长话、展开了投屏面板、换了一组歌
  new ResizeObserver(() => makeRoom()).observe(dock);
  new ResizeObserver(() => makeRoom()).observe(tracks);

  // 先定时段再搬家：relocate(true) 会挑第一张照片，要按时段挑。
  // 这里用本机时间，app.js 第一次校准后的 tick 如果跨了时段会再换一张
  tick(new Date());
  relocate(mq.matches);
  say("跟我说说你现在想听什么 —— 或者只说你此刻的状态。", { kind: "hint" });

  return { setTrack, setQueue, setPlaying, tick, setSlot, say, paintWave, wake, refresh };
}
