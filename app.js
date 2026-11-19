(function () {
  const STORE_KEY = "hoikushi-kyouikugenri-v1"; // 初版からの記録を引き継ぐためキー名は据え置き
  const DOC_ID = "kyouiku-genri";
  const KEYS4 = ["A", "B", "C", "D"];
  const KANA = ["ア", "イ", "ウ", "エ", "オ"];
  const DAY = 864e5;
  const ORDER = ["hoiku-genri", "kyouiku-genri", "shakaiteki-yougo", "kodomo-katei-fukushi", "shakai-fukushi",
                 "hoiku-shinri", "kodomo-hoken", "shoku-eiyou", "jisshu-riron"];
  const SUBJ = SUBJECTS.slice().sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const subjById = Object.fromEntries(SUBJ.map(s => [s.id, s]));
  const subjOfQ = {};
  SUBJ.forEach(s => s.questions.forEach(q => { subjOfQ[q.id] = s.id; }));
  const ALL = SUBJ.flatMap(s => s.questions);
  const isExam = q => q.type === "combo" || q.type === "multi" || q.fixed;
  const catOf = q => subjById[subjOfQ[q.id]].categories.find(c => c.id === q.c) || { icon: "", name: "", id: q.c };

  // ---------- local storage (safe) ----------
  // stats: 元の形式での成績 { id: {c, w, last, t} }
  // rv:    復習の段階 { id: {s, d, t} }  s=1 別の形 → 2 元の形式 → 3 翌日（別の形）→ 4 4日後（元の形式）→ 0 卒業
  let stats = {}, rv = {}, resetAt = 0, resets = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
    if (raw.stats) { stats = raw.stats; rv = raw.rv || {}; resetAt = raw.resetAt || 0; resets = raw.resets || {}; }
    else stats = raw;
  } catch (e) { stats = {}; }
  function saveLocal() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ stats, rv, resetAt, resets })); } catch (e) {} }

  const cutoffFor = id => Math.max(resetAt, resets[subjOfQ[id]] || 0);
  function merge(a, b) {
    const out = {};
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(id => {
      const x = a[id], y = b[id];
      let r;
      if (!x) r = y; else if (!y) r = x;
      else {
        const nw = (x.t || 0) >= (y.t || 0) ? x : y;
        r = { c: Math.max(x.c || 0, y.c || 0), w: Math.max(x.w || 0, y.w || 0), last: nw.last, t: nw.t || 0 };
      }
      const cut = cutoffFor(id);
      if (r && (cut === 0 || (r.t || 0) > cut)) out[id] = r;
    });
    return out;
  }
  function mergeRv(a, b) {
    const out = {};
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(id => {
      const x = a[id], y = b[id];
      const r = !x ? y : !y ? x : ((x.t || 0) >= (y.t || 0) ? x : y);
      const cut = cutoffFor(id);
      if (r && (cut === 0 || (r.t || 0) > cut)) out[id] = r;
    });
    return out;
  }
  // 以前の版の記録（直近で不正解）や他の端末の記録から、復習リストを補う
  function syncRv() {
    Object.entries(stats).forEach(([id, s]) => {
      if (s && s.last === false && (!rv[id] || (rv[id].t || 0) < (s.t || 0))) rv[id] = { s: 1, d: s.t || 0, t: s.t || 0 };
    });
  }
  syncRv();
  function absorbMeta(rAt, rs) {
    if ((rAt || 0) > resetAt) resetAt = rAt;
    Object.entries(rs || {}).forEach(([k, v]) => { if ((v || 0) > (resets[k] || 0)) resets[k] = v; });
  }

  // ---------- review cycle ----------
  const STEP_FORM = { 1: "v", 2: "o", 3: "v", 4: "o" };
  const STEP_NAME = { 1: "復習① 別の形で", 2: "復習② 元の形式で", 3: "復習③ 翌日の確認", 4: "復習④ 仕上げ" };
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const inQueue = q => !!(rv[q.id] && rv[q.id].s > 0);
  const isDue = q => inQueue(q) && (rv[q.id].d || 0) <= Date.now();
  const formFor = q => STEP_FORM[rv[q.id].s] || "o";
  function rvUpdate(id, ok, form) {
    const now = Date.now(), r = rv[id];
    if (!ok) { rv[id] = { s: 1, d: now, t: now }; return "fail"; }
    if (!r || !r.s || (r.d || 0) > now || STEP_FORM[r.s] !== form) return null;
    if (r.s === 1) rv[id] = { s: 2, d: now, t: now };
    else if (r.s === 2) rv[id] = { s: 3, d: dayStart(now) + DAY, t: now };
    else if (r.s === 3) rv[id] = { s: 4, d: dayStart(now) + 4 * DAY, t: now };
    else rv[id] = { s: 0, d: 0, t: now };
    return rv[id].s;
  }
  function record(id, ok) {
    const s = Object.assign({ c: 0, w: 0, last: null }, stats[id]);
    ok ? s.c++ : s.w++;
    s.last = ok; s.t = Date.now();
    stats[id] = s;
    const step = rvUpdate(id, ok, "o");
    saveLocal(); schedulePush();
    return step;
  }
  function recordV(id, ok) { const step = rvUpdate(id, ok, "v"); saveLocal(); schedulePush(); return step; }
  function nextReview(qs) {
    const later = qs.filter(q => inQueue(q) && !isDue(q)).map(q => rv[q.id].d);
    if (!later.length) return null;
    const d = Math.min(...later);
    return { date: d, n: later.filter(x => dayStart(x) === dayStart(d)).length };
  }
  const fmtDay = t => { const d = new Date(t); const diff = Math.round((dayStart(t) - dayStart(Date.now())) / DAY); return diff === 1 ? "明日" : `${d.getMonth() + 1}/${d.getDate()}`; };

  // ---------- cloud sync (claude.ai でログイン時のみ) ----------
  let docRef = null, syncState = "connecting", writing = false, dirty = false, pushTimer = null;
  function setSync(s) { syncState = s; const el = document.getElementById("sync"); if (el) el.outerHTML = syncBadge(); }
  function syncBadge() {
    const m = {
      connecting: ["", "同期を確認中…"],
      on: ["on", "端末間で同期しています"],
      local: ["", "このブラウザに保存（他の端末へは「記録の引き継ぎ」で）"],
      err: ["err", "同期できません（このブラウザに保存中）"]
    }[syncState];
    return `<span class="sync ${m[0]}" id="sync"><i></i>${m[1]}</span>`;
  }
  const snapshot = () => JSON.stringify([stats, rv, resetAt, resets]);
  function schedulePush() { if (!docRef) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); }
  async function push() {
    if (!docRef) return;
    if (writing) { dirty = true; return; }
    writing = true;
    try {
      await docRef.set({ stats: JSON.parse(JSON.stringify(stats)), rv: JSON.parse(JSON.stringify(rv)), resetAt, resets: Object.assign({}, resets), updatedAt: Date.now() });
      if (syncState !== "on") setSync("on");
    } catch (e) {
      if (e && e.code === "unavailable") setTimeout(push, 1500 + Math.random() * 1500);
      else { setSync("err"); docRef = null; }
    } finally {
      writing = false;
      if (dirty) { dirty = false; push(); }
    }
  }
  function absorb(body) {
    if (!body) return false;
    const before = snapshot();
    absorbMeta(body.resetAt, body.resets);
    stats = merge(stats, body.stats || {});
    rv = mergeRv(rv, body.rv || {});
    syncRv();
    saveLocal();
    return snapshot() !== before;
  }
  (async function connect() {
    for (let i = 0; i < 25 && !(window.claude && window.claude.use); i++) await new Promise(r => setTimeout(r, 200));
    if (!window.claude || !window.claude.use) { setSync("local"); return; }
    try {
      const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
      const uid = db && user ? await user.id() : null;
      if (!uid) { setSync("local"); return; }
      const ref = db.collection("data/users/" + uid).doc(DOC_ID);
      const timer = setTimeout(() => { if (syncState === "connecting") setSync("err"); }, 10000);
      const snap = await ref.get();
      clearTimeout(timer);
      docRef = ref;
      const remote = snap.exists ? snap.data() : null;
      const changed = absorb(remote);
      if (!remote || JSON.stringify([remote.stats || {}, remote.rv || {}, remote.resetAt || 0, remote.resets || {}]) !== snapshot()) await push();
      setSync("on");
      if (changed && !session) route();
      ref.onSnapshot(s => {
        if (!s.exists || s.metadata.hasPendingWrites) return;
        if (absorb(s.data()) && !session) route();
      }, () => { setSync("err"); docRef = null; });
    } catch (e) { setSync(syncState === "connecting" ? "local" : "err"); docRef = null; }
  })();

  // ---------- helpers ----------
  const $app = document.getElementById("app");
  const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const optText = (q, i) => q.type === "multi" ? q.a.map(j => `${j + 1}. ${q.o[j]}`).join(" ／ ") : q.type === "combo" ? q.cols.map((c, k) => `${c}：${q.o[i][k]}`).join("　") : q.o[i];
  const ansLabel = q => q.type === "multi" ? q.a.map(j => j + 1).join("・") : isExam(q) ? String(q.a + 1) : "";
  function summary(qs) {
    let tried = 0, mastered = 0, c = 0, w = 0;
    qs.forEach(q => { const s = stats[q.id]; if (s) { tried++; c += s.c; w += s.w; if (s.last) mastered++; } });
    return { total: qs.length, tried, mastered, c, w, rate: (c + w) ? Math.round(c / (c + w) * 100) : null };
  }
  const rateHtml = r => r === null ? "<small>未挑戦</small>" : r + "<small>%</small>";
  const statBox = (s, queued) => `
    <div class="overall">
      <div class="stat"><div class="num">${s.tried}<small style="font-size:14px;color:var(--sub)">/${s.total}</small></div><div class="lbl">挑戦した問題</div></div>
      <div class="stat"><div class="num">${s.rate === null ? "–" : s.rate + "%"}</div><div class="lbl">通算正答率</div></div>
      <div class="stat"><div class="num" style="color:${queued ? "var(--wrong)" : "inherit"}">${queued}</div><div class="lbl">復習中</div></div>
    </div>`;
  function reviewButton(qs, attr, primary) {
    const due = qs.filter(isDue).length, queued = qs.filter(inQueue).length;
    const nx = nextReview(qs);
    const d = due ? "別の形 → 元の形式 → 翌日 → 4日後"
      : nx ? `次の復習：${fmtDay(nx.date)}（${nx.n}問）`
      : queued ? "" : "間違えた問題がここに入ります";
    return `<button class="mode${due && primary ? " primary" : ""}" ${attr} ${due ? "" : "disabled"}><span class="t">今日の復習${due ? " " + due + "問" : ""}</span><span class="d">${d}</span></button>`;
  }

  // ---------- question shapes ----------
  const isTF = q => q.type === "combo" && !!q.items && !q.pool && q.o[0].every(v => v === "○" || v === "×");
  const isMatch = q => q.type === "combo" && !!q.pool;
  const isBlank = q => q.type === "combo" && !q.items;
  const firstLine = q => q.q.split("\n")[0];
  const stripLead = q => q.q.split("\n\n").slice(1).join("\n\n");
  // 選択肢が「文」で、それぞれの正誤を判定できる問題か（5択）
  function c5Truth(q) {
    if (!q.fixed) return null;
    const fl = firstLine(q);
    const neg = /不適切|誤って|誤り/.test(fl), pos = !neg && /適切な|正しい/.test(fl);
    if (!neg && !pos) return null;
    return q.o.map((_, i) => (i === q.a) === pos);
  }
  // 各文が「適切」かどうか（○×で判定できる問題のみ）
  function truths(q) {
    if (isTF(q)) return q.o[q.a].map(v => v === "○");
    if (q.type === "multi") { const neg = /不適切/.test(q.q); return q.o.map((_, i) => q.a.includes(i) !== neg); }
    return c5Truth(q);
  }
  const stmtsOf = q => isTF(q) ? q.items : q.o;
  function shortQ(q) {
    if (isTF(q)) {
      const body = stripLead(q);
      if (body.includes("【事例】")) return "【事例】" + body.replace(/^[\s\S]*?【事例】\n?/, "").slice(0, 46) + "…";
      return body.split("\n")[0] || "○×の組合せ問題";
    }
    const fl = firstLine(q);
    return fl.length > 70 ? fl.slice(0, 70) + "…" : fl;
  }

  // ---------- 別の形への作り替え ----------
  // 間違えた問題を、同じ知識を別の角度から問う形に組み替える
  function variantOf(q) {
    const ox = ["○", "×"];
    const tr = truths(q);
    if (isTF(q)) {
      const cs = q.q.includes("【事例】");
      return { kind: "ox", lead: (cs ? "【事例】の対応として、" : "") + "A〜" + KEYS4.concat("E")[q.items.length - 1] + "を1文ずつ、適切なら○、不適切なら×で判定しましょう。",
        ctx: stripLead(q), rows: q.items.map((s, k) => ({ t: s, ch: ox, a: tr[k] ? 0 : 1 })) };
    }
    if (tr) {
      return { kind: "ox", lead: "選択肢を1つずつ、適切なら○、不適切なら×で判定しましょう。", orig: q.q,
        rows: q.o.map((s, i) => ({ t: (q.type === "multi" ? (i + 1) + ". " : "") + s, ch: ox, a: tr[i] ? 0 : 1 })) };
    }
    if (isMatch(q)) {
      const labels = q.pool.map((_, i) => KANA[i]);
      return { kind: "pick", lead: "組合せの選択肢を見ずに、それぞれに当てはまるものを" + labels[0] + "〜" + labels[labels.length - 1] + "から選びましょう。",
        orig: q.q, pool: q.pool, rows: q.items.map((s, k) => ({ t: s, ch: labels, a: labels.indexOf(q.o[q.a][k]) })) };
    }
    if (isBlank(q)) {
      return { kind: "pick", lead: "空欄ごとに、当てはまる語句を選びましょう。", ctx: stripLead(q) || q.q,
        rows: q.cols.map((c, k) => { const ch = shuffle([...new Set(q.o.map(o => o[k]))]); return { t: `（${c}）`, ch, a: ch.indexOf(q.o[q.a][k]) }; }) };
    }
    // 一問一答・その他の5択：選択肢を隠して想起 → 候補を1つずつ判定
    const wrongs = shuffle(q.o.map((_, i) => i).filter(i => i !== q.a)).slice(0, 2);
    return { kind: "ox", recall: true, lead: "選択肢を見る前に答えを思い浮かべましょう。そのあと、候補がこの問いの答えなら○、ちがえば×を選びます。",
      ctx: q.q, rows: shuffle([q.a, ...wrongs]).map(i => ({ t: q.o[i], ch: ox, a: i === q.a ? 0 : 1 })) };
  }

  // ---------- 学習内容（復習ポイント） ----------
  function factsHtml(q) {
    const tr = truths(q);
    if (tr) {
      const ss = stmtsOf(q);
      return `<ul class="facts">${ss.map((s, i) => `<li class="${tr[i] ? "" : "ng"}"><span class="b">${tr[i] ? "○" : "×"}</span><span>${esc(s)}</span></li>`).join("")}</ul>
        <p class="fact-tip">${tr.some(x => !x) ? "×の文は、どこが誤りかを解説で確認しましょう。" : ""}</p>`;
    }
    if (isMatch(q)) {
      return `<ul class="facts pairs">${q.items.map((s, k) => {
        const kana = q.o[q.a][k];
        const p = q.pool.find(x => x.startsWith(kana)) || kana;
        return `<li><span>${esc(s.replace(/^[A-E]\s*/, ""))}</span><span class="arrow">→</span><span>${esc(p.replace(/^[ア-オ]\s*/, ""))}</span></li>`;
      }).join("")}</ul>`;
    }
    if (isBlank(q)) {
      const ans = Object.fromEntries(q.cols.map((c, k) => [c, q.o[q.a][k]]));
      const body = esc(stripLead(q) || q.q).replace(/[（(]\s*([A-E])\s*[）)]/g, (m, c) => ans[c] ? `<b class="fill">${esc(ans[c])}</b>` : m);
      return `<div class="passage">${body}</div>`;
    }
    return `<div class="fact-a"><span class="q">${esc(q.q)}</span><span class="a">答え：<b>${esc(q.o[q.a])}</b></span></div>`;
  }

  const gramCache = {}, dfCache = {};
  function gramsOf(q) {
    if (gramCache[q.id]) return gramCache[q.id];
    const txt = q.q + " " + (q.items || []).join(" ") + " " + (q.type ? "" : q.o[q.a]) + " " + q.e;
    const set = new Set();
    (txt.match(/[一-鿿々〇ァ-ヶーＡ-Ｚa-zA-Z0-9]{2,}/g) || []).forEach(w => { for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2)); });
    return (gramCache[q.id] = set);
  }
  function dfOf(sid) {
    if (dfCache[sid]) return dfCache[sid];
    const df = {};
    subjById[sid].questions.forEach(q => gramsOf(q).forEach(g => { df[g] = (df[g] || 0) + 1; }));
    return (dfCache[sid] = df);
  }
  // 同じ科目の中から、言葉が多く重なる問題を探す
  function related(q) {
    const sid = subjOfQ[q.id], S = subjById[sid], df = dfOf(sid), N = S.questions.length;
    const w = g => Math.log(N / (df[g] || 1));
    const keep = g => (df[g] || 0) <= N * 0.12;
    const g0 = [...gramsOf(q)].filter(keep);
    const n0 = Math.sqrt(g0.reduce((s, g) => s + w(g) ** 2, 0)) || 1;
    return S.questions.filter(x => x !== q).map(x => {
      const h = gramsOf(x);
      let dot = 0, nn = 0;
      h.forEach(g => { if (!keep(g)) return; nn += w(g) ** 2; });
      g0.forEach(g => { if (h.has(g)) dot += w(g) ** 2; });
      return [dot / (n0 * (Math.sqrt(nn) || 1)) + (x.c === q.c ? 0.03 : 0), x];
    }).filter(([s]) => s >= 0.16).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, x]) => x);
  }
  function relHtml(r) {
    const a = !r.type && !r.fixed ? r.o[r.a] : (r.fixed && !c5Truth(r) ? r.o[r.a] : "");
    return `<div class="rel"><div class="rq">${esc(shortQ(r))}</div>${a ? `<div class="ra">答え：${esc(a)}</div>` : ""}<div class="re">${esc(r.e)}</div></div>`;
  }
  function studyHtml(q, ok) {
    const cat = catOf(q), notes = cat.note || [];
    const rel = related(q);
    const facts = factsHtml(q);
    return `<div class="study">
      ${ok ? `<details class="sd"><summary>📌 正しい知識の整理</summary><div class="sb">${facts}</div></details>`
           : `<div class="sd open"><div class="sh">📌 正しい知識の整理</div><div class="sb">${facts}</div></div>`}
      ${notes.length ? `<details class="sd"><summary>📖 「${esc(cat.name)}」の要点</summary><div class="sb"><ul class="notes">${notes.map(n => `<li>${rich(n)}</li>`).join("")}</ul></div></details>` : ""}
      ${rel.length ? `<details class="sd"><summary>🔗 あわせて覚えたい関連知識</summary><div class="sb">${rel.map(relHtml).join("")}</div></details>` : ""}
    </div>`;
  }

  // ---------- routing ----------
  let session = null, current = null, resetTarget = null;
  function route() {
    const [id, sub] = (location.hash || "").replace(/^#/, "").split("/");
    const S = subjById[id];
    if (S && sub && S.categories.some(c => c.id === sub)) renderNote(S, S.categories.find(c => c.id === sub));
    else if (S) renderSubject(S); else renderTop();
  }
  window.addEventListener("hashchange", () => { session = null; route(); });
  function go(id) {
    const h = id ? "#" + id : "";
    if ((location.hash || "") === h) { session = null; route(); return; }
    try { if (id) location.hash = id; else history.pushState(null, "", location.pathname + location.search); } catch (e) {}
    session = null; route();
  }

  // ---------- session ----------
  function makeItem(q, form) {
    if (form === "v") return { q, form: "v", v: variantOf(q), picks: [], phase: 0 };
    if (q.type === "multi") return { q, form: "o", order: q.o.map((_, i) => i), answer: q.a, exam: true, multi: true, sel: [] };
    if (isExam(q)) return { q, form: "o", order: q.o.map((_, i) => i), answer: q.a, exam: true };
    const order = shuffle(q.o.map((_, i) => i));
    return { q, form: "o", order, answer: order.indexOf(q.a), exam: false };
  }
  // pool の要素は問題そのもの、または { q, form }（form: "o" 元の形式 / "v" 別の形）
  function start(title, pool, opts) {
    if (!pool.length) return;
    opts = opts || {};
    session = {
      title, back: current ? current.id : null, review: !!opts.review,
      items: shuffle(pool).map(x => x.form ? makeItem(x.q, x.form) : makeItem(x, "o")),
      i: 0, results: []
    };
    renderQuestion();
  }
  const reviewPool = qs => qs.filter(isDue).map(q => ({ q, form: formFor(q) }));
  const label = (it, k) => it.exam ? String(k + 1) : KEYS4[k];

  // ---------- views ----------
  function footer() {
    return `<div class="install" id="install"><b style="color:var(--ink)">📱 ホーム画面に追加するとアプリのように使えます</b><br>Safariの共有ボタン（□↑）→「ホーム画面に追加」</div>
      <div class="foot">${syncBadge()}<span class="links"><button class="link-btn" id="xfer-open">記録の引き継ぎ</button><button class="link-btn" id="reset">${current ? "この科目の記録をリセット" : "すべての記録をリセット"}</button></span></div>`;
  }
  function wireFooter() {
    document.getElementById("reset").onclick = () => {
      resetTarget = current ? current.id : null;
      document.getElementById("modal-text").innerHTML = current
        ? `「${esc(current.name)}」の学習記録をリセットしますか？`
        : "すべての科目の学習記録をリセットしますか？";
      document.getElementById("modal").classList.add("show");
    };
    document.getElementById("xfer-open").onclick = openXfer;
    try {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
      if (ios && !standalone && window.top === window.self) document.getElementById("install").classList.add("show");
    } catch (e) {}
  }
  const howto = `<details class="howto"><summary>復習のしくみ</summary>
      <ol>
        <li>間違えた問題は「今日の復習」に入ります。</li>
        <li>まず<b>別の形</b>（1文ずつの○×判定、組合せを使わない選択、空欄ごとの選択、答えを思い出してからの判定）で出題。</li>
        <li>別の形で全部正解できたら、続けて<b>元の形式</b>でもう一度。</li>
        <li>元の形式で正解したら<b>翌日</b>、さらに<b>4日後</b>に確認して、正解なら卒業です。途中で間違えると最初に戻ります。</li>
      </ol>
      <p>間違えたときは「正しい知識の整理」「分野の要点」「関連知識」が表示されます。</p></details>`;

  function renderTop() {
    session = null; current = null;
    const all = summary(ALL);
    const queued = ALL.filter(inQueue).length;
    $app.innerHTML = `
      <div class="brand"><span class="badge">保育士試験対策</span></div>
      <h1>保育士資格試験問題集</h1>
      <p class="lead">筆記試験 全9科目・${ALL.length}問。科目を選んでください。</p>
      ${statBox(all, queued)}
      <div class="modes" style="margin-bottom:10px">
        ${reviewButton(ALL, 'data-top="review"', true)}
        <button class="mode" data-top="random"><span class="t">全科目ミックス 20問</span><span class="d">科目をまたいでおまかせ出題</span></button>
      </div>
      ${howto}
      ${weakHtml(null)}
      <h2 class="section-title">科目を選ぶ</h2>
      <div class="subjects">
        ${SUBJ.map(s => {
          const sm = summary(s.questions);
          const pct = Math.round(sm.mastered / sm.total * 100);
          const due = s.questions.filter(isDue).length;
          return `<button class="subj" data-subj="${s.id}">
            <span class="ic">${s.icon}</span>
            <span class="name">${esc(s.name)}</span>
            <span class="meta">${sm.total}問・本番${s.examCount}問${due ? `<span class="due">復習${due}</span>` : ""}</span>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <span class="rate">${rateHtml(sm.rate)}</span>
          </button>`;
        }).join("")}
      </div>
      <p class="note">合格基準は各科目6割以上。「教育原理」と「社会的養護」は1科目として扱われ、それぞれ6割以上が必要です。</p>
      ${footer()}`;
    $app.querySelectorAll("[data-subj]").forEach(b => b.onclick = () => go(b.dataset.subj));
    $app.querySelectorAll("[data-top]").forEach(b => b.onclick = () => {
      if (b.dataset.top === "review") start("全科目の復習", reviewPool(ALL), { review: true });
      else start("全科目ミックス 20問", shuffle(ALL).slice(0, 20));
    });
    wireWeak();
    wireFooter();
    document.title = "保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  // 苦手分野：4回以上解いて正答率が70%未満の分野（低い順）
  function weakCats(S) {
    const list = [];
    (S ? [S] : SUBJ).forEach(s => s.categories.forEach(c => {
      const qs = s.questions.filter(q => q.c === c.id);
      const sm = summary(qs);
      if (sm.c + sm.w >= 4 && sm.rate < 70) list.push({ s, c, rate: sm.rate, queued: qs.filter(inQueue).length });
    }));
    return list.sort((a, b) => a.rate - b.rate).slice(0, 3);
  }
  function weakHtml(S) {
    const list = weakCats(S);
    if (!list.length) return "";
    return `<div class="weakbox">
      <div class="wt">🎯 苦手分野（正答率70%未満）</div>
      ${list.map(x => `<div class="wrow">
        <span class="wn">${S ? "" : `<small>${esc(x.s.name)}</small>`}${x.c.icon} ${esc(x.c.name)}</span>
        <span class="wr">${x.rate}%</span>
        <button class="wbtn" data-wnote="${x.s.id}/${x.c.id}">📖 要点</button>
      </div>`).join("")}
      <p class="wtip">要点を読んでから、分野別に解き直すのがおすすめです。</p>
    </div>`;
  }
  function wireWeak() { $app.querySelectorAll("[data-wnote]").forEach(b => b.onclick = () => go(b.dataset.wnote)); }

  function renderSubject(S) {
    session = null; current = S;
    const QS = S.questions;
    const all = summary(QS);
    const exam = QS.filter(isExam);
    const queued = QS.filter(inQueue).length;
    const n = Math.min(S.examCount, exam.length);
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← 科目一覧</button>
      <div class="brand"><span class="badge">${S.icon} 保育士試験対策</span></div>
      <h1>${esc(S.name)}</h1>
      <p class="lead">全${QS.length}問（一問一答${QS.length - exam.length}問＋本番形式${exam.length}問）・本試験は${S.examCount}問</p>
      ${statBox(all, queued)}
      <div class="modes">
        <button class="mode primary" data-mode="exam" ${n ? "" : "disabled"}><span class="t">本番形式 ${n}問</span><span class="d">組合せ・5択問題から出題</span></button>
        ${reviewButton(QS, 'data-mode="review"', false)}
        <button class="mode" data-mode="random"><span class="t">ランダム10問</span><span class="d">この科目からおまかせ</span></button>
        <button class="mode" data-mode="unseen" ${all.tried < all.total ? "" : "disabled"}><span class="t">未挑戦の問題</span><span class="d">あと${all.total - all.tried}問</span></button>
      </div>
      ${weakHtml(S)}
      <h2 class="section-title">分野別に解く・要点を読む</h2>
      <div class="cats">
        ${S.categories.map(c => {
          const qs = QS.filter(q => q.c === c.id);
          if (!qs.length) return "";
          const s = summary(qs);
          const ex = qs.filter(isExam).length;
          const pct = Math.round(s.mastered / s.total * 100);
          const due = qs.filter(isDue).length;
          return `<div class="cat-row">
            <button class="cat" data-cat="${c.id}">
              <span class="ic">${c.icon}</span>
              <span>
                <span class="name">${esc(c.name)}</span>
                <span class="meta">${s.total}問（うち本番形式${ex}）　直近正解 ${s.mastered}問${due ? `<span class="due">復習${due}</span>` : ""}</span>
                <div class="bar"><i style="width:${pct}%"></i></div>
              </span>
              <span class="rate">${rateHtml(s.rate)}</span>
            </button>
            ${c.note ? `<button class="cat-note" data-note="${c.id}" aria-label="${esc(c.name)}の要点">📖<span>要点</span></button>` : ""}
          </div>`;
        }).join("")}
      </div>
      ${footer()}`;
    document.getElementById("to-top").onclick = () => go(null);
    $app.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
      const m = b.dataset.mode;
      if (m === "exam") start(`${S.name} 本番形式 ${n}問`, shuffle(exam).slice(0, n));
      if (m === "random") start(`${S.name} ランダム10問`, shuffle(QS).slice(0, 10));
      if (m === "review") start(`${S.name} 復習`, reviewPool(QS), { review: true });
      if (m === "unseen") start(`${S.name} 未挑戦`, QS.filter(q => !stats[q.id]));
    });
    $app.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => {
      const c = S.categories.find(x => x.id === b.dataset.cat);
      start(`${S.name}：${c.name}`, QS.filter(q => q.c === c.id));
    });
    $app.querySelectorAll("[data-note]").forEach(b => b.onclick = () => go(`${S.id}/${b.dataset.note}`));
    wireWeak();
    wireFooter();
    document.title = `${S.name}｜保育士資格試験問題集`;
    window.scrollTo(0, 0);
  }

  // 分野の要点ページ
  function renderNote(S, c) {
    session = null; current = S;
    const qs = S.questions.filter(q => q.c === c.id);
    const sm = summary(qs);
    const due = qs.filter(isDue);
    const queued = qs.filter(inQueue);
    $app.innerHTML = `
      <button class="back" id="to-subj" style="margin-bottom:14px">← ${esc(S.name)}</button>
      <div class="brand"><span class="badge">${S.icon} ${esc(S.name)}</span></div>
      <h1>${c.icon} ${esc(c.name)}の要点</h1>
      <p class="lead">${qs.length}問・正答率 ${sm.rate === null ? "未挑戦" : sm.rate + "%"}${queued.length ? `・復習中 ${queued.length}問` : ""}</p>
      <div class="notecard"><ul class="notes">${(c.note || []).map(n => `<li>${rich(n)}</li>`).join("")}</ul></div>
      <div class="modes" style="margin:16px 0 22px">
        <button class="mode primary" id="n-all"><span class="t">この分野を解く</span><span class="d">${qs.length}問</span></button>
        <button class="mode" id="n-rv" ${due.length ? "" : "disabled"}><span class="t">この分野の復習</span><span class="d">${due.length ? due.length + "問" : "今日の分はありません"}</span></button>
      </div>
      ${queued.length ? `<h2 class="section-title">この分野で復習中の問題</h2>
        <div class="missed">${queued.map(q => `<details class="missed-item"><summary>${esc(shortQ(q))}<span class="stage">${STEP_NAME[rv[q.id].s]}${isDue(q) ? "" : "（" + fmtDay(rv[q.id].d) + "）"}</span></summary>
          <div class="sb">${factsHtml(q)}<p class="ex">${esc(q.e)}</p></div></details>`).join("")}</div>` : ""}
      ${footer()}`;
    document.getElementById("to-subj").onclick = () => go(S.id);
    document.getElementById("n-all").onclick = () => start(`${S.name}：${c.name}`, qs);
    document.getElementById("n-rv").onclick = () => start(`${c.name} 復習`, reviewPool(qs), { review: true });
    wireFooter();
    document.title = `${c.name}の要点｜${S.name}`;
    window.scrollTo(0, 0);
  }

  function optionsHtml(it) {
    const q = it.q;
    if (q.type === "combo") {
      const marks = q.o[0].every(v => v === "○" || v === "×") ? " marks" : "";
      return `<div class="combo-head" style="--n:${q.cols.length}"><span></span>${q.cols.map(c => `<span>${c}</span>`).join("")}<span></span></div>
        <div class="opts">${it.order.map((oi, k) => `
          <button class="opt combo${marks}" style="--n:${q.cols.length}" data-k="${k}">
            <span class="k">${k + 1}</span>${q.o[oi].map(v => `<span class="v">${esc(v)}</span>`).join("")}<span class="mk"></span>
          </button>`).join("")}</div>`;
    }
    if (it.multi) {
      return `<div class="need">正答数：<b>${q.a.length}つ</b>（${q.a.length}つ選んでから「回答する」）</div>
        <div class="opts">${it.order.map((oi, k) => `
        <button class="opt multi" data-k="${k}"><span class="k">${k + 1}</span><span>${esc(q.o[oi])}</span><span class="mk"></span></button>`).join("")}</div>
        <button class="submit" id="submit" disabled>回答する（0 / ${q.a.length}）</button>`;
    }
    return `<div class="opts">${it.order.map((oi, k) => `
      <button class="opt" data-k="${k}">
        <span class="k">${label(it, k)}</span><span>${esc(q.o[oi])}</span><span class="mk"></span>
      </button>`).join("")}</div>`;
  }

  function header(it) {
    const q = it.q, S = subjById[subjOfQ[q.id]], cat = catOf(q), n = session.items.length;
    const stage = isDue(q) && formFor(q) === it.form ? `<span class="tag-rv">${STEP_NAME[rv[q.id].s]}</span>` : "";
    return `
      <div class="topbar">
        <button class="back" id="quit">← やめる</button>
        <div class="progress"><i style="width:${session.results.length / n * 100}%"></i></div>
        <span class="count">${session.i + 1} / ${n}</span>
      </div>
      <div class="qcard">
        <div class="qcat">${session.back ? "" : `<span class="tag-subj">${esc(S.name)}</span>`}${cat.icon} ${esc(cat.name)}${it.exam ? '<span class="tag-exam">本番形式</span>' : ""}${stage || (it.form === "v" ? '<span class="tag-v">🔁 別の形で</span>' : "")}</div>`;
  }
  function wireCommon() {
    document.getElementById("quit").onclick = () => session.results.length ? renderResult() : leave();
    document.getElementById("next").onclick = next;
    window.scrollTo(0, 0);
  }
  const nextLabel = () => session.i + 1 < session.items.length ? "次の問題へ" : "結果を見る";

  function renderQuestion() {
    const it = session.items[session.i];
    if (it.form === "v") return renderVariant(it);
    const q = it.q;
    $app.innerHTML = `${header(it)}
        <p class="qtext">${esc(q.q)}</p>
        ${q.items ? `<div class="stmts">${q.items.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${q.pool ? `<div class="stmts pool">${q.pool.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${optionsHtml(it)}
        <div class="explain" id="explain"></div>
        <button class="next" id="next">${nextLabel()}</button>
      </div>
      <p class="hint">キーボード：${it.multi ? "1〜5で選択／Enterで回答・次へ" : (it.exam ? "1〜5" : "A〜D（1〜4）") + "で回答／Enterで次へ"}</p>`;
    $app.querySelectorAll(".opt").forEach(b => b.onclick = () => answer(+b.dataset.k));
    const sb = document.getElementById("submit");
    if (sb) sb.onclick = submitMulti;
    wireCommon();
  }

  // 別の形の問題（1行ずつ判定するカード）
  function renderVariant(it) {
    const v = it.v, hideRows = v.recall && it.phase === 0;
    $app.innerHTML = `${header(it)}
        <div class="vlead">${esc(v.lead)}</div>
        ${v.orig ? `<div class="orig"><span>もとの問い</span>${esc(v.orig)}</div>` : ""}
        ${v.ctx ? (v.recall ? `<p class="qtext">${esc(v.ctx)}</p>` : `<div class="stmts ctx">${esc(v.ctx)}</div>`) : ""}
        ${v.pool ? `<div class="stmts pool">${v.pool.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${hideRows ? `<button class="submit recall" id="reveal">💭 答えを思い浮かべたら、タップして判定へ</button>` : ""}
        <div class="jrows" id="jrows" ${hideRows ? 'style="display:none"' : ""}>
          ${v.rows.map((r, k) => `<div class="jrow ${v.kind}" data-r="${k}">
            <div class="jt">${esc(r.t)}</div>
            <div class="jc">${r.ch.map((c, j) => `<button class="jb" data-r="${k}" data-j="${j}">${esc(c)}</button>`).join("")}</div>
          </div>`).join("")}
        </div>
        <button class="submit" id="jsubmit" disabled ${hideRows ? 'style="display:none"' : ""}>答え合わせ（0 / ${v.rows.length}）</button>
        <div class="explain" id="explain"></div>
        <button class="next" id="next">${nextLabel()}</button>
      </div>
      <p class="hint">すべての行を選んでから「答え合わせ」／Enterで答え合わせ・次へ</p>`;
    const rb = document.getElementById("reveal");
    if (rb) rb.onclick = reveal;
    $app.querySelectorAll(".jb").forEach(b => b.onclick = () => pick(it, +b.dataset.r, +b.dataset.j));
    document.getElementById("jsubmit").onclick = submitVariant;
    wireCommon();
  }
  function reveal() {
    const it = session.items[session.i];
    if (it.phase !== 0) return;
    it.phase = 1;
    document.getElementById("reveal").style.display = "none";
    document.getElementById("jrows").style.display = "";
    document.getElementById("jsubmit").style.display = "";
  }
  function pick(it, r, j) {
    if (it.done) return;
    it.picks[r] = j;
    $app.querySelectorAll(`.jb[data-r="${r}"]`).forEach(b => b.classList.toggle("on", +b.dataset.j === j));
    const n = it.v.rows.length, got = it.v.rows.filter((_, k) => it.picks[k] !== undefined).length;
    const sb = document.getElementById("jsubmit");
    sb.disabled = got < n;
    sb.textContent = `答え合わせ（${got} / ${n}）`;
  }
  function submitVariant() {
    const it = session.items[session.i];
    const rows = it.v.rows;
    if (it.done || rows.some((_, k) => it.picks[k] === undefined)) return;
    it.done = true;
    let miss = 0;
    rows.forEach((r, k) => {
      const row = $app.querySelector(`.jrow[data-r="${k}"]`), good = it.picks[k] === r.a;
      if (!good) miss++;
      row.classList.add(good ? "ok" : "ng");
      row.querySelectorAll(".jb").forEach(b => {
        const j = +b.dataset.j;
        b.disabled = true;
        if (j === r.a) b.classList.add("correct");
        else if (j === it.picks[k]) b.classList.add("wrong");
      });
    });
    const ok = miss === 0;
    const step = recordV(it.q.id, ok);
    session.results.push({ q: it.q, ok, form: "v" });
    if (step === 2) { session.items.push(makeItem(it.q, "o")); it.appended = true; }
    document.getElementById("jsubmit").style.display = "none";
    showExplain(it, ok, ok ? "" : `${miss}か所まちがえました`, step);
  }

  function toggleMulti(it, k) {
    if (it.chosen !== undefined) return;
    const i = it.sel.indexOf(k);
    if (i >= 0) it.sel.splice(i, 1); else it.sel.push(k);
    $app.querySelectorAll(".opt").forEach((b, idx) => b.classList.toggle("sel", it.sel.includes(idx)));
    const sb = document.getElementById("submit"), need = it.answer.length;
    sb.disabled = it.sel.length !== need;
    sb.textContent = it.sel.length > need ? `選びすぎです（${it.sel.length} / ${need}）` : `回答する（${it.sel.length} / ${need}）`;
  }
  function submitMulti() {
    const it = session.items[session.i];
    if (it.chosen !== undefined || it.sel.length !== it.answer.length) return;
    it.chosen = it.sel.slice();
    const ok = it.sel.length === it.answer.length && it.sel.every(k => it.answer.includes(k));
    const step = record(it.q.id, ok);
    session.results.push({ q: it.q, ok, form: "o" });
    $app.querySelectorAll(".opt").forEach((b, idx) => {
      b.disabled = true; b.classList.remove("sel");
      const isAns = it.answer.includes(idx), picked = it.sel.includes(idx);
      if (isAns) { b.classList.add("correct"); b.querySelector(".mk").textContent = picked ? "○" : "△"; }
      else if (picked) { b.classList.add("wrong"); b.querySelector(".mk").textContent = "×"; }
      else b.classList.add("dim");
    });
    document.getElementById("submit").style.display = "none";
    showExplain(it, ok, "正解は " + ansLabel(it.q), step);
  }
  function leave() { const b = session && session.back; session = null; b ? go(b) : go(null); }

  function answer(k) {
    const it = session.items[session.i];
    if (it.form === "v") return;
    if (k >= it.order.length) return;
    if (it.multi) return toggleMulti(it, k);
    if (it.chosen !== undefined) return;
    it.chosen = k;
    const ok = k === it.answer;
    const step = record(it.q.id, ok);
    session.results.push({ q: it.q, ok, form: "o" });
    $app.querySelectorAll(".opt").forEach((b, idx) => {
      b.disabled = true;
      if (idx === it.answer) { b.classList.add("correct"); b.querySelector(".mk").textContent = "○"; }
      else if (idx === k) { b.classList.add("wrong"); b.querySelector(".mk").textContent = "×"; }
      else b.classList.add("dim");
    });
    showExplain(it, ok, "正解は " + label(it, it.answer), step);
  }
  function stepNote(step, it) {
    const m = {
      fail: it.form === "v" ? "📝 復習リストに残ります。解説と要点を読んでから、もう一度挑戦しましょう。" : "📝 「今日の復習」に入りました。次は別の形で出題します。",
      2: it.appended ? "✅ 別の形でクリア！このあと元の形式でもう一度確認します。" : "✅ 別の形でクリア！次は元の形式で確認します。",
      3: "✅ 元の形式でも正解。明日もう一度確認します。",
      4: "✅ 翌日の確認もクリア。4日後に仕上げの確認をします。",
      0: "🎉 復習完了！この問題は卒業です。"
    }[step];
    return m ? `<div class="stepnote">${m}</div>` : "";
  }
  function showExplain(it, ok, ngText, step) {
    const ex = document.getElementById("explain");
    const laterHasV = session.items.slice(session.i + 1).some(x => x.q === it.q);
    ex.className = "explain show " + (ok ? "ok" : "ng");
    ex.innerHTML = `<div class="verdict">${ok ? (it.form === "v" ? "全部正解！" : "正解！") : "不正解… " + esc(ngText)}</div>
      <div class="etext">${esc(it.q.e)}</div>
      ${stepNote(step, it)}
      ${studyHtml(it.q, ok)}
      ${!ok && it.form === "o" && !laterHasV ? `<button class="again" id="again">🔁 この問題を別の形ですぐ確認する</button>` : ""}`;
    const ag = document.getElementById("again");
    if (ag) ag.onclick = () => {
      session.items.splice(session.i + 1, 0, makeItem(it.q, "v"));
      ag.disabled = true; ag.textContent = "✓ 次に別の形で出題します";
      document.querySelector(".count").textContent = `${session.i + 1} / ${session.items.length}`;
      document.getElementById("next").textContent = nextLabel();
    };
    const nb = document.getElementById("next");
    nb.textContent = nextLabel();
    nb.classList.add("show");
    document.querySelector(".count").textContent = `${session.i + 1} / ${session.items.length}`;
    setTimeout(() => { try { ex.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {} }, 60);
    document.querySelector(".progress > i").style.width = (session.results.length / session.items.length * 100) + "%";
  }
  function next() { if (session.i + 1 < session.items.length) { session.i++; renderQuestion(); } else renderResult(); }

  function renderResult() {
    const r = session.results;
    const okN = r.filter(x => x.ok).length;
    const pct = r.length ? Math.round(okN / r.length * 100) : 0;
    const allMissed = [...new Set(r.filter(x => !x.ok).map(x => x.q))];
    const missedQs = allMissed.filter(q => rv[q.id] && rv[q.id].s === 1); // まだ「別の形」の段階にある問題
    const graduated = [...new Set(r.map(x => x.q))].filter(q => rv[q.id] && rv[q.id].s === 0 && r.some(x => x.q === q && x.ok)).length;
    const C = 2 * Math.PI * 60;
    const msg = pct >= 90 ? ["すばらしい！", "この調子で他の分野も固めましょう。"]
              : pct >= 60 ? ["合格ラインです", "合格基準は各科目6割以上。間違えた問題を見直してさらに上へ。"]
              : ["もう一歩！", "解説と要点を読んで、間違えた問題を別の形で解き直しましょう。"];
    // 間違えた分野の集計
    const catMiss = {};
    allMissed.forEach(q => { const k = subjOfQ[q.id] + "/" + q.c; catMiss[k] = (catMiss[k] || 0) + 1; });
    const catList = Object.entries(catMiss).sort((a, b) => b[1] - a[1]).slice(0, 3);
    $app.innerHTML = `
      <div class="result-hero">
        <div class="ring">
          <svg width="140" height="140" viewBox="0 0 140 140">
            <circle cx="70" cy="70" r="60" fill="none" stroke="var(--line)" stroke-width="12"/>
            <circle cx="70" cy="70" r="60" fill="none" stroke="${pct >= 60 ? "var(--accent)" : "var(--wrong)"}" stroke-width="12"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/>
          </svg>
          <div class="val"><div><b>${pct}%</b><span>${okN} / ${r.length} 問正解</span></div></div>
        </div>
        <p class="msg">${msg[0]}</p>
        <p class="submsg">${esc(session.title)}　${msg[1]}</p>
        ${graduated ? `<p class="grad">🎉 ${graduated}問が復習を卒業しました</p>` : ""}
      </div>
      ${catList.length ? `<div class="weakbox"><div class="wt">📖 今回つまずいた分野の要点</div>
        ${catList.map(([k, n]) => { const [sid, cid] = k.split("/"); const s = subjById[sid], c = s.categories.find(x => x.id === cid);
          return `<div class="wrow"><span class="wn">${session.back ? "" : `<small>${esc(s.name)}</small>`}${c.icon} ${esc(c.name)}</span><span class="wr">${n}問</span>${c.note ? `<button class="wbtn" data-wnote="${k}">要点を読む</button>` : ""}</div>`; }).join("")}
      </div>` : ""}
      ${allMissed.length ? `<h2 class="section-title">間違えた問題（${allMissed.length}問）<small>タップで復習ポイント</small></h2>
        <div class="missed">${allMissed.map(q => `
          <details class="missed-item"><summary>${esc(shortQ(q))}${isTF(q) || q.type === "multi" || c5Truth(q) ? "" : `<div class="ans">正解：${isExam(q) && q.type !== "multi" ? ansLabel(q) + "　" : ""}${esc(optText(q, q.a))}</div>`}</summary>
            <div class="sb">${factsHtml(q)}<p class="ex">${esc(q.e)}</p></div></details>`).join("")}
        </div>
        <p class="note" style="margin:-8px 2px 16px">間違えた問題は「今日の復習」に入りました。別の形 → 元の形式 → 翌日 → 4日後の順に確認します。</p>` : ""}
      ${missedQs.length ? `<button class="btn dark wide" id="retry-v">🔁 間違えた問題を別の形で解き直す（${missedQs.length}問）</button>` : ""}
      <div class="actions">
        <button class="btn" id="home">${session.back ? "科目のトップへ" : "科目一覧へ"}</button>
        <button class="btn${missedQs.length ? "" : " dark"}" id="retry">${allMissed.length ? "元の形式で解き直す" : "もう一度"}</button>
      </div>`;
    const title = session.title, back = session.back;
    const pool = allMissed.length ? allMissed : [...new Set(session.items.map(x => x.q))];
    document.getElementById("home").onclick = leave;
    document.getElementById("retry").onclick = () => { current = back ? subjById[back] : null; start(allMissed.length ? "解き直し" : title, pool); };
    const rvb = document.getElementById("retry-v");
    if (rvb) rvb.onclick = () => { current = back ? subjById[back] : null; start("別の形で解き直し", missedQs.map(q => ({ q, form: "v" })), { review: true }); };
    $app.querySelectorAll("[data-wnote]").forEach(b => b.onclick = () => go(b.dataset.wnote));
    window.scrollTo(0, 0);
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", e => {
    if (!session || !document.querySelector(".qcard")) return;
    const it = session.items[session.i];
    if (it.form === "v") {
      if (e.key !== "Enter") return;
      if (it.done) next();
      else if (it.v.recall && it.phase === 0) reveal();
      else submitVariant();
      return;
    }
    const map = it.exam ? { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4 } : { a: 0, b: 1, c: 2, d: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
    const k = map[e.key.toLowerCase()];
    if (k !== undefined) answer(k);
    else if (e.key === "Enter" && it.chosen !== undefined) next();
    else if (e.key === "Enter" && it.multi) submitMulti();
  });

  // ---------- transfer code (works without login) ----------
  const CODE_PREFIX = "HKG1:";
  function encode() {
    return CODE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify({ s: stats, v: rv, r: resetAt, rs: resets }))));
  }
  function decode(code) {
    code = code.replace(/\s+/g, "");
    if (!code.startsWith(CODE_PREFIX)) throw new Error("prefix");
    const obj = JSON.parse(decodeURIComponent(escape(atob(code.slice(CODE_PREFIX.length)))));
    if (!obj || typeof obj.s !== "object") throw new Error("shape");
    return obj;
  }
  const xfer = document.getElementById("xfer");
  function openXfer() {
    document.getElementById("xfer-out").value = encode();
    document.getElementById("xfer-in").value = "";
    document.getElementById("xfer-msg").textContent = "";
    document.getElementById("xfer-copy").textContent = "コードをコピー";
    xfer.classList.add("show");
  }
  document.getElementById("xfer-close").onclick = () => { xfer.classList.remove("show"); route(); };
  document.getElementById("xfer-copy").onclick = async () => {
    const out = document.getElementById("xfer-out"), btn = document.getElementById("xfer-copy");
    try { await navigator.clipboard.writeText(out.value); btn.textContent = "コピーしました ✓"; }
    catch (e) { out.focus(); out.select(); try { out.setSelectionRange(0, out.value.length); } catch (_) {} btn.textContent = "選択しました。長押し（Ctrl+C）でコピー"; }
  };
  document.getElementById("xfer-load").onclick = () => {
    const msg = document.getElementById("xfer-msg");
    try {
      const obj = decode(document.getElementById("xfer-in").value);
      const n0 = Object.keys(stats).length;
      absorbMeta(obj.r, obj.rs);
      const clean = {}, cleanV = {};
      Object.entries(obj.s).forEach(([id, v]) => {
        if (v && typeof v === "object") clean[id] = { c: +v.c || 0, w: +v.w || 0, last: v.last === true ? true : v.last === false ? false : null, t: +v.t || 0 };
      });
      Object.entries(obj.v && typeof obj.v === "object" ? obj.v : {}).forEach(([id, v]) => {
        if (v && typeof v === "object") cleanV[id] = { s: Math.max(0, Math.min(4, +v.s || 0)), d: +v.d || 0, t: +v.t || 0 };
      });
      stats = merge(stats, clean);
      rv = mergeRv(rv, cleanV);
      syncRv();
      saveLocal(); schedulePush();
      msg.style.color = "var(--accent)";
      msg.textContent = `読み込みました（記録のある問題：${n0}問 → ${Object.keys(stats).length}問）`;
      document.getElementById("xfer-out").value = encode();
    } catch (e) {
      msg.style.color = "var(--wrong)";
      msg.textContent = "コードを読み取れませんでした。全体をコピーできているか確認してください。";
    }
  };

  // ---------- reset dialog ----------
  const modal = document.getElementById("modal");
  document.getElementById("modal-cancel").onclick = () => modal.classList.remove("show");
  document.getElementById("modal-ok").onclick = () => {
    const now = Date.now();
    if (resetTarget) {
      resets[resetTarget] = now;
      subjById[resetTarget].questions.forEach(q => { delete stats[q.id]; delete rv[q.id]; });
    } else { stats = {}; rv = {}; resetAt = now; }
    saveLocal(); push();
    modal.classList.remove("show"); route();
  };

  route();
})();
