/**
 * Claudio 前端。
 *
 * 结构上的核心决定：曲目是一条**队列**配一个**常驻播放器**，
 * 不是每首歌各挂一个播放按钮的卡片堆。列表不是电台。
 *
 * 队列持有最近一次推荐；更早的那几轮在对话流里留一行摘要，
 * 点一下可以把那一组重新载入队列。
 */

import { tts } from "./tts.js";

const $ = (id) => document.getElementById(id);

const els = {
  led: $("led"), status: $("status"),
  clock: $("clock"), slot: $("slot"), clockDate: $("clock-date"), slotSrc: $("slot-src"),
  player: $("player"), eq: $("eq"), npTitle: $("np-title"),
  prev: $("prev"), toggle: $("toggle"), next: $("next"),
  tNow: $("t-now"), tTotal: $("t-total"), rail: $("rail"), railFill: $("rail-fill"),
  queueSection: $("queue-section"), queue: $("queue"), queueCount: $("queue-count"),
  feed: $("feed"), intro: $("intro"),
  input: $("input"), send: $("send"),
  audio: $("audio"),
  cast: $("cast"), castPanel: $("cast-panel"),
  viewRadio: $("view-radio"), viewProfile: $("view-profile"),
  brand: $("brand"), back: $("back"), reset: $("reset"), mic: $("mic"),
  sPlayed: $("s-played"), sPeak: $("s-peak"), sRoutines: $("s-routines"),
  pfRecent: $("pf-recent"), pfPlan: $("pf-plan"), planBuild: $("plan-build"),
};

const SESSION = "default";
const state = {
  queue: [],        // 当前队列（最近一次推荐）
  index: -1,        // 正在播的下标，-1 表示无
  busy: false,
  spentUsd: 0,
  model: "",
  clockOffset: 0,   // 服务端时间 - 本地时间
  segue: "",        // 本轮的过渡语，等整组播完再念
  onAirSlot: null,  // 当前正在播出的档名，用来识别换档
};

// ─────────────────────────────── 工具

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // 一律 textContent，不拼 HTML
  return n;
}

/**
 * 这首歌到底放什么。
 *
 * iTunes 给的是 30 秒试听（previewUrl），网易云给的是整曲直链
 * （fullPlayback.ref）。整曲优先 —— 两者同时存在时没理由只放 30 秒。
 * 都没有说明这首歌能查到但没权限听，返回 null，由调用方跳外部链接。
 */
function srcOf(t) {
  if (t.fullPlayback?.kind === "url") return t.fullPlayback.ref;
  return t.previewUrl ?? null;
}

/** 队列上显示的时长。整曲用真实时长，试听恒为 30 秒，播不了显示跳转箭头。 */
function durLabel(t) {
  if (t.fullPlayback?.kind === "url") {
    return t.durationMs ? mmss(t.durationMs / 1000) : "—:—";
  }
  return t.previewUrl ? "0:30" : "↗";
}

