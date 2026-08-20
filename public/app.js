const feed = document.getElementById("feed");
const input = document.getElementById("input");
const send = document.getElementById("send");
const audio = document.getElementById("audio");
const dot = document.getElementById("dot");
const meta = document.getElementById("meta");

const SESSION = "default";
let busy = false;
let spentUsd = 0;
let playingEl = null;

// ---------- 启动握手 ----------
try {
  const h = await (await fetch("/api/health")).json();
  dot.className = "dot live";
  meta.textContent = `${h.model} · ${h.musicProvider}`;
  if (!h.hasApiKey) {
    dot.className = "dot err";
    meta.textContent = "未配置 API key";
  }
} catch {
  dot.className = "dot err";
  meta.textContent = "服务未响应";
}

// ---------- 渲染 ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function scroll() {
  feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
}

function addUser(text) {
  document.querySelector(".intro")?.remove();
  feed.append(el("div", "turn-user", text));
  scroll();
}

function addError(text) {
  feed.append(el("div", "err", text));
  scroll();
}

function trackCard(t) {
  // alternate 视觉上弱化：它排在末尾，是「没找到原版时的替代」，
  // 不该和精确匹配的推荐抢注意力
  const card = el("div", t.confidence === "alternate" ? "track alt" : "track");

  const art = el("img", "art");
  art.src = t.artworkUrl ?? "";
  art.alt = "";
  art.loading = "lazy";

  const info = el("div", "track-info");
  info.append(el("div", "track-title", t.title));
  info.append(el("div", "track-sub", `${t.artist}${t.album ? " · " + t.album : ""}`));
  if (t.confidence === "alternate" && t.note) {
    info.append(el("div", "track-note", "⚠ " + t.note));
  }
  const prog = el("div", "bar-progress");
  info.append(prog);

  const btn = el("button", "play-btn", t.previewUrl ? "▶" : "↗");
  btn.title = t.previewUrl ? "试听 30 秒" : "在 Apple Music 打开";

  card.append(art, info, btn);

  card.onclick = () => {
    if (!t.previewUrl) {
      if (t.externalUrl) window.open(t.externalUrl, "_blank", "noopener");
      return;
    }
    if (playingEl === card) {
      audio.pause();
      return;
    }
    playingEl?.classList.remove("playing");
    playingEl?.querySelector(".play-btn") &&
      (playingEl.querySelector(".play-btn").textContent = "▶");
    playingEl?.querySelector(".bar-progress") &&
      (playingEl.querySelector(".bar-progress").style.width = "0");

    playingEl = card;
    card.classList.add("playing");
    btn.textContent = "❚❚";
    audio.src = t.previewUrl;
    audio.play().catch(() => {
      card.classList.remove("playing");
      btn.textContent = "▶";
      playingEl = null;
    });
  };

  card._progress = prog;
  card._btn = btn;
  return card;
}

audio.addEventListener("timeupdate", () => {
  if (!playingEl?._progress || !audio.duration) return;
  playingEl._progress.style.width = (audio.currentTime / audio.duration) * 100 + "%";
});
for (const ev of ["pause", "ended"]) {
  audio.addEventListener(ev, () => {
    if (!playingEl) return;
    playingEl._btn.textContent = "▶";
    if (ev === "ended") {
      playingEl.classList.remove("playing");
      playingEl._progress.style.width = "0";
      playingEl = null;
    }
  });
}
audio.addEventListener("play", () => {
  if (playingEl) playingEl._btn.textContent = "❚❚";
});

function addDJ(r) {
  const wrap = el("div", "turn-dj");
  wrap.append(el("div", "say", r.say));

  if (r.tracks?.length) {
    const list = el("div", "tracks");
    let dividerDone = false;
    for (const t of r.tracks) {
      // alternate 全排在末尾，在第一首前面画一条分隔线，
      // 让「这些是替代版本」在视觉上一目了然
      if (t.confidence === "alternate" && !dividerDone) {
        dividerDone = true;
        if (list.children.length) list.append(el("div", "divider", "没找到原版，以下是替代"));
      }
      list.append(trackCard(t));
    }
    wrap.append(list);
  }
  if (r.reason) wrap.append(el("div", "reason", r.reason));
  if (r.segue) wrap.append(el("div", "segue", r.segue));

  const notes = [];
  if (r.dropped > 0) notes.push(`${r.dropped} 首没能在曲库里找到`);
  if (r.trimmed > 0) notes.push(`${r.trimmed} 首只有替代版本，已略去`);
  if (notes.length) wrap.append(el("div", "dropped", notes.join("，") + "，已跳过"));

  feed.append(wrap);
  scroll();

  if (r.usage) {
    spentUsd += r.usage.estimatedUsd ?? 0;
    const cache = r.usage.cacheReadTokens > 0 ? " · 缓存命中" : "";
    meta.textContent = `${r.model} · 本次会话 $${spentUsd.toFixed(4)}${cache}`;
  }
}

// ---------- 发送 ----------
async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true;
  send.disabled = true;
  dot.className = "dot busy";
  addUser(text);
  input.value = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session: SESSION }),
    });
    const data = await res.json();
    if (!res.ok) addError(data.error ?? `请求失败（${res.status}）`);
    else addDJ(data);
    dot.className = res.ok ? "dot live" : "dot err";
  } catch (e) {
    addError("网络错误：" + e.message);
    dot.className = "dot err";
  } finally {
    busy = false;
    send.disabled = false;
    input.focus();
  }
}

send.onclick = () => ask(input.value);
input.onkeydown = (e) => { if (e.key === "Enter") ask(input.value); };
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) ask(e.target.textContent);
});
