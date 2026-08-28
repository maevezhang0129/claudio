/**
 * Service Worker —— 只为一件事存在：让 Claudio 在手机上能装成 PWA。
 *
 * 策略是「网络优先，缓存兜底」，不是常见的缓存优先。原因：
 * 这是个还在改的本地项目，缓存优先会让改完的 app.js 迟迟不生效，
 * 每次都要手动清缓存。网络优先牺牲一点离线首屏速度，换开发时不踩坑。
 *
 * /api/ 一律不碰 —— 推荐、播放记录、时钟都必须是当下的，
 * 拿缓存回答等于撒谎。
 */

const CACHE = "claudio-shell-v1";

/** 应用外壳：装机后即使断网也能把界面画出来（内容仍需要网络） */
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-180.png",
];

self.addEventListener("install", (e) => {
  // 单个资源 404 不该让整次安装失败，所以逐个 add 而不是 addAll
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 只管自己域下的 GET。字体走 CDN、试听走 iTunes CDN，都交给浏览器自己处理。
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // 接口永远走网络，拿不到就让它失败 —— 前端有错误态，会提示重试
  if (url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 顺手更新缓存，下次断网时用的是最新一版外壳
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("/index.html"))),
  );
});