function mmss(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function setStatus(kind, text) {
  els.led.className = `led ${kind}`;
  els.status.textContent = text;
  els.status.classList.toggle("live", kind === "live");
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// ─────────────────────────────── 时钟（签名元素）

async function syncClock() {
  try {
    const { epoch, slot, onAir, plan } = await api("/api/now");
    state.clockOffset = epoch - Date.now();
    els.slot.textContent = slot.name;
    // 场景名来自用户语料时才标注来源 —— 兜底时段不值得声张
    els.slotSrc.textContent =
      slot.source === "routines.md" ? `场景取自 routines.md · ${slot.range ?? ""}` : "";
    handoff(onAir, plan);
  } catch {
    els.slotSrc.textContent = "";
  }
}

/**
 * 换档。
 *
 * 服务端每分钟判定一次现在属于哪一档，这里只负责认出「档名变了」。
 * 变了且那一档有排好的节目单，就把队列换成它。
 *
 * 换队列不等于开始播：浏览器本来就不允许无手势自动播放，
 * 而且正在听的东西被时钟打断也很粗暴。所以只做到「预置好、等你按」——
 * 正在播的时候连预置都不做，只在对话流里留一行提示。
 */
function handoff(onAir, plan) {
  if (!onAir) return;
  const first = state.onAirSlot === null;
  if (onAir.slot === state.onAirSlot) return;
  state.onAirSlot = onAir.slot;
  if (first || !plan?.tracks?.length) return;

  const playing = !els.audio.paused && state.index >= 0;
  if (playing) {
    addSlotNotice(onAir.slot, plan);
    return;
  }
  loadQueue(plan.tracks);
  setStatus("live", `${onAir.slot} · 节目单已就绪`);
  addSlotNotice(onAir.slot, plan);
}

/** 对话流里留一行「这一档开播了」，点一下可以手动切过去 */
function addSlotNotice(slot, plan) {
  const row = el("div", "rule");
  row.append(el("span", "lbl", `${slot} 开播 · ${plan.tracks.length} 首`));
  const btn = el("button", "chip", "载入这一档");
  btn.type = "button";
  btn.onclick = () => { loadQueue(plan.tracks); scroll(); };
  row.append(btn);
  els.feed.append(row);
  scroll();
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function tickClock() {
  const d = new Date(Date.now() + state.clockOffset);
  const pad = (n) => String(n).padStart(2, "0");
  els.clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  els.clockDate.textContent =
    `${WEEK[d.getDay()]} · ${pad(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()}`;
}

// ─────────────────────────────── 收听上报
//
// 「进了队列」和「真的听了」是两件事。服务端在推荐时只记前者，
// 后者必须由这里上报 —— 不然第④片会告诉模型「你听过这些」，
// 而其中大部分你从没点开过。
//
// 只累计真正在播的时间：暂停、切到后台都停表，
// 否则挂着一个暂停的播放器整晚会被记成听了八小时。

// 整首曲目都留着，不只留 id —— 上报时要带上曲名和艺人。
// 服务端插入的是一条新的收听记录，它不能假设 plays 表里
// 已经有一条对应的推荐记录：调度器排的节目单、从历史里重新载入的旧队列，
// 都没有那一行。
let listen = { track: null, ms: 0, since: 0 };

/** 换歌。先把上一首结清，再开始给新的一首计时。 */
function beginListen(track) {
  flushListen();
  listen = { track: track ?? null, ms: 0, since: 0 };
}

function resumeListen() {
  if (listen.track && !listen.since) listen.since = Date.now();
}

function pauseListen() {
  if (listen.since) {
    listen.ms += Date.now() - listen.since;
    listen.since = 0;
  }
}

/**
 * 结清并上报。
 *
 * duration 取播放器实际媒体的时长，不是曲目元数据的时长 ——
 * 30 秒试听的元数据时长是整曲的四分钟，按那个算永远不到六成，
 * 试听放到底也会被判成「跳过」。
 */
function flushListen(beacon) {
  pauseListen();
  const { track, ms } = listen;
  listen = { track: null, ms: 0, since: 0 };
  if (!track || ms < 1000) return;   // 一秒都不到的不值得上报

  const durationMs = Number.isFinite(els.audio.duration)
    ? Math.round(els.audio.duration * 1000)
    : undefined;
  const body = JSON.stringify({
    session: SESSION,
    provider: track.provider,
    providerId: track.providerId,
    title: track.title,
    artist: track.artist,
    listenedMs: ms,
    durationMs,
  });

  // 关页面那一下 fetch 会被取消，sendBeacon 不会
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/played", new Blob([body], { type: "application/json" }));
    return;
  }
  api("/api/played", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => { /* 上报失败不该影响播放 */ });
}

// 切后台、关页面都要结清 —— 这两种情况下用户显然停止收听了
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushListen(true);
});
window.addEventListener("pagehide", () => flushListen(true));

// ─────────────────────────────── 播放器 + 队列

function loadQueue(tracks) {
  flushListen();   // 换一整组之前，先把正在听的那首结清
  state.queue = tracks ?? [];
  state.index = -1;
  renderQueue();
  els.queueSection.hidden = state.queue.length === 0;

  if (state.queue.length === 0) {
    els.player.hidden = true;
    return;
  }
  cue(state.queue[0]);
}

/**
 * 把第一首预置进播放器但不播放。
 * 藏起来的话，页面在你点之前看着就是死的 —— 电台总该显示它的播放器。
 */
function cue(t) {
  els.player.hidden = false;
  els.player.classList.add("idle");
  setNowPlaying(t);
  els.tNow.textContent = "0:00";
  els.tTotal.textContent = durLabel(t) === "↗" ? "—:—" : durLabel(t);
  els.railFill.style.width = "0";
  syncTransport();
}

