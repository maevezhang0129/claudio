/**
 * Claudio 前端。
 *
 * 结构上的核心决定：曲目是一条**队列**配一个**常驻播放器**，
 * 不是每首歌各挂一个播放按钮的卡片堆。列表不是电台。
 *
 * 队列持有最近一次推荐；更早的那几轮在对话流里留一行摘要，
 * 点一下可以把那一组重新载入队列。
 */

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
  viewRadio: $("view-radio"), viewProfile: $("view-profile"),
  brand: $("brand"), back: $("back"), reset: $("reset"),
  sPlayed: $("s-played"), sPeak: $("s-peak"), sRoutines: $("s-routines"),
  pfRecent: $("pf-recent"),
};

const SESSION = "default";
const state = {
  queue: [],        // 当前队列（最近一次推荐）
  index: -1,        // 正在播的下标，-1 表示无
  busy: false,
  spentUsd: 0,
  model: "",
  clockOffset: 0,   // 服务端时间 - 本地时间
};

// ─────────────────────────────── 工具

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;   // 一律 textContent，不拼 HTML
  return n;
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
    const { epoch, slot } = await api("/api/now");
    state.clockOffset = epoch - Date.now();
    els.slot.textContent = slot.name;
    // 场景名来自用户语料时才标注来源 —— 兜底时段不值得声张
    els.slotSrc.textContent =
      slot.source === "routines.md" ? `场景取自 routines.md · ${slot.range ?? ""}` : "";
  } catch {
    els.slotSrc.textContent = "";
  }
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

// ─────────────────────────────── 播放器 + 队列

function loadQueue(tracks) {
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
  els.tTotal.textContent = "0:30";
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

    row.append(el("span", "dur", t.previewUrl ? "0:30" : "↗"));
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

  // 没有试听链接的（理论上 iTunes 都有）直接跳转外部
  if (!t.previewUrl) {
    if (t.externalUrl) window.open(t.externalUrl, "_blank", "noopener");
    return;
  }

  if (state.index === i) {           // 点当前曲目 = 播放/暂停
    els.audio.paused ? els.audio.play().catch(() => {}) : els.audio.pause();
    return;
  }

  state.index = i;
  els.player.hidden = false;
  els.player.classList.remove("idle");
  setNowPlaying(t);
  els.audio.src = t.previewUrl;
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

els.audio.addEventListener("timeupdate", () => {
  els.tNow.textContent = mmss(els.audio.currentTime);
  if (els.audio.duration) {
    els.railFill.style.width = `${(els.audio.currentTime / els.audio.duration) * 100}%`;
    els.tTotal.textContent = mmss(els.audio.duration);
  }
});
els.audio.addEventListener("play", syncTransport);
els.audio.addEventListener("pause", syncTransport);
els.audio.addEventListener("ended", () => {
  // 电台会接着往下播
  if (state.index < state.queue.length - 1) step(1);
  else { syncTransport(); els.railFill.style.width = "0"; }
});

els.rail.onclick = (e) => {
  if (!els.audio.duration) return;
  const r = els.rail.getBoundingClientRect();
  els.audio.currentTime = ((e.clientX - r.left) / r.width) * els.audio.duration;
};

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
  if (r.trimmed > 0) notes.push(`${r.trimmed} 首只有替代版本，已略去`);
  if (notes.length) body.append(el("div", "lbl", notes.join("，") + "，已跳过"));

  turn.append(body);
  els.feed.append(turn);

  if (opts.current) loadQueue(r.tracks);
  scroll();

  if (r.usage) {
    state.spentUsd += r.usage.estimatedUsd ?? 0;
    state.model = r.model ?? state.model;
    setStatus("live", `${state.model} · $${state.spentUsd.toFixed(4)}`);
  }
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
      else if (t.payload) { addDJ(t.payload, { at: hhmm }); lastPayload = t.payload; }
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

async function loadProfile() {
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
  syncTransport();
})();
