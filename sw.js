// オフライン対応：一度開いたら電波がなくても使える。
// 通信できるときは最新を取りに行き（ネットワーク優先）、取れないときは保存した版を使う。
const CACHE = "hoikushi-v7";
const CORE = ["./", "index.html", "app.js", "glossary.js", "teacher_keys.js", "manifest.webmanifest", "apple-touch-icon.png",
  "subjects/hoiku-genri.js", "subjects/kyouiku-genri.js", "subjects/shakaiteki-yougo.js", "subjects/kodomo-katei-fukushi.js",
  "subjects/shakai-fukushi.js", "subjects/hoiku-shinri.js", "subjects/kodomo-hoken.js", "subjects/shoku-eiyou.js", "subjects/jisshu-riron.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const font = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== location.origin && !font) return;
  if (font) { // フォントは保存したものを優先
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; })));
    return;
  }
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))));
});