function setNowPlaying(t) {
  els.npTitle.replaceChildren(
    document.createTextNode(t.title),
    Object.assign(el("em"), { textContent: ` — ${t.artist}` }),
  );
}

function renderQueue() {
  els.queue.replaceChildren();
  els.queueCount.textContent =
    `${state.queue.length} ${state.queue.length === 1 ? "TRACK" : "TRACKS"}`;

  let dividerDone = false;
  state.queue.forEach((t, i) => {
    // alternate 全排在末尾，第一首前面画虚线分隔
    if (t.confidence === "alternate" && !dividerDone) {
      dividerDone = true;
      if (i > 0) els.queue.append(ruleRow("没找到原版 · 以下是替代"));
    }

    const row = el("button", t.confidence === "alternate" ? "trk alt" : "trk");
    row.type = "button";
    if (i === state.index) row.classList.add("playing");

    row.append(el("span", "idx", String(i + 1).padStart(2, "0")));

    const body = el("div", "trk-body");
    body.append(el("div", "trk-name", t.title));
    body.append(el("div", "trk-artist",
      t.note ? `${t.artist} · ${t.note}` : `${t.artist}${t.album ? " · " + t.album : ""}`));
    row.append(body);

    row.append(el("span", "dur", durLabel(t)));
    row.onclick = () => play(i);
    els.queue.append(row);
  });
}

function ruleRow(text, warn) {
  const r = el("div", warn ? "rule rule-warn" : "rule");
  r.append(el("span", "lbl", text));
  return r;
}

function play(i) {
  const t = state.queue[i];
  if (!t) return;

  // 放不了的跳外部 App。iTunes 理论上都有试听；网易云则是版权受限的常态。
  const src = srcOf(t);
  if (!src) {
    if (t.externalUrl) window.open(t.externalUrl, "_blank", "noopener");
    return;
  }

  if (state.index === i) {           // 点当前曲目 = 播放/暂停
    els.audio.paused ? els.audio.play().catch(() => {}) : els.audio.pause();
    return;
  }

  state.index = i;
  beginListen(t);
  els.player.hidden = false;
  els.player.classList.remove("idle");
  setNowPlaying(t);
  els.audio.src = src;
  els.audio.play().catch(() => {});
  renderQueue();
  syncTransport();
}

function step(delta) {
  if (!state.queue.length) return;
  const next = state.index + delta;
  if (next < 0 || next >= state.queue.length) return;
  play(next);
}

function syncTransport() {
  const playing = !els.audio.paused && state.index >= 0;
  els.toggle.textContent = playing ? "❚❚" : "▶";
  els.eq.classList.toggle("on", playing);
  els.prev.disabled = state.index <= 0;
  els.next.disabled = state.queue.length === 0 || state.index >= state.queue.length - 1;
}

els.toggle.onclick = () => {
  if (state.index < 0) return play(0);
  els.audio.paused ? els.audio.play().catch(() => {}) : els.audio.pause();
};
els.prev.onclick = () => step(-1);
els.next.onclick = () => step(1);
if (els.cast) els.cast.onclick = openCast;

els.audio.addEventListener("timeupdate", () => {
  els.tNow.textContent = mmss(els.audio.currentTime);
  if (els.audio.duration) {
    els.railFill.style.width = `${(els.audio.currentTime / els.audio.duration) * 100}%`;
    els.tTotal.textContent = mmss(els.audio.duration);
  }
});
els.audio.addEventListener("play", () => { resumeListen(); syncTransport(); });
els.audio.addEventListener("pause", () => { pauseListen(); syncTransport(); });
els.audio.addEventListener("ended", () => {
  flushListen();   // 放到底了，先把这一首结清再往下走
  // 电台会接着往下播
  if (state.index < state.queue.length - 1) return step(1);
  syncTransport();
  els.railFill.style.width = "0";
  // 整组播完了才念 segue —— 它是「指向下一次」的钩子，
  // 跟在每首歌后面念就成了念稿子，那不是电台的节奏。
  if (state.segue) tts.speak(state.segue);
});

els.rail.onclick = (e) => {
  if (!els.audio.duration) return;
  const r = els.rail.getBoundingClientRect();
  els.audio.currentTime = ((e.clientX - r.left) / r.width) * els.audio.duration;
};

// ─────────────────────────────── 外放（UPnP）
//
// 发现要等 3 秒 UDP 广播，所以点开面板才发现，不在启动时抢跑。

async function openCast() {
  if (!els.castPanel) return;
  const panel = els.castPanel;
  if (!panel.hidden) { panel.hidden = true; return; }

  panel.hidden = false;
  panel.replaceChildren(el("span", "pf-empty", "正在找设备…"));
  try {
    const { devices } = await api("/api/cast/devices");
    if (!devices.length) {
      panel.replaceChildren(el("span", "pf-empty",
        "没找到 DLNA 设备。确认它开着、和这台机器在同一个网段。"));
      return;
    }
    panel.replaceChildren();
    for (const d of devices) {
      const b = el("button", "chip", d.friendlyName);
      b.type = "button";
      b.onclick = () => castCurrent(d);
      panel.append(b);
    }
  } catch (e) {
    panel.replaceChildren(el("span", "pf-empty", e.message));
  }
}

async function castCurrent(device) {
  const t = state.queue[state.index] ?? state.queue[0];
  const src = t ? srcOf(t) : null;
  if (!t || !src) {
    els.castPanel.replaceChildren(el("span", "pf-empty", "这首没有可投的音频源。"));
    return;
  }
  els.castPanel.replaceChildren(el("span", "pf-empty", `正在投到 ${device.friendlyName}…`));
  try {
    await api("/api/cast/play", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        location: device.location, url: src,
        title: t.title, artist: t.artist,
        album: t.album, artworkUrl: t.artworkUrl,
      }),
    });
    // 声音已经交给设备了，本机就该闭嘴 —— 否则同一首歌在屋里放两遍。
    // 之后的收听发生在电视上，这边统计不到，所以先结清本机这一段。
    els.audio.pause();
    flushListen();
    els.castPanel.replaceChildren(el("span", "pf-empty",
      `已投到 ${device.friendlyName}。本机已停止播放。`));
  } catch (e) {
    els.castPanel.replaceChildren(el("span", "pf-empty", e.message));
  }
}

// ─────────────────────────────── 对话流

function addUser(text) {
  els.intro?.remove();
  const turn = el("div", "turn turn-me");
  const body = el("div", "turn-body");
  body.append(el("div", "say", text));
  turn.append(body);
  els.feed.append(turn);
  scroll();
}

function addDJ(r, opts = {}) {
  els.intro?.remove();
  const turn = el("div", "turn");
  turn.append(el("span", "av av-sm", "C"));

  const body = el("div", "turn-body");
  const meta = el("div", "turn-meta");
  meta.append(el("span", "lbl", "Claudio"));
  if (opts.at) meta.append(el("span", "rd", opts.at));
  body.append(meta);
  body.append(el("div", "say", r.say));

  // 历史轮次：留一行摘要，点一下把这一组重新载入队列
  if (r.tracks?.length && !opts.current) {
    const recall = el("button", "chip",
      `${r.tracks.length} 首 · ${r.tracks.map((t) => t.title).join(" / ")}`);
    recall.type = "button";
    recall.onclick = () => { loadQueue(r.tracks); scroll(); };
    body.append(recall);
  }

  if (r.reason) body.append(el("div", "reason", r.reason));
  if (r.segue) body.append(el("div", "segue", r.segue));

  const notes = [];
  if (r.dropped > 0) notes.push(`${r.dropped} 首没能在曲库里找到`);
  if (r.unplayable > 0) notes.push(`${r.unplayable} 首曲库里有但放不出声`);
  if (r.trimmed > 0) notes.push(`${r.trimmed} 首只有替代版本，已略去`);
  if (notes.length) body.append(el("div", "lbl", notes.join("，") + "，已跳过"));

  // 「这一轮带来了几首你库里没有的」—— 这是电台相对随机播放的全部价值，
  // 所以它值得一个独立的、看得见的数字，而不是混在跳过提示里。
  if (typeof r.fresh === "number" && r.tracks?.length) {
    body.append(el("div", "lbl fresh",
      r.fresh > 0 ? `${r.fresh} 首来自曲库之外` : "全部来自你的曲库"));
  }

  turn.append(body);
  els.feed.append(turn);

  if (opts.current) {
    loadQueue(r.tracks);
    state.segue = r.segue ?? "";
    tts.speak(r.say);   // 先说话，再放歌
    // 直接开播第一首。这一轮是你按下发送键换来的，
    // 那次点击就是浏览器要的用户手势，所以这里 play() 不会被拦。
    // （换档那条路没有手势，只能预置不能开播。）
    if (r.tracks?.length) play(0);
  }
  scroll();

  // 只有**刚发生**的这一轮才动状态灯。
  // 重放历史时不能碰它：状态灯说的是「此刻连着谁」，
  // 而历史里那条 model 说的是「当时连的是谁」。混为一谈的话，
  // 会话里只要有过一条 stub 记录，页面一加载就会显示「离线」——
  // 尽管 /api/health 明明返回着真实模型。
  if (opts.current && r.usage) {
    state.spentUsd += r.usage.estimatedUsd ?? 0;
    paintStatus();
  }
}

/** 状态灯 = 当前连接的模型 + 本次会话累计花费 */
function paintStatus() {
  if (!state.model) return;
  setStatus("live", `${state.model} · $${state.spentUsd.toFixed(4)}`);
}

function addError(text, retry) {
  const box = el("div", "error");
  box.append(el("div", null, text));
  if (retry) {
    const btn = el("button", "chip", "重试");
    btn.type = "button";
    btn.onclick = () => { box.remove(); ask(retry); };
    box.append(btn);
  }
  els.feed.append(box);
  scroll();
}

function scroll() {
  // 滚动容器是 .view，不是 .feed —— 时钟和队列跟着一起滚
  const view = els.viewRadio;
  requestAnimationFrame(() => view.scrollTo({ top: view.scrollHeight, behavior: "smooth" }));
}

// ─────────────────────────────── 提问

async function ask(text) {
  const msg = text.trim();
  if (state.busy || !msg) return;
  state.busy = true;
  els.send.disabled = true;
  setStatus("busy", "思考中");
  addUser(msg);
  els.input.value = "";

  try {
    const data = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, session: SESSION }),
    });
    addDJ(data, { current: true });
  } catch (e) {
    addError(e.message, msg);
    setStatus("error", "出错了");
  } finally {
    state.busy = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

els.send.onclick = () => ask(els.input.value);
els.input.onkeydown = (e) => { if (e.key === "Enter") ask(els.input.value); };
document.addEventListener("click", (e) => {
  if (e.target.matches("#quick .chip")) ask(e.target.textContent);
});

// ─────────────────────────────── 历史恢复

async function restore() {
  try {
    const { turns } = await api(`/api/history?session=${SESSION}`);
    if (!turns.length) return;
    els.intro?.remove();

    let lastPayload = null;
    for (const t of turns) {
      const at = new Date(t.createdAt);
      const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      if (t.role === "user") addUser(t.content);
      else if (t.payload) {
        addDJ(t.payload, { at: hhmm });
        // 历史花费在这里一次性加总。放在 addDJ 里的话，
        // 每刷新一次页面就会把整段历史再累加一遍，金额越刷越大。
        state.spentUsd += t.payload.usage?.estimatedUsd ?? 0;
        lastPayload = t.payload;
      }
      else addDJ({ say: t.content }, { at: hhmm });
    }
    // 最后一轮的曲目装进队列，接着上次听
    if (lastPayload?.tracks?.length) loadQueue(lastPayload.tracks);
  } catch {
    // 恢复失败不该挡住使用
  }
}

// ─────────────────────────────── 资料页

function showProfile(on) {
  els.viewRadio.hidden = on;
  els.viewProfile.hidden = !on;
  if (on) loadProfile();
}

/**
 * 今日节目单。
 *
 * 读是免费的（纯查库），所以打开资料页就拉一次；
 * 排期要花钱（一档一次模型调用），所以必须点按钮才发生。
 */
async function loadPlan() {
  if (!els.pfPlan) return;
  try {
    const { plan } = await api("/api/plan/today");
    renderPlan(plan ?? []);
  } catch {
    els.pfPlan.replaceChildren(el("span", "pf-empty", "节目单读不到。"));
  }
}

function renderPlan(plan) {
  if (!plan.length) {
    els.pfPlan.replaceChildren(el("span", "pf-empty", "今天还没有排期。"));
    return;
  }
  els.pfPlan.replaceChildren();
  for (const p of plan) {
    const row = el("div", "plan-row");
    const head = el("div", "plan-head");
    head.append(el("span", "lbl", p.slot ?? ""));
    head.append(el("span", "rd", p.payload?.range ?? ""));
    row.append(head);
    const names = (p.payload?.tracks ?? []).map((t) => `${t.artist} - ${t.title}`);
    row.append(el("div", "plan-tracks",
      names.length ? names.join(" · ") : "这一档没排出能播的歌"));
    // 点一下把这一档载进队列 —— 节目单不是只能看的
    if (p.payload?.tracks?.length) {
      row.style.cursor = "pointer";
      row.onclick = () => { loadQueue(p.payload.tracks); showProfile(false); };
    }
    els.pfPlan.append(row);
  }
}

async function loadProfile() {
  loadPlan();
  try {
    const p = await api("/api/profile");
    els.sPlayed.textContent = p.played.toLocaleString();
    els.sPeak.textContent = p.peakHour == null ? "—" : `${String(p.peakHour).padStart(2, "0")}:00`;
    els.sRoutines.textContent = String(p.routines);
  } catch { /* 数字取不到就留破折号 */ }

  try {
    const { turns } = await api(`/api/history?session=${SESSION}`);
    const seen = new Set();
    const recent = [];
    for (let i = turns.length - 1; i >= 0 && recent.length < 8; i--) {
      for (const t of turns[i].payload?.tracks ?? []) {
        const key = `${t.artist}·${t.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recent.push(t);
        if (recent.length >= 8) break;
      }
    }
    els.pfRecent.replaceChildren();
    if (!recent.length) {
      els.pfRecent.append(el("span", "pf-empty", "还没有播放记录。"));
    } else {
      for (const t of recent) {
        els.pfRecent.append(el("div", "pf-item", `${t.title} — ${t.artist}`));
      }
    }
  } catch { /* 同上 */ }
}

els.brand.onclick = () => showProfile(true);
els.back.onclick = () => showProfile(false);
els.reset.onclick = async () => {
  await api(`/api/session/${SESSION}`, { method: "DELETE" }).catch(() => {});
  location.reload();
};

// ─────────────────────────────── 启动

(async function boot() {
  await syncClock();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(syncClock, 60_000);   // 场景名可能跨段变化

  try {
    const h = await api("/api/health");
    state.model = h.model;
    setStatus(h.hasApiKey ? "live" : "error", h.hasApiKey ? h.model : "未配置 API key");
  } catch {
    setStatus("error", "服务未响应");
  }

  await restore();
  paintStatus();   // 历史加载完，用当前连接的模型重画一次
  syncTransport();
  registerSW();
  initMic();

  if (els.planBuild) {
    els.planBuild.onclick = async () => {
      els.planBuild.disabled = true;
      els.planBuild.textContent = "排期中…";
      try {
        const { plan } = await api("/api/plan/today", { method: "POST",
          headers: { "content-type": "application/json" }, body: "{}" });
        renderPlan((plan ?? []).map((p) => ({ slot: p.slot, payload: p })));
      } catch (e) {
        els.pfPlan.replaceChildren(el("span", "pf-empty", e.message));
      } finally {
        els.planBuild.disabled = false;
        els.planBuild.textContent = "排今天的期";
      }
    };
  }
})();

/**
 * 口播开关。
 *
 * 默认关：一打开页面就有人说话是很唐突的。开关状态记在 localStorage，
 * 但**不做自动恢复播报** —— iOS 只在用户手势里允许第一次 speak()，
 * 所以恢复的只是开关的样子，真正解锁要等用户自己点一下。
 */
function initMic() {
  if (!els.mic) return;
  if (!tts.supported) {
    els.mic.hidden = true;
    return;
  }
  tts.init();
  tts.attach(els.audio);

  const saved = localStorage.getItem("claudio.mic") === "on";
  paintMic(saved);
  if (saved) tts.setEnabled(true);

  els.mic.onclick = () => {
    const next = !tts.enabled;
    tts.setEnabled(next);
    paintMic(next);
    localStorage.setItem("claudio.mic", next ? "on" : "off");
  };
}

function paintMic(on) {
  els.mic.classList.toggle("on", on);
  els.mic.setAttribute("aria-pressed", String(on));
}

/**
 * 注册 Service Worker。只在安全上下文下可用 ——
 * http://<局域网IP> 会静默拿不到 navigator.serviceWorker，
 * 所以这里不当作错误，跑 npm run certs 换成 https 就自动生效了。
 */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // 注册失败不影响任何功能，PWA 装不了而已
  });
}
