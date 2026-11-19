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
  const qById = Object.fromEntries(ALL.map(q => [q.id, q]));
  const qThemes = {}; // 問題ID → 頻出テーマ（公式過去問の分析にもとづく）
  SUBJ.forEach(s => (s.themes || []).forEach(t => t.qs.forEach(id => { (qThemes[id] = qThemes[id] || []).push(t); })));
  const catOf = q => subjById[subjOfQ[q.id]].categories.find(c => c.id === q.c) || { icon: "", name: "", id: q.c };

  // ---------- local storage (safe) ----------
  // stats: 元の形式での成績 { id: {c, w, last, t} }
  // rv:    復習の段階 { id: {s, d, t} }  s=1 別の形 → 2 元の形式 → 3 翌日（別の形）→ 4 4日後（元の形式）→ 0 卒業
  // fm:    正解できた形式 { id: {m: ビット, t} }（形式を変えても正解できる＝理解の目安）
  // log:   日ごとの学習ログ { "YYYY-MM-DD": {n 解いた数, c 正解, ms 解答時間, nw 初めて解いた数, s:{科目:[n,c]}, m:{今日のメニューの完了}, t} }
  // cf:    自信度・間違いの理由 { id: {g:1 迷って正解, r: k知らなかった/yうろ覚え/m読み違い/uうっかり, t} }
  // plan:  学習プラン（受験日・科目・時間・テンプレート・変更履歴）
  // mk:    模擬試験の結果 [{sid, t, n, c, ms, cats:{分野:[n,c]}}]
  // ck:    実技試験の準備チェック { key: t }
  let stats = {}, rv = {}, fm = {}, resetAt = 0, resets = {}, log = {}, cf = {}, plan = null, mk = [], ck = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
    if (raw.stats) {
      stats = raw.stats; rv = raw.rv || {}; fm = raw.fm || {}; resetAt = raw.resetAt || 0; resets = raw.resets || {};
      log = raw.log || {}; cf = raw.cf || {}; plan = raw.plan || null; mk = raw.mk || []; ck = raw.ck || {};
    }
    else stats = raw;
  } catch (e) { stats = {}; }
  function saveLocal() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ stats, rv, fm, resetAt, resets, log, cf, plan, mk, ck })); } catch (e) {} }

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
  function mergeFm(a, b) {
    const out = {};
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(id => {
      const x = a[id], y = b[id];
      const r = !x ? y : !y ? x : { m: (x.m | y.m), t: Math.max(x.t || 0, y.t || 0) };
      const cut = cutoffFor(id);
      if (r && (cut === 0 || (r.t || 0) > cut)) out[id] = r;
    });
    return out;
  }
  // 日ごとのログ：同じ日の記録が両方にあれば、項目ごとに大きいほう（同じ記録の重複を数えないため）
  function mergeLog(a, b) {
    const out = {};
    new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).forEach(d => {
      const x = (a || {})[d], y = (b || {})[d];
      let r;
      if (!x) r = y; else if (!y) r = x;
      else {
        r = { n: Math.max(x.n || 0, y.n || 0), c: Math.max(x.c || 0, y.c || 0), ms: Math.max(x.ms || 0, y.ms || 0), tn: Math.max(x.tn || 0, y.tn || 0), nw: Math.max(x.nw || 0, y.nw || 0), s: {}, m: Object.assign({}, x.m, y.m), t: Math.max(x.t || 0, y.t || 0) };
        new Set([...Object.keys(x.s || {}), ...Object.keys(y.s || {})]).forEach(k => {
          const p = (x.s || {})[k] || [0, 0], q = (y.s || {})[k] || [0, 0];
          r.s[k] = [Math.max(p[0], q[0]), Math.max(p[1], q[1])];
        });
      }
      if (r && (resetAt === 0 || (r.t || 0) > resetAt)) out[d] = r;
    });
    return out;
  }
  function mergeT(a, b) { // 新しいほうを採用（問題IDごと）
    const out = {};
    new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).forEach(id => {
      const x = (a || {})[id], y = (b || {})[id];
      const r = !x ? y : !y ? x : ((x.t || 0) >= (y.t || 0) ? x : y);
      const cut = subjOfQ[id] ? cutoffFor(id) : resetAt;
      if (r && (cut === 0 || (r.t || 0) > cut)) out[id] = r;
    });
    return out;
  }
  function mergeMk(a, b) {
    const seen = new Set(), out = [];
    (a || []).concat(b || []).forEach(m => {
      if (!m || !m.sid) return;
      const k = m.sid + ":" + m.t;
      if (seen.has(k)) return; seen.add(k);
      if ((m.t || 0) > Math.max(resetAt, resets[m.sid] || 0)) out.push(m);
    });
    return out.sort((x, y) => x.t - y.t).slice(-200);
  }
  const mergePlan = (a, b) => !a ? b || null : !b ? a : ((a.t || 0) >= (b.t || 0) ? a : b);

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
  const STEP_NAME = { 1: "復習① 別の形", 2: "復習② 元の形式で", 3: "復習③ 翌日の確認", 4: "復習④ 仕上げ" };
  const stepName = q => rv[q.id].f ? "頻出・定着チェック" : STEP_NAME[rv[q.id].s];
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const inQueue = q => !!(rv[q.id] && rv[q.id].s > 0);
  const isDue = q => inQueue(q) && (rv[q.id].d || 0) <= Date.now();
  const formFor = q => STEP_FORM[rv[q.id].s] || "o";
  // 頻出問題は、形式を変えて何度か正解するまで「定着チェック」で再出題する
  function scheduleCheck(id, now, days) {
    const q = qById[id];
    if (!q || !isHot(q) || formCount(q) >= targetForms(q)) return false;
    rv[id] = { s: 3, d: dayStart(now) + days * DAY, t: now, f: 1 };
    return true;
  }
  function rvUpdate(id, ok, form) {
    const now = Date.now(), r = rv[id];
    if (!ok) { rv[id] = { s: 1, d: now, t: now }; return "fail"; }
    if (!r || !r.s) return scheduleCheck(id, now, formCount(qById[id]) <= 1 ? 2 : 5) ? "check" : null;
    if ((r.d || 0) > now || STEP_FORM[r.s] !== form) return null;
    if (r.f) { // 定着チェック（別の形）に正解
      if (scheduleCheck(id, now, 6)) return "check2";
      rv[id] = { s: 0, d: 0, t: now }; return "fixed";
    }
    if (r.s === 1) rv[id] = { s: 2, d: now, t: now };
    else if (r.s === 2) rv[id] = { s: 3, d: dayStart(now) + DAY, t: now };
    else if (r.s === 3) rv[id] = { s: 4, d: dayStart(now) + 4 * DAY, t: now };
    else { rv[id] = { s: 0, d: 0, t: now }; if (scheduleCheck(id, now, 7)) return "grad-check"; }
    return rv[id].s;
  }
  function markForm(id, ok, bit) {
    if (!ok) return;
    const f = fm[id] || { m: 0, t: 0 };
    fm[id] = { m: f.m | bit, t: Date.now() };
  }
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const parseDay = k => { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
  function logAnswer(id, ok, isNew, ms) {
    const k = dayKey(Date.now()), L = log[k] = log[k] || { n: 0, c: 0, ms: 0, tn: 0, nw: 0, s: {}, m: {} };
    L.n++; if (ok) L.c++; if (isNew) L.nw++;
    if (ms > 1500) { L.ms += Math.min(ms, 180000); L.tn = (L.tn || 0) + 1; } // 極端に短い・長いものは時間の記録から外す
    const sid = subjOfQ[id], a = L.s[sid] = L.s[sid] || [0, 0];
    a[0]++; if (ok) a[1]++;
    L.t = Date.now();
  }
  function markMenu(key) {
    if (!key) return;
    const k = dayKey(Date.now()), L = log[k] = log[k] || { n: 0, c: 0, ms: 0, tn: 0, nw: 0, s: {}, m: {} };
    L.m = L.m || {}; L.m[key] = 1; L.t = Date.now();
    saveLocal(); schedulePush();
  }
  function record(id, ok, ms) {
    logAnswer(id, ok, !stats[id], ms);
    markForm(id, ok, 1);
    const s = Object.assign({ c: 0, w: 0, last: null }, stats[id]);
    ok ? s.c++ : s.w++;
    s.last = ok; s.t = Date.now();
    stats[id] = s;
    const step = rvUpdate(id, ok, "o");
    saveLocal(); schedulePush();
    return step;
  }
  function recordV(id, ok, kind, ms) { logAnswer(id, ok, false, ms); markForm(id, ok, KIND_BIT[kind] || 2); const step = rvUpdate(id, ok, "v"); saveLocal(); schedulePush(); return step; }
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
  const snapshot = () => JSON.stringify([stats, rv, fm, resetAt, resets, log, cf, plan, mk, ck]);
  const plain = o => JSON.parse(JSON.stringify(o));
  function schedulePush() { if (!docRef) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); }
  async function push() {
    if (!docRef) return;
    if (writing) { dirty = true; return; }
    writing = true;
    try {
      await docRef.set({ stats: plain(stats), rv: plain(rv), fm: plain(fm), resetAt, resets: Object.assign({}, resets), log: plain(log), cf: plain(cf), plan: plan ? plain(plan) : null, mk: plain(mk), ck: plain(ck), updatedAt: Date.now() });
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
    fm = mergeFm(fm, body.fm || {});
    log = mergeLog(log, body.log || {});
    cf = mergeT(cf, body.cf || {});
    plan = mergePlan(plan, body.plan || null);
    mk = mergeMk(mk, body.mk || []);
    ck = mergeT(ck, body.ck || {});
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
      if (!remote || JSON.stringify([remote.stats || {}, remote.rv || {}, remote.fm || {}, remote.resetAt || 0, remote.resets || {}, remote.log || {}, remote.cf || {}, remote.plan || null, remote.mk || [], remote.ck || {}]) !== snapshot()) await push();
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
  // 問題文の表（【見出し／見出し】の次の行から「／」区切り）を表として表示
  function qHtml(text) {
    const lines = String(text).split("\n"), out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^【(.+)】$/);
      if (m && m[1].includes("／")) {
        const head = m[1].split("／"), rows = [];
        let j = i + 1;
        while (j < lines.length && lines[j].split("／").length === head.length) { rows.push(lines[j].split("／")); j++; }
        if (rows.length) {
          while (out.length && /^\s*$/.test(out[out.length - 1])) out.pop(); // 表の前の空行を詰める
          if (out.length) out[out.length - 1] = out[out.length - 1].replace(/\n$/, "");
          out.push(`<table class="qtable"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, k) => `<td${k ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
          i = j - 1; continue;
        }
      }
      out.push(esc(lines[i]) + (i < lines.length - 1 ? "\n" : ""));
    }
    return out.join("");
  }
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
  // 同じ知識を別の角度から問う形に組み替える。形式（kind）は複数あり、出題のたびに入れ替える。
  //   ox:1文ずつ○×  mix:同じテーマの別の問題の文と混ぜて○×  pick:組合せ・空欄を1つずつ選ぶ
  //   rev:逆向き（答え→問い、ア〜エ→A〜D）  fill:空欄の語句の正誤判定  recall:想起してから判定
  const KIND_BIT = { ox: 2, mix: 4, pick: 8, rev: 16, fill: 32, recall: 64 };
  const KIND_NAME = { o: "元の形式", ox: "1文ずつ○×", mix: "他の問題と混ぜて○×", pick: "1つずつ選ぶ", rev: "逆向きに考える", fill: "語句の正誤判定", recall: "思い出してから判定" };
  const isCase = q => q.q.includes("【事例】");
  const isSimple = q => !q.type && !q.fixed;
  function revPool(q) { // 逆向き問題に使える、同じ分野の一問一答
    return subjById[subjOfQ[q.id]].questions.filter(x => x !== q && isSimple(x) && x.c === q.c && x.o[x.a] !== q.o[q.a] && !x.o.includes(q.o[q.a]));
  }
  function stmtSources(q) { // 混ぜる文の出どころ：同じテーマ（なければ同じ分野）の、事例でない○×系の問題
    const themes = qThemes[q.id] || [];
    const near = new Set(themes.flatMap(t => t.qs));
    const ok = x => x !== q && truths(x) && !isCase(x);
    let src = [...near].map(id => qById[id]).filter(x => x && ok(x));
    if (src.length < 2) src = subjById[subjOfQ[q.id]].questions.filter(x => x.c === q.c && ok(x));
    return src;
  }
  function kindsOf(q) {
    if (truths(q)) return isCase(q) ? ["ox"] : (stmtSources(q).length >= 2 ? ["ox", "mix"] : ["ox"]);
    if (isMatch(q)) return ["pick", "rev"];
    if (isBlank(q)) return ["pick", "fill"];
    if (isSimple(q) && revPool(q).length >= 3) return ["recall", "rev"];
    return ["recall"];
  }
  const fmBits = q => (fm[q.id] && fm[q.id].m) || 0;
  const popcount = n => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };
  const formCount = q => q ? popcount(fmBits(q)) : 0;
  // 頻出度：公式過去問（直近3回）でのテーマの出題数 8問以上＝2（最頻出）、4問以上＝1（頻出）
  const hotLevel = q => { const n = Math.max(0, ...(qThemes[q.id] || []).map(t => t.exam || 0)); return n >= 8 ? 2 : n >= 4 ? 1 : 0; };
  const isHot = q => hotLevel(q) > 0;
  // 理解の目安：最頻出は3つ、頻出は2つの形式で正解（その問題で作れる形式の数が上限）
  const targetForms = q => Math.min(1 + kindsOf(q).length, hotLevel(q) === 2 ? 3 : hotLevel(q) === 1 ? 2 : 1);
  function pickKind(q) { // まだ正解していない形式を優先
    const ks = kindsOf(q), fresh = ks.filter(k => !(fmBits(q) & KIND_BIT[k]));
    const pool = fresh.length ? fresh : ks;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const stripLabel = t => t.replace(/^[A-E]\s+/, "").replace(/^[A-E]　/, "");
  const topicOf = q => isTF(q) ? (stripLead(q).match(/【(.+?)】/) || [, ""])[1] : firstLine(q).replace(/^次のうち、|^次の文は、|^次の/, "").replace(/(として|について|に関する|に示され|の説明).*$/, "").slice(0, 40);

  function variantOf(q, kind) {
    kind = kind || pickKind(q);
    const ox = ["○", "×"];
    const tr = truths(q);
    if (kind === "mix" && tr) {
      const ss = stmtsOf(q);
      const own = shuffle(ss.map((t, i) => ({ t: stripLabel(t), a: tr[i] ? 0 : 1, src: topicOf(q) })));
      const mine = own.filter(r => r.a === 1).slice(0, 1).concat(own.filter(r => r.a === 0).slice(0, 1));
      own.forEach(r => { if (mine.length < 3 && !mine.includes(r)) mine.push(r); });
      const others = shuffle(stmtSources(q)).slice(0, 2).map(x => {
        const xt = truths(x), xs = stmtsOf(x), i = Math.floor(Math.random() * xs.length);
        return { t: stripLabel(xs[i]), a: xt[i] ? 0 : 1, src: topicOf(x), other: x.id };
      });
      return { kind, lay: "ox", lead: "この問題の文に、同じテーマの別の問題の文を混ぜました。知識をつなげて、1文ずつ○×で判定しましょう。",
        rows: shuffle(mine.concat(others)).map(r => ({ t: r.t, ch: ox, a: r.a, src: r.src, other: r.other })) };
    }
    if (tr) {
      if (isTF(q)) {
        return { kind: "ox", lay: "ox", lead: (isCase(q) ? "【事例】の対応として、" : "") + "A〜" + KEYS4.concat("E")[q.items.length - 1] + "を1文ずつ、適切なら○、不適切なら×で判定しましょう。",
          ctx: stripLead(q), rows: q.items.map((t, k) => ({ t, ch: ox, a: tr[k] ? 0 : 1 })) };
      }
      return { kind: "ox", lay: "ox", lead: "選択肢を1つずつ、適切なら○、不適切なら×で判定しましょう。", orig: q.q,
        rows: q.o.map((t, i) => ({ t: (q.type === "multi" ? (i + 1) + ". " : "") + t, ch: ox, a: tr[i] ? 0 : 1 })) };
    }
    if (isMatch(q)) {
      const labels = q.pool.map((_, i) => KANA[i]);
      if (kind === "rev") {
        const lefts = q.items.map((_, i) => LABELS[i]);
        return { kind, lay: "pick", lead: "逆向きに考えましょう。ア〜それぞれが、A〜のどれに当てはまるかを選びます。", orig: q.q, ctx: q.items.join("\n"),
          rows: shuffle(q.pool.map((t, i) => ({ t, ch: lefts, a: q.o[q.a].indexOf(KANA[i]) }))) };
      }
      return { kind: "pick", lay: "pick", lead: "組合せの選択肢を見ずに、それぞれに当てはまるものを" + labels[0] + "〜" + labels[labels.length - 1] + "から選びましょう。",
        orig: q.q, pool: q.pool, rows: q.items.map((t, k) => ({ t, ch: labels, a: labels.indexOf(q.o[q.a][k]) })) };
    }
    if (isBlank(q)) {
      const cands = q.cols.map((_, k) => [...new Set(q.o.map(o => o[k]))]);
      if (kind === "fill") {
        return { kind, lay: "ox", lead: "空欄に入る語句として正しければ○、誤りなら×を選びましょう。", ctx: stripLead(q) || q.q,
          rows: q.cols.map((c, k) => {
            const right = q.o[q.a][k], wrong = cands[k].filter(x => x !== right);
            const show = Math.random() < 0.5 || !wrong.length ? right : wrong[Math.floor(Math.random() * wrong.length)];
            return { t: `（${c}）＝「${show}」`, ch: ox, a: show === right ? 0 : 1 };
          }) };
      }
      return { kind: "pick", lay: "pick", lead: "空欄ごとに、当てはまる語句を選びましょう。", ctx: stripLead(q) || q.q,
        rows: q.cols.map((c, k) => { const ch = shuffle(cands[k]); return { t: `（${c}）`, ch, a: ch.indexOf(q.o[q.a][k]) }; }) };
    }
    if (kind === "rev") {
      const qs = shuffle([q, ...shuffle(revPool(q)).slice(0, 3)]);
      return { kind, lay: "pick", lead: "逆向きに考えましょう。次の語句が答えになるのは、どの問いですか。", col: true,
        rows: [{ t: "答え：「" + q.o[q.a] + "」", ch: qs.map(x => x.q), a: qs.indexOf(q) }] };
    }
    const wrongs = shuffle(q.o.map((_, i) => i).filter(i => i !== q.a)).slice(0, 2);
    return { kind: "recall", lay: "ox", recall: true, lead: "選択肢を見る前に答えを思い浮かべましょう。そのあと、候補がこの問いの答えなら○、ちがえば×を選びます。",
      ctx: q.q, rows: shuffle([q.a, ...wrongs]).map(i => ({ t: q.o[i], ch: ox, a: i === q.a ? 0 : 1 })) };
  }
  const LABELS = ["A", "B", "C", "D", "E"];

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
      ${notes.length ? `<details class="sd note-d"><summary>📖 「${esc(cat.name)}」の要点</summary><div class="sb"><ul class="notes">${notes.map(n => `<li>${rich(n)}</li>`).join("")}</ul></div></details>` : ""}
      ${rel.length ? `<details class="sd"><summary>🔗 あわせて覚えたい関連知識</summary><div class="sb">${rel.map(relHtml).join("")}</div></details>` : ""}
      ${crossHtml(q)}
    </div>`;
  }

  // ---------- routing ----------
  let session = null, current = null, resetTarget = null;
  function route() {
    if (mock) { stopMock(); mock = null; }
    const [id, sub] = (location.hash || "").replace(/^#/, "").split("/");
    const S = subjById[id];
    if (S && sub && S.categories.some(c => c.id === sub)) renderNote(S, S.categories.find(c => c.id === sub));
    else if (S) renderSubject(S);
    else if (id === "plan") sub === "setup" ? renderSetup() : renderPlan();
    else if (id === "cram") renderCram();
    else if (id === "digest") renderDigest(sub);
    else if (id === "glossary") renderGlossary();
    else if (id === "jitsugi") renderJitsugi();
    else renderTop();
  }
  window.addEventListener("hashchange", () => { session = null; route(); });
  function go(id) {
    const h = id ? "#" + id : "";
    if ((location.hash || "") === h) { session = null; route(); return; }
    try { if (id) location.hash = id; else history.pushState(null, "", location.pathname + location.search); } catch (e) {}
    session = null; route();
  }

  // ---------- session ----------
  function makeItem(q, form, kind) {
    if (form === "v") return { q, form: "v", v: variantOf(q, kind), picks: [], phase: 0 };
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
      title, back: current ? current.id : null, review: !!opts.review, theme: opts.theme || null, menu: opts.menu || null,
      u0: opts.theme ? themeUnderstanding(opts.theme) : null,
      items: (opts.keep ? pool : shuffle(pool)).map(x => x.form ? makeItem(x.q, x.form, x.kind) : makeItem(x, "o")),
      i: 0, results: []
    };
    renderQuestion();
  }
  // 理解度（0〜1）：目安の形式数に対して何形式で正解したか
  const understanding = q => Math.min(formCount(q), Math.max(2, targetForms(q))) / Math.max(2, targetForms(q));
  const themeUnderstanding = t => { const qs = t.qs.map(id => qById[id]).filter(Boolean); return qs.length ? Math.round(qs.reduce((a, q) => a + understanding(q), 0) / qs.length * 100) : 0; };
  // 形を変えて繰り返すドリル：理解度の低い問題から選び、まだ正解していない形式で出題。
  // 理解度の低い問題は、間をあけて別の形式でもう一度出す。
  function drillItems(qs, n) {
    const order = shuffle(qs).sort((a, b) => (understanding(a) - understanding(b)) || ((isWeakQ(b) ? 1 : 0) - (isWeakQ(a) ? 1 : 0)));
    const chosen = order.slice(0, n);
    const formFor1 = q => !(fmBits(q) & 1) && Math.random() < 0.5 ? { q, form: "o" } : { q, form: "v", kind: pickKind(q) };
    const first = shuffle(chosen.map(formFor1));
    const again = chosen.filter(q => understanding(q) < 0.5).slice(0, Math.ceil(n / 3)).map(q => {
      const used = first.find(x => x.q === q);
      const ks = kindsOf(q).filter(k => k !== used.kind);
      return used.form === "o" ? { q, form: "v", kind: pickKind(q) } : ks.length ? { q, form: "v", kind: ks[Math.floor(Math.random() * ks.length)] } : { q, form: "o" };
    });
    // 2回目は、1回目から3問以上あけて後半に並べる
    const out = first.slice();
    shuffle(again).forEach(x => { const i0 = out.findIndex(y => y.q === x.q); const pos = Math.min(out.length, Math.max(i0 + 4, Math.floor(out.length * 0.6) + Math.floor(Math.random() * 3))); out.splice(pos, 0, x); });
    return out;
  }
  const isWeakQ = q => stats[q.id] && stats[q.id].last === false;
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
        <li><b>頻出問題</b>（公式過去問の直近3回で多く出たテーマ）は、正解しても日をおいて<b>別の形式</b>でもう一度出題。最頻出は3つ、頻出は2つの形式で正解できたら「理解できた」とみなします。</li>
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
      ${plan ? menuHtml(plan, true) + `<button class="link-btn plan-link" data-go="plan">学習プランの詳細・見通し →</button>`
        : `<button class="plancta" data-go="plan/setup"><b>📅 学習プランを作る</b><span>受験日・受験科目・1日に使える時間を入れると、毎日のメニューを自動で組み立てます</span></button>`}
      ${statBox(all, queued)}
      ${Object.keys(log).length ? calendarHtml(14) : ""}
      <div class="modes" style="margin-bottom:10px">
        ${reviewButton(ALL, 'data-top="review"', true)}
        <button class="mode" data-top="hot"><span class="t">🔥 頻出ドリル 12問</span><span class="d">過去問の頻出テーマを形を変えて</span></button>
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
          const sg = signal(s), tgt = !plan || plan.subj[s.id] === "now";
          return `<button class="subj${tgt ? "" : " dim"}" data-subj="${s.id}">
            <span class="ic">${s.icon}${sg.lv ? sigDot(sg) : ""}</span>
            <span class="name">${esc(s.name)}</span>
            <span class="meta">${sm.total}問・本番${s.examCount}問${due ? `<span class="due">復習${due}</span>` : ""}</span>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <span class="rate">${rateHtml(sm.rate)}</span>
          </button>`;
        }).join("")}
      </div>
      <p class="note">合格基準は各科目6割以上。「教育原理」と「社会的養護」は1科目として扱われ、それぞれ6割以上が必要です。</p>
      <h2 class="section-title" style="margin-top:22px">学習を支えるツール</h2>
      <div class="tools">
        <button class="tool" data-go="${plan ? "plan" : "plan/setup"}"><span>📅</span><b>学習プラン</b><small>段階・見通し・合格ライン</small></button>
        <button class="tool" data-go="glossary"><span>📚</span><b>用語集・年表</b><small>人物・法律・指針の年</small></button>
        <button class="tool" data-go="cram"><span>📘</span><b>間違えた問題の整理</b><small>読むだけの復習</small></button>
        <button class="tool" data-go="jitsugi"><span>🎹</span><b>実技試験の準備</b><small>音楽・造形・言語</small></button>
      </div>
      ${footer()}`;
    if (plan) wireMenu(plan);
    $app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
    $app.querySelectorAll("[data-subj]").forEach(b => b.onclick = () => go(b.dataset.subj));
    $app.querySelectorAll("[data-top]").forEach(b => b.onclick = () => {
      if (b.dataset.top === "review") start("全科目の復習", reviewPool(ALL), { review: true });
      else if (b.dataset.top === "hot") start("頻出ドリル（全科目）", drillItems(ALL.filter(q => hotLevel(q) === 2), 12), { keep: true });
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
      <p class="lead">全${QS.length}問（一問一答${QS.length - exam.length}問＋本番形式${exam.length}問）・本試験は${S.examCount}問・${examMin(S)}分　${(sg => sigDot(sg) + `<small class="sigtip">${esc(sg.tip)}</small>`)(signal(S))}</p>
      ${statBox(all, queued)}
      <div class="modes">
        <button class="mode primary" data-mode="mock" ${n ? "" : "disabled"}><span class="t">⏱ 模擬試験 ${n}問・${examMin(S)}分</span><span class="d">途中で答えを見せず、最後に採点と6割判定</span></button>
        <button class="mode" data-mode="exam" ${n ? "" : "disabled"}><span class="t">本番形式 ${n}問</span><span class="d">1問ずつ答え合わせ</span></button>
        ${reviewButton(QS, 'data-mode="review"', false)}
        <button class="mode" data-mode="random"><span class="t">ランダム10問</span><span class="d">この科目からおまかせ</span></button>
        <button class="mode" data-mode="unseen" ${all.tried < all.total ? "" : "disabled"}><span class="t">未挑戦の問題</span><span class="d">あと${all.total - all.tried}問</span></button>
      </div>
      ${mockHistHtml(S)}
      ${weakHtml(S)}
      ${themesHtml(S)}
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
      if (m === "mock") return startMock(S);
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
    $app.querySelectorAll("[data-theme]").forEach(b => b.onclick = () => {
      const t = S.themes.find(x => x.id === b.dataset.theme);
      const qs = t.qs.map(id => qById[id]).filter(Boolean);
      start(`頻出テーマ：${t.name}`, drillItems(qs, Math.min(10, qs.length)), { keep: true, theme: t });
    });
    wireWeak();
    wireFooter();
    document.title = `${S.name}｜保育士資格試験問題集`;
    window.scrollTo(0, 0);
  }

  function themesHtml(S) {
    const ts = (S.themes || []).filter(t => t.qs.length).slice().sort((a, b) => b.exam - a.exam);
    if (!ts.length) return "";
    return `<h2 class="section-title">📊 頻出テーマで理解を深める<small>公式過去問（直近3回）の出題数順</small></h2>
      <div class="themes">${ts.map(t => { const u = themeUnderstanding(t);
        return `<button class="theme" data-theme="${t.id}">
          <span class="tn">${t.exam >= 8 ? '<span class="tag-hot">🔥 最頻出</span>' : t.exam >= 4 ? '<span class="tag-hot">頻出</span>' : ""}${esc(t.name)}</span>
          <span class="tm">過去3回で<b>${t.exam}問</b>出題・アプリ${t.qs.length}問</span>
          <span class="tr">${esc(t.refs)}</span>
          <span class="tu"><span class="bar"><i style="width:${u}%"></i></span><small>理解度 ${u}%</small></span>
        </button>`; }).join("")}</div>
      <p class="note" style="margin:-14px 2px 22px">タップすると、テーマの問題を形式を変えながら出題します（元の形式・1文ずつ○×・他の問題と混ぜる・逆向き など）。理解度は「いくつの形式で正解できたか」で測ります。</p>`;
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
        <div class="missed">${queued.map(q => `<details class="missed-item"><summary>${esc(shortQ(q))}<span class="stage">${stepName(q)}${isDue(q) ? "" : "（" + fmtDay(rv[q.id].d) + "）"}</span></summary>
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
    const stage = isDue(q) && formFor(q) === it.form ? `<span class="tag-rv">${stepName(q)}</span>` : "";
    return `
      <div class="topbar">
        <button class="back" id="quit">← やめる</button>
        <div class="progress"><i style="width:${session.results.length / n * 100}%"></i></div>
        <span class="count">${session.i + 1} / ${n}</span>
      </div>
      <div class="qcard">
        <div class="qcat">${session.back ? "" : `<span class="tag-subj">${esc(S.name)}</span>`}${cat.icon} ${esc(cat.name)}${it.exam ? '<span class="tag-exam">本番形式</span>' : ""}${hotTag(q)}${stage}${it.form === "v" ? `<span class="tag-v">🔁 ${KIND_NAME[it.v.kind]}</span>` : ""}</div>`;
  }
  const hotTag = q => { const h = hotLevel(q); return h ? `<span class="tag-hot">${h === 2 ? "🔥 最頻出" : "頻出"}</span>` : ""; };
  // 理解度：正解できた形式の数（形式を変えても正解できる＝理解できている）
  function understandHtml(q) {
    const n = formCount(q), target = Math.max(2, targetForms(q)), bits = fmBits(q);
    const stars = Array.from({ length: target }, (_, i) => i < n ? "★" : "☆").join("");
    const done = ["o", ...kindsOf(q)].filter(k => bits & (k === "o" ? 1 : KIND_BIT[k])).map(k => KIND_NAME[k]);
    const th = (qThemes[q.id] || []).slice().sort((a, b) => b.exam - a.exam)[0];
    const msg = n >= target ? "形式を変えても正解できています。理解できている状態です。"
      : n === 0 ? "まだどの形式でも正解していません。"
      : `あと${target - n}つ、別の形式で正解すると理解の目安に届きます。${isHot(q) ? "頻出問題なので、日をおいて別の形式で出題します。" : ""}`;
    return `<div class="understand"><div class="uh"><span>理解度</span><b>${stars}</b><small>${done.length ? "正解した形式：" + done.join("・") : ""}</small></div>
      <div class="um">${msg}</div>
      ${th ? `<div class="uth">📊 テーマ「${esc(th.name)}」は公式過去問（直近3回）で<b>${th.exam}問</b>出題</div>` : ""}</div>`;
  }
  function wireCommon() {
    document.getElementById("quit").onclick = () => session.results.length ? renderResult() : leave();
    document.getElementById("next").onclick = next;
    window.scrollTo(0, 0);
  }
  const nextLabel = () => session.i + 1 < session.items.length ? "次の問題へ" : "結果を見る";

  function renderQuestion() {
    const it = session.items[session.i];
    it.t0 = Date.now();
    if (it.form === "v") return renderVariant(it);
    const q = it.q;
    $app.innerHTML = `${header(it)}
        <p class="qtext">${qHtml(q.q)}</p>
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
        ${v.orig ? `<div class="orig"><span>もとの問い</span>${qHtml(v.orig)}</div>` : ""}
        ${v.ctx ? (v.recall ? `<p class="qtext">${qHtml(v.ctx)}</p>` : `<div class="stmts ctx">${qHtml(v.ctx)}</div>`) : ""}
        ${v.pool ? `<div class="stmts pool">${v.pool.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${hideRows ? `<button class="submit recall" id="reveal">💭 答えを思い浮かべたら、タップして判定へ</button>` : ""}
        <div class="jrows" id="jrows" ${hideRows ? 'style="display:none"' : ""}>
          ${v.rows.map((r, k) => `<div class="jrow ${v.lay}${v.col ? " col" : ""}" data-r="${k}">
            <div class="jt">${esc(r.t)}${r.src ? `<span class="jsrc">${esc(r.src)}</span>` : ""}</div>
            <div class="jc${v.col ? " col" : ""}">${r.ch.map((c, j) => `<button class="jb" data-r="${k}" data-j="${j}">${esc(c)}</button>`).join("")}</div>
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
    const step = recordV(it.q.id, ok, it.v.kind, Date.now() - (it.t0 || Date.now()));
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
    const step = record(it.q.id, ok, Date.now() - (it.t0 || Date.now()));
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
    const step = record(it.q.id, ok, Date.now() - (it.t0 || Date.now()));
    session.results.push({ q: it.q, ok, form: "o" });
    $app.querySelectorAll(".opt").forEach((b, idx) => {
      b.disabled = true;
      if (idx === it.answer) { b.classList.add("correct"); b.querySelector(".mk").textContent = "○"; }
      else if (idx === k) { b.classList.add("wrong"); b.querySelector(".mk").textContent = "×"; }
      else b.classList.add("dim");
    });
    showExplain(it, ok, "正解は " + label(it, it.answer), step);
  }
  function mixHtml(it) {
    const others = it.v.rows.filter(r => r.other).map(r => qById[r.other]).filter(Boolean);
    if (!others.length) return "";
    return `<details class="sd"${it.v.rows.some((r, k) => r.other && it.picks[k] !== r.a) ? " open" : ""}><summary>🧩 混ぜた文の出典と解説</summary><div class="sb">${others.map(relHtml).join("")}</div></details>`;
  }
  function stepNote(step, it) {
    const m = {
      fail: it.form === "v" ? "📝 復習リストに残ります。解説と要点を読んでから、もう一度挑戦しましょう。" : "📝 「今日の復習」に入りました。次は別の形で出題します。",
      2: it.appended ? "✅ 別の形でクリア！このあと元の形式でもう一度確認します。" : "✅ 別の形でクリア！次は元の形式で確認します。",
      3: "✅ 元の形式でも正解。明日もう一度確認します。",
      4: "✅ 翌日の確認もクリア。4日後に仕上げの確認をします。",
      0: "🎉 復習完了！この問題は卒業です。",
      check: "🔥 頻出問題です。理解を確かめるため、日をおいて別の形式でもう一度出題します。",
      check2: "✅ 別の形式でも正解！もう1つ別の形式で、日をおいて確認します。",
      fixed: "🎉 複数の形式で正解できました。この問題は定着しています。",
      "grad-check": "🎉 復習完了！頻出問題なので、1週間後に別の形式でもう一度確認します。"
    }[step];
    return m ? `<div class="stepnote">${m}</div>` : "";
  }
  // 自信度（正解したとき）と間違いの理由（不正解のとき）をワンタップで記録
  const REASONS = [["k", "知らなかった"], ["y", "うろ覚え"], ["m", "問題文の読み違い"], ["u", "うっかり"]];
  const REASON_TIP = {
    k: "📖 下の「分野の要点」を開きました。まず知識を入れてから、復習で別の形に挑戦しましょう。",
    y: "📖 似た知識と混ざりやすいところです。「正しい知識の整理」と要点で、違いを確認しましょう。",
    m: "🔎 「適切なもの／不適切なもの」「誤っているもの」に印をつけてから選ぶ習慣を。読み違い対策の問題を今日のメニューに入れます。",
    u: "✋ 知識はあるようです。選ぶ前に、選んだ理由を一言で言えるか確かめましょう。"
  };
  function confHtml(it, ok) {
    const c = cf[it.q.id] || {};
    if (ok) return `<div class="conf" id="conf"><span>自信は？</span>
        <button class="cbtn" data-cf="sure">確信あり</button><button class="cbtn" data-cf="guess">🤔 迷った・まぐれ</button>
        <div class="cmsg" id="cmsg"></div></div>`;
    return `<div class="conf ng" id="conf"><span>間違いの理由は？</span>
        ${REASONS.map(([k, t]) => `<button class="cbtn" data-why="${k}">${t}</button>`).join("")}
        <div class="cmsg" id="cmsg"></div></div>`;
  }
  function wireConf(it) {
    const box = document.getElementById("conf");
    if (!box) return;
    const id = it.q.id, msg = document.getElementById("cmsg");
    const mark = sel => box.querySelectorAll(".cbtn").forEach(b => b.classList.toggle("on", b === sel));
    box.querySelectorAll("[data-cf]").forEach(b => b.onclick = () => {
      const now = Date.now();
      mark(b);
      if (b.dataset.cf === "guess") {
        cf[id] = Object.assign({}, cf[id], { g: 1, t: now });
        if (!inQueue(it.q)) { rv[id] = { s: 1, d: now, t: now }; it.cfAdded = true; }
        msg.textContent = "迷って正解した問題は「今日の復習」に入れました。別の形で確かめます。";
      } else {
        cf[id] = Object.assign({}, cf[id], { g: 0, t: now });
        if (it.cfAdded) { delete rv[id]; it.cfAdded = false; }
        msg.textContent = "";
      }
      saveLocal(); schedulePush();
    });
    box.querySelectorAll("[data-why]").forEach(b => b.onclick = () => {
      const r = b.dataset.why;
      mark(b);
      cf[id] = Object.assign({}, cf[id], { r, t: Date.now() });
      msg.textContent = REASON_TIP[r];
      if (r === "k" || r === "y") { const d = document.querySelector(".study details.note-d"); if (d) d.open = true; }
      saveLocal(); schedulePush();
    });
  }
  function showExplain(it, ok, ngText, step) {
    const ex = document.getElementById("explain");
    const laterHasV = session.items.slice(session.i + 1).some(x => x.q === it.q);
    ex.className = "explain show " + (ok ? "ok" : "ng");
    ex.innerHTML = `<div class="verdict">${ok ? (it.form === "v" ? "全部正解！" : "正解！") : "不正解… " + esc(ngText)}</div>
      <div class="etext">${esc(it.q.e)}</div>
      ${stepNote(step, it)}
      ${confHtml(it, ok)}
      ${it.q.y ? `<div class="asof">📅 根拠：${esc(it.q.y)}。制度や数値は改定されることがあるので、新しい情報が出たら確認しましょう。</div>` : ""}
      ${understandHtml(it.q)}
      ${it.form === "v" && it.v.kind === "mix" ? mixHtml(it) : ""}
      ${studyHtml(it.q, ok)}
      ${!ok && it.form === "o" && !laterHasV ? `<button class="again" id="again">🔁 この問題を別の形ですぐ確認する</button>` : ""}`;
    wireConf(it);
    wireCross();
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
    if (session.menu && r.length) { markMenu(session.menu); session.menu = null; }
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
        ${session.theme ? `<p class="grad">テーマの理解度 ${session.u0}% → <b>${themeUnderstanding(session.theme)}%</b></p>` : ""}
        ${(() => { const fr = [...new Set(r.filter(x => x.ok).map(x => x.q))].filter(q => formCount(q) >= 2).length; return fr ? `<p class="submsg">2つ以上の形式で正解できている問題：${fr}問</p>` : ""; })()}
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
        <button class="btn" id="home">${session.back ? "科目のトップへ" : plan ? "今日のメニューへ" : "科目一覧へ"}</button>
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

  // =====================================================================
  // 学習プラン（計画エンジン）・模擬試験・合格ライン・用語集・実技準備
  // =====================================================================
  const EXAM_MIN = { "kyouiku-genri": 30, "shakaiteki-yougo": 30 }; // ほかの科目は60分
  const examMin = S => EXAM_MIN[S.id] || 60;
  // 令和8年前期の時間割（1日目／2日目）。回ごとに設定画面で変えられる
  const DAY1_DEFAULT = ["hoiku-shinri", "hoiku-genri", "kodomo-katei-fukushi", "shakai-fukushi"];
  // 共通する内容で束ねて進める順（半年プランなど）
  const BUNDLE = ["hoiku-genri", "jisshu-riron", "hoiku-shinri", "kyouiku-genri", "shakaiteki-yougo", "kodomo-katei-fukushi", "shakai-fukushi", "kodomo-hoken", "shoku-eiyou"];
  // 1年プランで前期に回す科目の案（設定は学生が行う）
  const YEAR_FIRST = ["hoiku-genri", "jisshu-riron", "hoiku-shinri", "kodomo-hoken", "shoku-eiyou"];
  const PH = ["基礎", "演習", "実戦", "直前"];
  const PH_DESC = [
    "分野の要点を読む→その分野の問題を解く。全分野を1周します",
    "頻出テーマ特訓と分野別。最頻出テーマの理解度を埋めます",
    "模擬試験（本番と同じ問題数・制限時間）と苦手分野のやり直し",
    "新しい問題は出さず、復習の片付け・最頻出・数字と年号・法改正に絞ります"
  ];
  const TEMPLATES = {
    year: { name: "1年プラン（2回受験）", who: "働きながら・子育てしながら", r: [0.4, 0.3, 0.2, 0.1], d: "科目合格の持ち越しを前提に、今回は4〜5科目、次の回に残り。結果を入れると次の回の計画を作り直します" },
    half: { name: "半年プラン", who: "次の回で9科目を狙う", r: [0.4, 0.3, 0.2, 0.1], d: "共通する内容の科目を束ねて進めます（保育原理と保育実習理論、福祉系3科目など）" },
    q3: { name: "3か月プラン", who: "残り科目が少ない・再受験", r: [0.2, 0.4, 0.25, 0.15], hot: true, d: "基礎を短くし、最頻出→頻出→その他の順で出題します" },
    m1: { name: "直前1か月", who: "一度は通して学んだ人", r: [0, 0, 0.6, 0.4], d: "週末ごとに模擬試験。苦手分野を自動で拾います" },
    w1: { name: "最後の1週間", who: "全員", r: [0, 0, 0, 1], d: "日別メニューで仕上げます" }
  };
  const PRESETS = [{ d: "2027-04-17", t: "令和9年前期（4/17・18の見込み）", note: "公式発表前の見込みです。受験の手引きで確定日を確認してください" }];
  const fmtMD = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const fmtMDW = t => `${fmtMD(t)}（${WD[new Date(t).getDay()]}）`;
  const today0 = () => dayStart(Date.now());
  const daysTo = k => Math.round((parseDay(k) - today0()) / DAY);
  const targetIds = p => (p && p.subj ? SUBJ.filter(s => p.subj[s.id] === "now").map(s => s.id) : []);
  const targetQs = p => targetIds(p).flatMap(id => subjById[id].questions);
  const day1Of = p => (p && p.day1) || DAY1_DEFAULT;
  const recDays = n => { const out = []; for (let i = 0; i < n; i++) { const k = dayKey(Date.now() - i * DAY); if (log[k]) out.push(log[k]); } return out; };

  // 1問あたりの時間：最初は1分。解いた時間の記録がたまったら本人のペースに補正
  function pace() {
    let ms = 0, n = 0;
    recDays(14).forEach(L => { ms += L.ms || 0; n += L.tn || 0; });
    return n >= 30 ? { sec: Math.max(15, Math.min(180, Math.round(ms / n / 1000))), real: true, n } : { sec: 60, real: false, n };
  }
  const minutesOn = (p, t) => { const w = new Date(t).getDay(); return (w === 0 || w === 6 ? p.we : p.wd) || 0; };
  const capOn = (p, t) => Math.max(5, Math.floor(minutesOn(p, t) * 60 / pace().sec));
  const avgCap = p => Math.max(5, Math.floor(((p.wd || 0) * 5 + (p.we || 0) * 2) / 7 * 60 / pace().sec));

  // 段階の割り振り：開始日〜受験日を配分で分ける。60日を切ったら基礎なし、30日を切ったら実戦と直前だけ。直前は最低7日
  function phasesOf(p) {
    const start = dayStart(p.start || Date.now()), exam = parseDay(p.exam);
    const total = Math.max(1, Math.round((exam - start) / DAY));
    let r = (TEMPLATES[p.tpl] || TEMPLATES.half).r.slice();
    if (total < 60) r[0] = 0;
    if (total < 30) r[1] = 0;
    let sum = r.reduce((a, b) => a + b, 0) || 1;
    r = r.map(x => x / sum);
    let days = r.map(x => Math.floor(x * total));
    days[3] += total - days.reduce((a, b) => a + b, 0);
    const minLast = Math.min(7, total);
    if (days[3] < minLast) { let need = minLast - days[3]; for (let k = 2; k >= 0 && need > 0; k--) { const take = Math.min(need, days[k]); days[k] -= take; need -= take; days[3] += take; } }
    if (p.goal && r[0] > 0) { // ② 区切りの日（基礎を終える日）を本人が決める
      const g = Math.round((parseDay(p.goal) - start) / DAY);
      if (g > 0 && g < total - minLast) {
        const rest = total - g, rr = r.slice(1), s2 = rr.reduce((a, b) => a + b, 0) || 1;
        const d2 = rr.map(x => Math.floor(x / s2 * rest));
        d2[2] += rest - d2.reduce((a, b) => a + b, 0);
        if (d2[2] < minLast) { let need = minLast - d2[2]; for (let k = 1; k >= 0 && need > 0; k--) { const take = Math.min(need, d2[k]); d2[k] -= take; need -= take; d2[2] += take; } }
        days = [g].concat(d2);
      }
    }
    let t = start;
    return days.map((d, k) => { const o = { k, name: PH[k], from: t, to: t + d * DAY, days: d }; t += d * DAY; return o; });
  }
  function phaseNow(p) {
    const ps = phasesOf(p), t = today0();
    let cur = ps.find(x => x.days > 0 && t >= x.from && t < x.to) || ps[3];
    // 基礎の分を早く終えたら、次の段階へ進める
    if (cur.k === 0) { const T = targetQs(p); if (T.length && T.filter(q => stats[q.id]).length / T.length >= 0.97) cur = ps[1]; }
    return { ps, cur };
  }

  // 見通し：①試験日から逆算 ②本人のペース ③両方を合わせて、間に合わないときだけ選択肢を出す
  function outlook(p) {
    const { ps, cur } = phaseNow(p), T = targetQs(p), t = today0();
    const unseen = T.filter(q => !stats[q.id]).length;
    const L = log[dayKey(Date.now())];
    const unseenAtDayStart = unseen + (L ? L.nw || 0 : 0);
    const cap = avgCap(p), queued = T.filter(inQueue).length;
    const reviewLoad = Math.min(Math.round(cap * 0.5), Math.ceil(queued / 3));
    const newPerDay = Math.max(1, cap - reviewLoad);
    const basic = ps[0], basicLeft = Math.max(1, Math.round((basic.to - t) / DAY));
    const out = { unseen, cap, reviewLoad, newPerDay, queued, cur, ps, warn: null, need: 0 };
    out.basicEndAtPace = t + Math.ceil(unseen / newPerDay) * DAY;
    out.reqPerDay = basic.days > 0 && t < basic.to ? Math.ceil(unseenAtDayStart / basicLeft) : 0;
    const exam = parseDay(p.exam);
    if (basic.days > 0 && unseen > 0 && out.basicEndAtPace > basic.to && t < exam) {
      const practiceEnd = out.basicEndAtPace + ps[1].days * DAY;
      const mockDays = Math.max(0, Math.round((exam - ps[3].days * DAY - practiceEnd) / DAY));
      // 1日の時間をどれだけ増やせば間に合うか／何科目減らせば間に合うか
      const needQ = out.reqPerDay + reviewLoad, needMin = Math.ceil(needQ * pace().sec / 60);
      const per = targetIds(p).map(id => subjById[id].questions.filter(q => !stats[q.id]).length).sort((a, b) => b - a);
      let drop = 0, left = unseen;
      while (drop < per.length - 1 && left / basicLeft > newPerDay) { left -= per[drop]; drop++; }
      out.warn = { mockDays, needMin, drop };
    }
    // 遅れ：予定どおりなら今日までに解いているはずの問題数との差
    if (p.b && basic.days > 0 && basic.to > p.b.t) {
      const f = Math.max(0, Math.min(1, (t - dayStart(p.b.t)) / (basic.to - dayStart(p.b.t))));
      const expected = Math.round(p.b.tried + (T.length - p.b.tried) * f), actual = T.length - unseen;
      out.lag = expected - actual;
      out.lagBig = out.lag > T.length * 0.25;
    }
    return out;
  }

  // ---------- 学習カレンダーと継続日数 ----------
  function streak() {
    let n = 0, i = log[dayKey(Date.now())] && log[dayKey(Date.now())].n ? 0 : 1;
    for (; ; i++) { const L = log[dayKey(Date.now() - i * DAY)]; if (L && L.n) n++; else break; }
    return n;
  }
  function calendarHtml(weeks) {
    weeks = weeks || 18;
    const t = today0(), end = t + (6 - new Date(t).getDay()) * DAY, start = end - (weeks * 7 - 1) * DAY;
    const lv = n => !n ? 0 : n < 10 ? 1 : n < 30 ? 2 : n < 60 ? 3 : 4;
    let cells = "", months = "";
    for (let w = 0; w < weeks; w++) {
      const ws = start + w * 7 * DAY, d = new Date(ws);
      months += `<span>${d.getDate() <= 7 ? (d.getMonth() + 1) + "月" : ""}</span>`;
      for (let k = 0; k < 7; k++) {
        const day = ws + k * DAY, L = log[dayKey(day)], n = L ? L.n : 0;
        cells += day > t ? `<i class="f"></i>` : `<i class="l${lv(n)}${day === t ? " now" : ""}" title="${fmtMD(day)} ${n}問"></i>`;
      }
    }
    const wk = recDays(7).reduce((a, L) => a + (L.n || 0), 0), act = Object.values(log).filter(L => L.n).length;
    return `<div class="calbox">
      <div class="calhead"><b>🔥 ${streak()}日連続</b><span>この7日間 ${wk}問・学習した日 ${act}日</span></div>
      <div class="calm" style="--w:${weeks}">${months}</div>
      <div class="cal" style="--w:${weeks}">${cells}</div>
      <div class="calleg">少<i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>多</div>
    </div>`;
  }

  // ---------- 合格ライン信号 ----------
  // 直近3週間の正答率（足りなければ通算）と最頻出テーマの理解度、模擬試験の最新点から、6割に届きそうかを示す
  function signal(S) {
    let n = 0, c = 0;
    recDays(21).forEach(L => { const a = (L.s || {})[S.id]; if (a) { n += a[0]; c += a[1]; } });
    if (n < 15) { const sm = summary(S.questions); n = sm.c + sm.w; c = sm.c; }
    const hot = (S.themes || []).filter(t => t.exam >= 8 && t.qs.length);
    const u = hot.length ? Math.round(hot.reduce((a, t) => a + themeUnderstanding(t), 0) / hot.length) : null;
    const ms = mk.filter(m => m.sid === S.id), last = ms.length ? ms[ms.length - 1] : null;
    const mp = last ? Math.round(last.c / last.n * 100) : null;
    if (n < 15 && mp === null) return { lv: 0, label: "データ不足", rate: null, u, mp, tip: "15問以上解くと判定します" };
    const rate = n ? Math.round(c / n * 100) : null;
    const score = mp !== null && rate !== null ? (mp + rate) / 2 : (mp !== null ? mp : rate);
    let lv = score >= 72 && (u === null || u >= 40) ? 3 : score >= 60 ? 2 : 1;
    if (lv === 3 && mp !== null && mp < 60) lv = 2;
    return { lv, label: ["", "要強化", "もう一歩", "合格圏"][lv], rate, u, mp,
      tip: lv === 3 ? "6割に届く見込み" : lv === 2 ? "6割前後。最頻出テーマを固めましょう" : "6割に届いていません。基礎から" };
  }
  const sigDot = sg => `<span class="sig s${sg.lv}" title="${esc(sg.tip)}"><i></i>${sg.label}</span>`;

  // ---------- 直前期の問題セット ----------
  const NUM_RX = /何年|年代|西暦|年に|人物|誰|提唱|著|唱えた|理論|数値|割合|何人|何歳|何か月|何%|％|パーセント|人数/;
  const isNumQ = q => isSimple(q) && (/[0-9０-９]|年|世紀/.test(q.o[q.a]) || /^[ァ-ヶー・]+$/.test(q.o[q.a]) || NUM_RX.test(q.q));
  const NEW_RX = /こども家庭庁|こども基本法|こども大綱|こども未来戦略|こどもまんなか|こども家庭センター|こども家庭ソーシャルワーカー|こども誰でも通園|意見表明等支援|第三次|健康日本21|COCOLO|令和[4-9]年|202[2-9]年|改正|新設|創設|施行/;
  const textOf = q => q.q + " " + (q.items || []).join(" ") + " " + (q.pool || []).join(" ") + " " + q.e;
  const isNewRule = q => NEW_RX.test(textOf(q));
  const NEG_RX = /不適切|誤って|誤り|適切でない/;
  function weakQsOf(sids, n) {
    const qs = [];
    sids.forEach(id => {
      const S = subjById[id];
      let cats = weakCats(S).map(x => x.c.id);
      if (!cats.length) cats = S.categories.map(c => ({ c: c.id, r: summary(S.questions.filter(q => q.c === c.id)).rate })).filter(x => x.r !== null).sort((a, b) => a.r - b.r).slice(0, 2).map(x => x.c);
      qs.push(...S.questions.filter(q => cats.includes(q.c)));
    });
    return shuffle(qs).sort((a, b) => (isWeakQ(b) ? 1 : 0) - (isWeakQ(a) ? 1 : 0)).slice(0, n);
  }
  const reasonCount = r => Object.values(cf).filter(x => x && x.r === r && (x.t || 0) > Date.now() - 30 * DAY).length;

  // ---------- 今日のメニュー ----------
  function menuItems(p) {
    const items = [], T = targetQs(p), tids = targetIds(p), D = daysTo(p.exam);
    const L = log[dayKey(Date.now())] || {}, m = L.m || {};
    if (!T.length) return items;
    const due = T.filter(isDue);
    const rvItem = (t, d) => ({ key: "rv", t: t || `復習 ${due.length}問`, d: d || "別の形 → 元の形式 → 翌日 → 4日後", done: !due.length && !!m.rv, off: !due.length && !m.rv,
      run: () => start("今日の復習", reviewPool(T), { review: true, menu: "rv" }) });
    const hotTheme = lv => {
      const ts = tids.flatMap(id => (subjById[id].themes || []).filter(t => t.exam >= (lv || 4) && t.qs.length).map(t => ({ t, s: subjById[id] })));
      return ts.sort((a, b) => themeUnderstanding(a.t) - themeUnderstanding(b.t) || b.t.exam - a.t.exam)[0];
    };
    if (D >= 1 && D <= 7) return lastWeekItems(p, D, T, m);
    if (D === 0) return [{ key: "d1", t: "試験1日目", d: "おちついて。夜は2日目の科目の要点だけを短時間で", done: !!m.d1, run: () => { markMenu("d1"); go("digest/2"); } }];
    if (D < 0) return [];
    const { cur } = phaseNow(p), ol = outlook(p);
    if (due.length || m.rv) items.push(rvItem());
    if (cur.k === 0) {
      const N = Math.max(5, Math.min(ol.reqPerDay || ol.newPerDay, Math.max(ol.newPerDay, ol.reqPerDay)));
      const doneN = L.nw || 0;
      // まだ1周していない割合が大きい科目から。分野の順に、要点→問題
      const sorted = tids.map(id => subjById[id]).map(S => ({ S, r: summary(S.questions).tried / S.questions.length, o: BUNDLE.indexOf(S.id) }))
        .sort((a, b) => (a.r - b.r) || (a.o - b.o));
      const pickS = sorted.find(x => x.S.questions.some(q => !stats[q.id]));
      if (pickS) {
        const S = pickS.S;
        let pool = S.questions.filter(q => !stats[q.id]);
        if ((TEMPLATES[p.tpl] || {}).hot) pool = pool.sort((a, b) => hotLevel(b) - hotLevel(a));
        else pool = pool.sort((a, b) => S.categories.findIndex(c => c.id === a.c) - S.categories.findIndex(c => c.id === b.c));
        const c = catOf(pool[0]);
        const left = Math.max(0, N - doneN);
        const qs = pool.filter(q => q.c === c.id).concat(pool.filter(q => q.c !== c.id)).slice(0, Math.max(5, left));
        items.push({ key: "new", t: doneN >= N ? `新しい問題 ${N}問 ✓` : `新しい問題 あと${left}問`, d: `${S.name}「${c.name}」から（要点を読んでから解くと効果的）`,
          done: doneN >= N, note: `${S.id}/${c.id}`, run: () => start(`${S.name}：新しい問題`, qs, { keep: true, menu: "new" }) });
      }
      const ht = hotTheme(8);
      if (ht) items.push({ key: "hot", t: `頻出テーマ：${ht.t.name.replace(/（.*$/, "")}`, d: `${ht.s.name}・理解度 ${themeUnderstanding(ht.t)}%（形を変えて6問）`, done: !!m.hot,
        run: () => { const qs = ht.t.qs.map(id => qById[id]).filter(Boolean); start(`頻出テーマ：${ht.t.name}`, drillItems(qs, Math.min(6, qs.length)), { keep: true, theme: ht.t, menu: "hot" }); } });
    } else if (cur.k === 1) {
      const ht = hotTheme(4);
      if (ht) items.push({ key: "hot", t: `頻出テーマ特訓：${ht.t.name.replace(/（.*$/, "")}`, d: `${ht.s.name}・理解度 ${themeUnderstanding(ht.t)}%・過去3回で${ht.t.exam}問`, done: !!m.hot,
        run: () => { const qs = ht.t.qs.map(id => qById[id]).filter(Boolean); start(`頻出テーマ：${ht.t.name}`, drillItems(qs, Math.min(10, qs.length)), { keep: true, theme: ht.t, menu: "hot" }); } });
      const unseen = T.filter(q => !stats[q.id]);
      if (unseen.length) items.push({ key: "new", t: `未挑戦の問題 ${Math.min(10, unseen.length)}問`, d: `基礎の残り ${unseen.length}問`, done: !!m.new,
        run: () => start("未挑戦の問題", shuffle(unseen).sort((a, b) => hotLevel(b) - hotLevel(a)).slice(0, 10), { keep: true, menu: "new" }) });
      const wk = weakQsOf(tids, 10);
      if (wk.length) items.push({ key: "weak", t: "苦手分野のやり直し 10問", d: "正答率の低い分野から", done: !!m.weak, run: () => start("苦手分野のやり直し", wk, { menu: "weak" }) });
    } else if (cur.k === 2) {
      const wd = new Date().getDay(), weekend = wd === 0 || wd === 6;
      const lastMock = id => { const ms = mk.filter(x => x.sid === id); return ms.length ? ms[ms.length - 1].t : 0; };
      const sinceAny = Math.min(...tids.map(id => (Date.now() - lastMock(id)) / DAY));
      if (weekend || sinceAny >= 3 || m.mock) {
        const S = tids.map(id => subjById[id]).sort((a, b) => lastMock(a.id) - lastMock(b.id))[0];
        items.push({ key: "mock", t: `模擬試験：${S.name}`, d: `${S.examCount}問・${examMin(S)}分。途中で答えは見せません`, done: !!m.mock, run: () => startMock(S, "mock") });
      }
      const wk = weakQsOf(tids, 12);
      if (wk.length) items.push({ key: "weak", t: "苦手分野のやり直し 12問", d: "正答率の低い分野から", done: !!m.weak, run: () => start("苦手分野のやり直し", wk, { menu: "weak" }) });
      const ht = hotTheme(8);
      if (ht) items.push({ key: "hot", t: `最頻出：${ht.t.name.replace(/（.*$/, "")}`, d: `理解度 ${themeUnderstanding(ht.t)}%`, done: !!m.hot,
        run: () => { const qs = ht.t.qs.map(id => qById[id]).filter(Boolean); start(`頻出テーマ：${ht.t.name}`, drillItems(qs, Math.min(8, qs.length)), { keep: true, theme: ht.t, menu: "hot" }); } });
    } else {
      const hot2 = T.filter(q => hotLevel(q) === 2);
      items.push({ key: "hot", t: "最頻出テーマ 12問", d: "形を変えて確認（新しい問題は出しません）", done: !!m.hot, run: () => start("最頻出テーマ", drillItems(hot2.filter(q => stats[q.id]).length >= 12 ? hot2.filter(q => stats[q.id]) : hot2, 12), { keep: true, menu: "hot" }) });
      const nums = T.filter(q => isNumQ(q) && stats[q.id]);
      if (nums.length) items.push({ key: "num", t: "数字・年号・人名 15問", d: "一問一答で確認", done: !!m.num, run: () => start("数字・年号・人名", shuffle(nums).slice(0, 15), { menu: "num" }) });
      const nr = T.filter(isNewRule);
      if (nr.length) items.push({ key: "law", t: "法改正・新しい制度 10問", d: "こども家庭庁関連・第三次健康日本21など", done: !!m.law, run: () => start("法改正・新しい制度", shuffle(nr).slice(0, 10), { menu: "law" }) });
    }
    // 読み違いが多い人には「適切でないもの」を選ぶ問題を多めに
    if (reasonCount("m") >= 3 && D > 1) {
      const neg = T.filter(q => isExam(q) && NEG_RX.test(firstLine(q)));
      if (neg.length) items.push({ key: "neg", t: "読み違い対策 6問", d: `この30日で「読み違い」${reasonCount("m")}回。「不適切なもの」を選ぶ問題で練習`, done: !!m.neg,
        run: () => start("読み違い対策（不適切なものを選ぶ）", shuffle(neg).slice(0, 6), { menu: "neg" }) });
    }
    return items;
  }
  // 最後の1週間の日別メニュー（試験に近い科目ほど後ろ）
  function lastWeekItems(p, D, T, m) {
    const tids = targetIds(p), d1 = tids.filter(id => day1Of(p).includes(id)), d2 = tids.filter(id => !day1Of(p).includes(id));
    const names = ids => ids.map(id => subjById[id].name).join("・") || "なし";
    const it = { 7: () => {
      const q = T.filter(inQueue);
      return { key: "lw", t: `復習待ちを空にする（${q.length}問）`, d: "「今日の復習」を前倒しで全部出します", off: !q.length && !m.lw,
        run: () => { const now = Date.now(); q.forEach(x => { if (rv[x.id].d > now) rv[x.id].d = now; }); saveLocal(); start("復習待ちを空にする", reviewPool(T), { review: true, menu: "lw" }); } };
    }, 6: () => ({ key: "lw", t: "全科目の最頻出テーマを一巡", d: "形式を変えて確認", run: () => start("最頻出テーマを一巡", drillItems(T.filter(q => hotLevel(q) === 2), Math.min(30, T.filter(q => hotLevel(q) === 2).length)), { keep: true, menu: "lw" }) }),
    5: () => ({ key: "lw", t: "数字・年号・人名だけの一問一答", d: "待機児童数、法律の制定年、理論家と理論など（用語集の暗記カードも）", run: () => start("数字・年号・人名", shuffle(T.filter(isNumQ)).slice(0, 30), { menu: "lw" }) }),
    4: () => ({ key: "lw", t: "法改正・新しい制度だけのセット", d: "こども家庭庁関連、第三次健康日本21など", run: () => start("法改正・新しい制度", shuffle(T.filter(isNewRule)).slice(0, 25), { menu: "lw" }) }),
    3: () => ({ key: "lw", t: "2日目の科目の苦手分野", d: names(d2), off: !d2.length, run: () => start("2日目の科目の苦手分野", weakQsOf(d2, 20), { menu: "lw" }) }),
    2: () => ({ key: "lw", t: "1日目の科目の苦手分野", d: names(d1), off: !d1.length, run: () => start("1日目の科目の苦手分野", weakQsOf(d1, 20), { menu: "lw" }) }),
    1: () => ({ key: "lw", t: "前日：これまで間違えた問題の「正しい知識の整理」を読む", d: "新しいことはやりません", run: () => { markMenu("lw"); go("cram"); } })
    }[D]();
    it.done = !!m.lw;
    it.badge = D === 1 ? "前日" : `${D}日前`;
    return [it];
  }
  function menuHtml(p, compact) {
    const items = menuItems(p), D = daysTo(p.exam);
    const { cur } = phaseNow(p);
    const head = D > 0 ? `受験日まで <b>${D}日</b>　<span class="phase p${cur.k}">${cur.name}期</span>` : D === 0 ? "<b>試験1日目</b>" : D === -1 ? "<b>試験2日目</b>" : "試験日を過ぎました";
    let body;
    if (D < -1) body = `<p class="mnote">おつかれさまでした。結果が出たら、合格した科目を入れて次の回の計画を作りましょう。</p><button class="btn dark wide" data-go="plan/setup">結果を入れて次の計画へ</button>`;
    else if (D === -1) body = `<p class="mnote">2日目の科目、がんばってください。</p>`;
    else if (!items.length) body = `<p class="mnote">受験科目を選ぶと、毎日のメニューが出ます。</p>`;
    else body = items.map((x, i) => `<div class="mi${x.done ? " done" : ""}${x.off ? " off" : ""}">
        <button class="mbtn" data-mi="${i}" ${x.off ? "disabled" : ""}>${x.badge ? `<span class="mbadge">${x.badge}</span>` : ""}<span class="mt">${x.done ? "✓ " : ""}${esc(x.t)}</span><span class="md">${esc(x.d)}</span></button>
        ${x.note ? `<button class="mnote-btn" data-go="${x.note}">📖<span>要点</span></button>` : ""}
      </div>`).join("");
    const done = items.filter(x => x.done).length;
    return `<div class="menu">
      <div class="mh"><span class="mtitle">📅 今日のメニュー</span><span class="mcount">${head}</span></div>
      ${body}
      ${items.length && !compact ? "" : ""}
      ${items.length > 1 ? `<div class="mfoot">${done} / ${items.length} 完了${done === items.length ? "　🎉 今日の分は終わりです" : ""}</div>` : ""}
    </div>`;
  }
  function wireMenu(p) {
    const items = menuItems(p);
    $app.querySelectorAll("[data-mi]").forEach(b => b.onclick = () => { current = null; items[+b.dataset.mi].run(); });
    $app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  }

  // ---------- 学習プランの画面 ----------
  const dateJa = k => { const d = new Date(parseDay(k)); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
  function renderPlan() {
    session = null; current = null;
    const p = plan;
    if (!p) return renderSetup();
    const tids = targetIds(p), D = daysTo(p.exam), ol = outlook(p), ps = ol.ps, sp = pace();
    const total = ps.reduce((a, x) => a + x.days, 0) || 1, t = today0();
    const nowPct = Math.max(0, Math.min(100, (t - ps[0].from) / (total * DAY) * 100));
    const later = SUBJ.filter(s => p.subj[s.id] === "later"), passed = SUBJ.filter(s => p.subj[s.id] === "pass");
    let warn = "";
    if (ol.warn) warn = `<div class="warn"><b>⚠ このペースだと、実戦の期間が${ol.warn.mockDays}日しか取れません。</b>
        <p>基礎の残り${ol.unseen}問に対して、1日に新しく解ける目安は${ol.newPerDay}問です。1日の問題数を増やす（1日平均${ol.warn.needMin}分ほど）か、${ol.warn.drop ? `科目を${ol.warn.drop}つ減らす` : "受験科目を絞る"}か、選んでください。</p>
        <div class="actions"><button class="btn" data-go="plan/setup">時間を増やす</button><button class="btn" data-go="plan/setup">科目を減らす</button></div></div>`;
    else if (ol.lag > 0 && ol.cur.k === 0) warn = `<div class="warn soft"><b>予定より${ol.lag}問遅れています。</b><p>残りの日数で割り直したので、今日の「新しい問題」が少し増えています。${ol.lagBig ? "大きく遅れているので、この回は科目を絞ることも考えましょう。" : "最初から立て直す必要はありません。"}</p>${ol.lagBig ? `<button class="btn wide" data-go="plan/setup">受験科目を見直す</button>` : ""}</div>`;
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← トップ</button>
      <div class="brand"><span class="badge">📅 学習プラン</span></div>
      <h1>${esc((TEMPLATES[p.tpl] || TEMPLATES.half).name)}</h1>
      <p class="lead">受験日 ${dateJa(p.exam)}${D > 0 ? `・あと<b>${D}日</b>` : ""}<br>今回の受験科目：${tids.map(id => esc(subjById[id].name)).join("・") || "未設定"}</p>
      ${menuHtml(p)}
      ${warn}
      <h2 class="section-title">段階と日程<small>①試験日から逆算${p.goal ? "・②区切りの日つき" : ""}</small></h2>
      <div class="phbar">${ps.map(x => x.days ? `<i class="p${x.k}" style="flex:${x.days}"><span>${x.name}</span></i>` : "").join("")}<b style="left:${nowPct}%"></b></div>
      <div class="phtable">${ps.map(x => x.days ? `<div class="phrow${ol.cur.k === x.k ? " cur" : ""}"><span class="phase p${x.k}">${x.name}</span><span>${fmtMD(x.from)}〜${fmtMD(x.to - DAY)}・${x.days}日</span><small>${PH_DESC[x.k]}</small></div>` : "").join("")}</div>
      <h2 class="section-title">見通し<small>③試験日は固定し、本人のペースで計算</small></h2>
      <div class="olbox">
        <div><span>1日に解ける目安</span><b>${ol.cap}問</b><small>平日${p.wd}分・週末${p.we}分、1問あたり約${sp.sec}秒（${sp.real ? `解いた時間${sp.n}問分から補正` : "記録がたまるまでは仮に1分"}）</small></div>
        <div><span>基礎の残り（未挑戦）</span><b>${ol.unseen}問</b><small>${ol.unseen ? `このペースだと基礎が終わるのは <b>${fmtMDW(ol.basicEndAtPace)}</b>` : "全問に一度は挑戦しました"}</small></div>
        ${ol.reqPerDay ? `<div><span>基礎を${fmtMD(ps[0].to - DAY)}までに終えるには</span><b>1日${ol.reqPerDay}問</b><small>新しい問題の数（毎日の実績で割り直します）</small></div>` : ""}
        <div><span>復習中</span><b>${ol.queued}問</b><small>1日あたりの復習の見込み 約${ol.reviewLoad}問</small></div>
      </div>
      <h2 class="section-title">科目ごとの状況<small>合格ライン（6割）に届きそうか</small></h2>
      <div class="sgrid">${tids.map(id => { const S = subjById[id], sm = summary(S.questions), sg = signal(S);
        return `<button class="srow" data-s="${id}"><span class="sn">${S.icon} ${esc(S.name)}</span>${sigDot(sg)}
          <span class="sd2">挑戦 ${sm.tried}/${sm.total}・正答率 ${sg.rate === null ? "–" : sg.rate + "%"}・最頻出の理解度 ${sg.u === null ? "–" : sg.u + "%"}${sg.mp !== null ? `・模試 ${sg.mp}%` : ""}</span>
          <span class="bar"><i style="width:${Math.round(sm.tried / sm.total * 100)}%"></i></span></button>`; }).join("")}</div>
      ${later.length ? `<p class="note">次の回に回す科目：${later.map(s => esc(s.name)).join("・")}</p>` : ""}
      ${passed.length ? `<p class="note">合格済み（免除）：${passed.map(s => esc(s.name)).join("・")}</p>` : ""}
      <h2 class="section-title" style="margin-top:22px">学習カレンダー</h2>
      ${calendarHtml()}
      ${(p.hist || []).length ? `<h2 class="section-title">受験科目の変更履歴</h2><div class="hist">${p.hist.slice(-12).reverse().map(h => `<div><span>${fmtMD(h.t)}</span>${esc(h.by === "teacher" ? "先生" : "自分")}が${esc(h.txt)}</div>`).join("")}</div>` : ""}
      <div class="actions" style="margin-top:18px"><button class="btn" data-go="plan/setup">設定を変える</button><button class="btn" data-go="">トップへ</button></div>
      ${footer()}`;
    document.getElementById("to-top").onclick = () => go(null);
    wireMenu(p);
    $app.querySelectorAll("[data-s]").forEach(b => b.onclick = () => go(b.dataset.s));
    wireFooter();
    document.title = "学習プラン｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  function recommendTpl(D) { return D > 200 ? "year" : D >= 120 ? "half" : D >= 50 ? "q3" : D > 7 ? "m1" : "w1"; }
  function renderSetup() {
    session = null; current = null;
    const p0 = plan || {};
    const st = {
      exam: p0.exam || PRESETS[0].d, tpl: p0.tpl || null, wd: p0.wd || 30, we: p0.we || 90, goal: p0.goal || "",
      subj: Object.assign({}, Object.fromEntries(SUBJ.map(s => [s.id, "now"])), p0.subj || {}), day1: (p0.day1 || DAY1_DEFAULT).slice()
    };
    const opts = (vals, cur) => vals.map(v => `<option value="${v}"${+cur === v ? " selected" : ""}>${v < 60 ? v + "分" : (v / 60) + "時間" + (v % 60 ? "半" : "")}</option>`).join("");
    const MIN = [0, 15, 30, 45, 60, 90, 120, 180, 240];
    const draw = () => {
      const D = daysTo(st.exam), rec = recommendTpl(D);
      if (!st.tpl) st.tpl = rec;
      const tmp = Object.assign({}, p0, st, { start: (p0.exam === st.exam && p0.tpl === st.tpl && p0.start) || Date.now() });
      const ok = D > 0 && Object.values(st.subj).includes("now");
      const ps = ok ? phasesOf(tmp) : [];
      const ol = ok ? outlook(tmp) : null;
      $app.innerHTML = `
        <button class="back" id="to-back" style="margin-bottom:14px">← ${plan ? "学習プラン" : "トップ"}</button>
        <div class="brand"><span class="badge">📅 学習プラン</span></div>
        <h1>${plan ? "プランの設定" : "学習プランを作る"}</h1>
        <p class="lead">受験日・受験科目・1日に使える時間を入れると、残りの日数から段階と毎日のメニューを自動で割り振ります。</p>
        <div class="form">
          <label class="fl">受験日（筆記1日目）</label>
          <input type="date" id="f-exam" value="${st.exam}" class="fi">
          <div class="chips">${PRESETS.map((x, i) => `<button class="chip${st.exam === x.d ? " on" : ""}" data-preset="${i}">${esc(x.t)}</button>`).join("")}</div>
          <p class="fh">${esc(PRESETS[0].note)}。令和8年は前期4月18・19日、後期10月24・25日でした。</p>

          <label class="fl">受験科目<small>前年度・前々年度に合格した科目は免除</small></label>
          <div class="subjset">${SUBJ.map(s => `<div class="ss"><span>${s.icon} ${esc(s.name)}</span><span class="seg">${[["now", "今回"], ["later", "次の回"], ["pass", "免除"]].map(([v, t]) => `<button class="${st.subj[s.id] === v ? "on" : ""}" data-sj="${s.id}" data-v="${v}">${t}</button>`).join("")}</span></div>`).join("")}</div>
          ${st.tpl === "year" ? `<button class="chip" id="f-yearsplit">今回と次の回の分け方の案を入れる</button><p class="fh">案：今回は保育原理・保育実習理論・保育の心理学・子どもの保健・子どもの食と栄養、次の回に教育原理・社会的養護と福祉系2科目（内容の近い科目をまとめる）。</p>` : ""}

          <label class="fl">1日に使える時間</label>
          <div class="row2"><span>平日</span><select id="f-wd" class="fi">${opts(MIN, st.wd)}</select><span>週末</span><select id="f-we" class="fi">${opts(MIN, st.we)}</select></div>

          <label class="fl">プラン<small>受験日までの日数からのおすすめ：${TEMPLATES[rec].name}</small></label>
          <div class="tpls">${Object.entries(TEMPLATES).map(([k, t]) => `<button class="tpl${st.tpl === k ? " on" : ""}" data-tpl="${k}"><b>${t.name}${k === rec ? '<span class="rec">おすすめ</span>' : ""}</b><small>${t.who}・${t.r.map((x, i) => x ? PH[i] + Math.round(x * 100) + "%" : "").filter(Boolean).join("・")}</small><small>${t.d}</small></button>`).join("")}</div>

          <label class="fl">区切りの日（任意）<small>例：1月末までに基礎を終える</small></label>
          <div class="row2"><span>基礎を終える日</span><input type="date" id="f-goal" value="${st.goal}" class="fi"><button class="chip" id="f-goal-clear">なし</button></div>

          <details class="howto" style="margin-top:12px"><summary>試験の時間割（1日目／2日目）</summary>
            <p>最後の1週間は、試験に近い科目ほど後ろに置きます。令和8年前期の時間割を初期値にしています。回ごとに確認してください。</p>
            <div class="subjset">${SUBJ.map(s => `<div class="ss"><span>${esc(s.name)}</span><span class="seg"><button class="${st.day1.includes(s.id) ? "on" : ""}" data-d="${s.id}" data-v="1">1日目</button><button class="${st.day1.includes(s.id) ? "" : "on"}" data-d="${s.id}" data-v="2">2日目</button></span></div>`).join("")}</div>
          </details>
        </div>
        <h2 class="section-title" style="margin-top:20px">この設定での計画</h2>
        ${!ok ? `<div class="warn soft">${D <= 0 ? "受験日は明日以降の日付にしてください。" : "「今回」の科目を1つ以上選んでください。"}</div>` : `
          <div class="phtable">${ps.map(x => x.days ? `<div class="phrow"><span class="phase p${x.k}">${x.name}</span><span>${fmtMD(x.from)}〜${fmtMD(x.to - DAY)}・${x.days}日</span></div>` : "").join("")}</div>
          <div class="olbox">
            <div><span>受験日まで</span><b>${D}日</b><small>${D < 30 ? "30日を切っているので、実戦と直前だけにしています" : D < 60 ? "60日を切っているので、基礎を省いて頻出テーマから入ります" : ""}</small></div>
            <div><span>1日に解ける目安</span><b>${ol.cap}問</b><small>1問あたり約${pace().sec}秒で計算</small></div>
            <div><span>受験科目の問題（未挑戦）</span><b>${ol.unseen}問</b><small>${ol.unseen ? `このペースだと基礎が終わるのは ${fmtMDW(ol.basicEndAtPace)}` : ""}${ol.reqPerDay ? `／期限までに終えるには1日${ol.reqPerDay}問` : ""}</small></div>
          </div>
          ${ol.warn ? `<div class="warn"><b>⚠ このペースだと実戦の期間が${ol.warn.mockDays}日しか取れません。</b><p>1日の時間を平均${ol.warn.needMin}分ほどに増やすか、${ol.warn.drop ? `科目を${ol.warn.drop}つ減らす` : "科目を絞る"}と間に合います。</p></div>` : ""}`}
        <button class="btn dark wide" id="f-save" ${ok ? "" : "disabled"} style="margin-top:12px">${plan ? "この設定で計画を作り直す" : "この計画で始める"}</button>
        ${plan ? `<button class="link-btn" id="f-del">プランを削除する</button>` : ""}
        ${footer()}`;
      const q = s => document.getElementById(s);
      q("to-back").onclick = () => go(plan ? "plan" : null);
      q("f-exam").onchange = e => { st.exam = e.target.value; st.tpl = null; draw(); };
      q("f-wd").onchange = e => { st.wd = +e.target.value; draw(); };
      q("f-we").onchange = e => { st.we = +e.target.value; draw(); };
      q("f-goal").onchange = e => { st.goal = e.target.value; draw(); };
      q("f-goal-clear").onclick = () => { st.goal = ""; draw(); };
      $app.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => { st.exam = PRESETS[+b.dataset.preset].d; st.tpl = null; draw(); });
      $app.querySelectorAll("[data-sj]").forEach(b => b.onclick = () => { st.subj[b.dataset.sj] = b.dataset.v; draw(); });
      $app.querySelectorAll("[data-tpl]").forEach(b => b.onclick = () => { st.tpl = b.dataset.tpl; draw(); });
      $app.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { const id = b.dataset.d; st.day1 = st.day1.filter(x => x !== id); if (b.dataset.v === "1") st.day1.push(id); draw(); });
      const ys = q("f-yearsplit");
      if (ys) ys.onclick = () => { SUBJ.forEach(s => { if (st.subj[s.id] !== "pass") st.subj[s.id] = YEAR_FIRST.includes(s.id) ? "now" : "later"; }); draw(); };
      q("f-save").onclick = () => savePlan(st);
      const del = q("f-del");
      if (del) del.onclick = () => { if (del.dataset.c) { plan = null; saveLocal(); schedulePush(); go(null); } else { del.dataset.c = 1; del.textContent = "もう一度押すと削除します（学習記録は消えません）"; } };
      wireFooter();
    };
    draw();
    document.title = "学習プランの設定｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }
  function savePlan(st) {
    const now = Date.now(), old = plan;
    const hist = old && old.hist ? old.hist.slice() : [];
    const label = { now: "今回の受験科目に", later: "次の回に", pass: "免除（合格済み）に" };
    SUBJ.forEach(s => {
      const a = old ? old.subj[s.id] : null, b = st.subj[s.id];
      if (old && a !== b) hist.push({ t: now, by: "self", sid: s.id, v: b, txt: `${s.name}を${label[b]}変更` });
    });
    if (!old) hist.push({ t: now, by: "self", txt: `受験科目を設定（${SUBJ.filter(s => st.subj[s.id] === "now").length}科目）` });
    const restart = !old || old.exam !== st.exam || old.tpl !== st.tpl;
    const subjChanged = !old || SUBJ.some(s => old.subj[s.id] !== st.subj[s.id]);
    const p = { exam: st.exam, tpl: st.tpl, wd: st.wd, we: st.we, goal: st.goal || "", subj: Object.assign({}, st.subj), day1: st.day1.slice(), hist: hist.slice(-50),
      start: restart ? now : old.start, t: now };
    const T = targetQs(p);
    p.b = restart || subjChanged ? { t: now, tried: T.filter(q => stats[q.id]).length } : old.b;
    plan = p;
    saveLocal(); schedulePush();
    go("plan");
  }

  // ---------- 前日：間違えた問題の「正しい知識の整理」だけを読む ----------
  function renderCram() {
    session = null; current = null;
    const tids = plan ? targetIds(plan) : SUBJ.map(s => s.id);
    const groups = tids.map(id => ({ S: subjById[id], qs: subjById[id].questions.filter(q => stats[q.id] && stats[q.id].w > 0).sort((a, b) => (stats[b.id].w - stats[a.id].w)) })).filter(g => g.qs.length);
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← もどる</button>
      <div class="brand"><span class="badge">📘 前日の読みもの</span></div>
      <h1>これまで間違えた問題の整理</h1>
      <p class="lead">新しいことはやらず、一度でも間違えた問題の「正しい知識の整理」だけを読みます（${groups.reduce((a, g) => a + g.qs.length, 0)}問）。</p>
      ${groups.length ? groups.map(g => `<h2 class="section-title">${g.S.icon} ${esc(g.S.name)}（${g.qs.length}問）</h2>
        <div class="missed">${g.qs.map(q => `<details class="missed-item"><summary>${esc(shortQ(q))}${isTF(q) || q.type === "multi" || c5Truth(q) ? "" : `<div class="ans">正解：${esc(optText(q, q.a))}</div>`}</summary>
          <div class="sb">${factsHtml(q)}<p class="ex">${esc(q.e)}</p></div></details>`).join("")}</div>`).join("") : `<div class="notecard">まだ間違えた問題の記録がありません。</div>`}
      ${footer()}`;
    document.getElementById("to-top").onclick = () => history.length > 1 ? history.back() : go(null);
    wireFooter();
    document.title = "前日の読みもの｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }
  // 要点まとめ（1日目の夜：2日目の科目の要点だけ）
  function renderDigest(which) {
    session = null; current = null;
    const tids = plan ? targetIds(plan) : SUBJ.map(s => s.id);
    const d1 = day1Of(plan);
    const ids = which === "1" ? tids.filter(id => d1.includes(id)) : which === "2" ? tids.filter(id => !d1.includes(id)) : tids;
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← もどる</button>
      <div class="brand"><span class="badge">📖 要点まとめ</span></div>
      <h1>${which === "2" ? "2日目の科目の要点" : which === "1" ? "1日目の科目の要点" : "受験科目の要点"}</h1>
      <p class="lead">${ids.map(id => esc(subjById[id].name)).join("・")}</p>
      ${ids.map(id => { const S = subjById[id]; return `<h2 class="section-title">${S.icon} ${esc(S.name)}</h2>` + S.categories.filter(c => c.note).map(c => `<details class="sd notecard" style="margin-bottom:8px"><summary>${c.icon} ${esc(c.name)}</summary><ul class="notes" style="margin-top:8px">${c.note.map(n => `<li>${rich(n)}</li>`).join("")}</ul></details>`).join(""); }).join("")}
      ${footer()}`;
    document.getElementById("to-top").onclick = () => history.length > 1 ? history.back() : go(null);
    wireFooter();
    window.scrollTo(0, 0);
  }

  // ---------- 模擬試験モード ----------
  // 本番と同じ問題数・制限時間。途中で答えは見せず、最後に採点と6割判定。分野の比率は過去問の出題配分（頻出テーマの出題数）に合わせる
  let mock = null;
  function mockPick(S) {
    const exam = S.questions.filter(isExam), n = Math.min(S.examCount, exam.length);
    const w = {};
    S.categories.forEach(c => { w[c.id] = 0.5; });
    (S.themes || []).forEach(t => { const qs = t.qs.map(id => qById[id]).filter(q => q && isExam(q)); qs.forEach(q => { w[q.c] += (t.exam || 0) / qs.length; }); });
    const avail = {}; exam.forEach(q => { avail[q.c] = (avail[q.c] || 0) + 1; });
    const cats = S.categories.map(c => c.id).filter(id => avail[id]);
    const tot = cats.reduce((a, id) => a + w[id], 0) || 1;
    const quota = {}, rem = [];
    let used = 0;
    cats.forEach(id => { const x = n * w[id] / tot; quota[id] = Math.min(avail[id], Math.floor(x)); used += quota[id]; rem.push([x - Math.floor(x), id]); });
    rem.sort((a, b) => b[0] - a[0]);
    for (let guard = 0; used < n && guard < 100; guard++) {
      const c = rem.find(([, id]) => quota[id] < avail[id]);
      if (!c) break;
      quota[c[1]]++; used++; rem.push(rem.splice(rem.indexOf(c), 1)[0]);
    }
    // 最近出していない問題から
    const pick = [];
    cats.forEach(id => { pick.push(...shuffle(exam.filter(q => q.c === id)).sort((a, b) => ((stats[a.id] || {}).t || 0) - ((stats[b.id] || {}).t || 0)).slice(0, quota[id])); });
    return shuffle(pick);
  }
  function startMock(S, menuKey) {
    const qs = mockPick(S);
    if (!qs.length) return;
    session = null;
    mock = { S, items: qs.map(q => ({ q, sel: [], chosen: null })), i: 0, t0: Date.now(), limit: examMin(S) * 60000, menu: menuKey || null, timer: null };
    mock.timer = setInterval(tickMock, 1000);
    renderMock();
  }
  const mm = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const answered = it => it.q.type === "multi" ? it.sel.length === it.q.a.length : it.chosen !== null;
  function tickMock() {
    if (!mock) return;
    const left = mock.limit - (Date.now() - mock.t0), el = document.getElementById("mtimer");
    if (el) { el.textContent = "残り " + mm(left); el.classList.toggle("low", left < 5 * 60000); }
    if (left <= 0) finishMock(true);
  }
  function renderMock() {
    const it = mock.items[mock.i], q = it.q, n = mock.items.length, S = mock.S;
    const done = mock.items.filter(answered).length;
    const opt = q.type === "combo"
      ? `<div class="combo-head" style="--n:${q.cols.length}"><span></span>${q.cols.map(c => `<span>${c}</span>`).join("")}<span></span></div>
         <div class="opts">${q.o.map((o, k) => `<button class="opt combo${q.o[0].every(v => v === "○" || v === "×") ? " marks" : ""}${it.chosen === k ? " sel" : ""}" style="--n:${q.cols.length}" data-mk="${k}"><span class="k">${k + 1}</span>${o.map(v => `<span class="v">${esc(v)}</span>`).join("")}<span class="mk"></span></button>`).join("")}</div>`
      : `${q.type === "multi" ? `<div class="need">正答数：<b>${q.a.length}つ</b></div>` : ""}<div class="opts">${q.o.map((o, k) => `<button class="opt${(q.type === "multi" ? it.sel.includes(k) : it.chosen === k) ? " sel" : ""}" data-mk="${k}"><span class="k">${k + 1}</span><span>${esc(o)}</span><span class="mk"></span></button>`).join("")}</div>`;
    $app.innerHTML = `
      <div class="topbar">
        <button class="back" id="mquit">中断</button>
        <span class="mtimer" id="mtimer">残り ${mm(mock.limit - (Date.now() - mock.t0))}</span>
        <span class="count">回答 ${done} / ${n}</span>
      </div>
      <div class="qcard">
        <div class="qcat"><span class="tag-exam">模擬試験</span> ${esc(S.name)}　問${mock.i + 1}</div>
        <p class="qtext">${qHtml(q.q)}</p>
        ${q.items ? `<div class="stmts">${q.items.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${q.pool ? `<div class="stmts pool">${q.pool.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${opt}
        <div class="mnav"><button class="btn" id="mprev" ${mock.i ? "" : "disabled"}>← 前へ</button><button class="btn dark" id="mnext">${mock.i + 1 < n ? "次へ →" : "見直し一覧へ"}</button></div>
      </div>
      <div class="mpal">${mock.items.map((x, k) => `<button class="${answered(x) ? "a" : ""}${k === mock.i ? " c" : ""}" data-mj="${k}">${k + 1}</button>`).join("")}</div>
      <button class="btn dark wide" id="mfinish" style="margin-top:12px">採点する${done < n ? `（未回答 ${n - done}問）` : ""}</button>
      <p class="hint">キーボード：1〜5で選択／←→で移動</p>`;
    $app.querySelectorAll("[data-mk]").forEach(b => b.onclick = () => mockSelect(+b.dataset.mk));
    $app.querySelectorAll("[data-mj]").forEach(b => b.onclick = () => { mock.i = +b.dataset.mj; renderMock(); });
    document.getElementById("mprev").onclick = () => { if (mock.i) { mock.i--; renderMock(); } };
    document.getElementById("mnext").onclick = () => { if (mock.i + 1 < n) { mock.i++; renderMock(); } else { const f = document.getElementById("mfinish"); f.scrollIntoView({ block: "center" }); } };
    const fin = document.getElementById("mfinish");
    fin.onclick = () => { if (done < n && !fin.dataset.c) { fin.dataset.c = 1; fin.textContent = `未回答が${n - done}問あります。もう一度押すと採点します`; return; } finishMock(false); };
    const qb = document.getElementById("mquit");
    qb.onclick = () => { if (qb.dataset.c) { stopMock(); go(S.id); } else { qb.dataset.c = 1; qb.textContent = "記録せずに中断（もう一度）"; } };
  }
  function mockSelect(k) {
    const it = mock.items[mock.i];
    if (k >= it.q.o.length) return;
    if (it.q.type === "multi") { const j = it.sel.indexOf(k); if (j >= 0) it.sel.splice(j, 1); else if (it.sel.length < it.q.a.length) it.sel.push(k); else { it.sel.shift(); it.sel.push(k); } }
    else it.chosen = it.chosen === k ? null : k;
    renderMock();
  }
  function stopMock() { if (mock && mock.timer) clearInterval(mock.timer); }
  function finishMock(timeUp) {
    if (!mock || mock.done) return;
    mock.done = true; stopMock();
    const ms = Math.min(mock.limit, Date.now() - mock.t0), cats = {};
    let c = 0;
    mock.items.forEach(it => {
      const q = it.q, has = answered(it);
      it.ok = has && (q.type === "multi" ? it.sel.every(k => q.a.includes(k)) : it.chosen === q.a);
      if (it.ok) c++;
      const a = cats[q.c] = cats[q.c] || [0, 0]; a[0]++; if (it.ok) a[1]++;
      if (has) record(q.id, it.ok, ms / mock.items.length);
    });
    mock.res = { sid: mock.S.id, t: Date.now(), n: mock.items.length, c, ms, cats, up: timeUp ? 1 : 0 };
    mk.push(mock.res);
    saveLocal(); schedulePush();
    if (mock.menu) markMenu(mock.menu);
    renderMockResult();
  }
  function renderMockResult() {
    const { S, items, res } = mock, pct = Math.round(res.c / res.n * 100), pass = res.c >= Math.ceil(res.n * 0.6), C = 2 * Math.PI * 60;
    const hist = mk.filter(m => m.sid === S.id).slice(-6);
    const ans = (it, q) => q.type === "multi" ? (it.sel.length ? it.sel.map(k => k + 1).join("・") : "未回答") : it.chosen === null ? "未回答" : String(it.chosen + 1);
    $app.innerHTML = `
      <div class="result-hero">
        <div class="ring"><svg width="140" height="140" viewBox="0 0 140 140"><circle cx="70" cy="70" r="60" fill="none" stroke="var(--line)" stroke-width="12"/>
          <circle cx="70" cy="70" r="60" fill="none" stroke="${pass ? "var(--accent)" : "var(--wrong)"}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
          <div class="val"><div><b>${pct}%</b><span>${res.c} / ${res.n} 問正解</span></div></div></div>
        <p class="msg">${pass ? "合格ライン到達！" : "合格ラインまで あと" + (Math.ceil(res.n * 0.6) - res.c) + "問"}</p>
        <p class="submsg">模擬試験：${esc(S.name)}　合格基準は6割（${Math.ceil(res.n * 0.6)}問）以上<br>使った時間 ${mm(res.ms)} / ${examMin(S)}分${res.up ? "（時間切れ）" : ""}</p>
      </div>
      <h2 class="section-title">分野ごとの結果</h2>
      <div class="phtable">${Object.entries(res.cats).map(([cid, [n, c]]) => { const cat = S.categories.find(x => x.id === cid); return `<div class="phrow"><span>${cat.icon} ${esc(cat.name)}</span><span>${c} / ${n}</span>${c < n ? `<button class="wbtn" data-wnote="${S.id}/${cid}">要点</button>` : ""}</div>`; }).join("")}</div>
      ${hist.length > 1 ? `<h2 class="section-title">これまでの模擬試験</h2><div class="mhist">${hist.map(m => { const v = Math.round(m.c / m.n * 100); return `<div><i style="height:${v}%" class="${v >= 60 ? "ok" : ""}"></i><span>${v}%</span><small>${fmtMD(m.t)}</small></div>`; }).join("")}<b style="bottom:60%"></b></div>` : ""}
      <h2 class="section-title">全問の答え合わせ<small>タップで解説</small></h2>
      <div class="missed">${items.map((it, k) => `<details class="missed-item${it.ok ? " okitem" : ""}"><summary>${it.ok ? "○" : "×"} 問${k + 1}　${esc(shortQ(it.q))}<div class="ans">あなたの答え：${ans(it, it.q)}　正解：${ansLabel(it.q)}</div></summary>
        <div class="sb">${factsHtml(it.q)}<p class="ex">${esc(it.q.e)}</p></div></details>`).join("")}</div>
      <p class="note" style="margin:-8px 2px 16px">間違えた問題は「今日の復習」に入りました。</p>
      <div class="actions"><button class="btn" id="mhome">科目のトップへ</button><button class="btn dark" id="magain">もう一度（別の問題で）</button></div>`;
    $app.querySelectorAll("[data-wnote]").forEach(b => b.onclick = () => { mock = null; go(b.dataset.wnote); });
    document.getElementById("mhome").onclick = () => { mock = null; go(S.id); };
    document.getElementById("magain").onclick = () => startMock(S);
    window.scrollTo(0, 0);
  }
  function mockHistHtml(S) {
    const hs = mk.filter(m => m.sid === S.id);
    if (!hs.length) return "";
    const last = hs[hs.length - 1], v = Math.round(last.c / last.n * 100);
    return `<p class="note" style="margin:-16px 2px 18px">模擬試験 ${hs.length}回・最新 ${fmtMD(last.t)} <b style="color:${v >= 60 ? "var(--accent)" : "var(--wrong)"}">${v}%</b>${hs.length > 1 ? `（${hs.slice(-5).map(m => Math.round(m.c / m.n * 100) + "%").join(" → ")}）` : ""}</p>`;
  }

  // ---------- 科目をまたぐつながり ----------
  // 同じ法律・人物・制度が他の科目でどう出たか
  let crossIdx = null;
  const TERM_RX = /(?:[一-鿿々ァ-ヶー・]|こども|ども){2,24}(?:法|条約|指針|宣言|要領|大綱|計画|ビジョン|手当|センター|憲章|報告|白書|プラン)/g;
  const KATA_RX = /[ァ-ヶ][ァ-ヶー]{3,}(?:・[ァ-ヶー]{2,})?/g;
  const TERM_NG = /(?:方法|技法|手法|療法|用法|文法|指導法|教授法|作法|育法|学習法|話法|観察法|面接法|調査法|検査法|測定法|実験法|計画法)$|^(?:同法|本法|この法|旧法|新法|各法|関係法|関連法|基本法|支援法|福祉法|保護法|ども)|^[・園]/;
  const KATA_NG = new Set(["メニュー", "テーマ", "グループ", "クラス", "サービス", "システム", "プログラム", "ケース", "スタッフ", "コミュニケーション", "ポイント", "イメージ", "バランス", "エネルギー", "ルール"]);
  function buildCross() {
    const idx = {};
    ALL.forEach(q => {
      const t = q.q + " " + (q.items || []).join(" ") + " " + (q.pool || []).join(" ") + " " + (isSimple(q) ? q.o[q.a] : "") + " " + q.e;
      const set = new Set();
      (t.match(TERM_RX) || []).forEach(w => { w = w.replace(/^(?:改正|旧|新|現行|同)/, ""); if (w.length >= 3 && !TERM_NG.test(w)) set.add(w); });
      (t.match(KATA_RX) || []).forEach(w => { if (!KATA_NG.has(w)) set.add(w); });
      set.forEach(w => { (idx[w] = idx[w] || []).push(q.id); });
    });
    Object.keys(idx).forEach(w => {
      const subs = new Set(idx[w].map(id => subjOfQ[id]));
      if (subs.size < 2 || idx[w].length > 70) delete idx[w];
    });
    crossIdx = idx;
  }
  function crossTerms(q) {
    if (!crossIdx) buildCross();
    const sid = subjOfQ[q.id], t = q.q + " " + (q.items || []).join(" ") + " " + (q.pool || []).join(" ") + " " + (isSimple(q) ? q.o[q.a] : "") + " " + q.e;
    return Object.keys(crossIdx).filter(w => t.includes(w) && crossIdx[w].some(id => subjOfQ[id] !== sid))
      .filter((w, i, arr) => !arr.some(x => x !== w && x.includes(w) && crossIdx[x].length >= crossIdx[w].length * 0.8)) // 長い語に含まれる短い語を除く
      .map(w => ({ w, other: crossIdx[w].filter(id => subjOfQ[id] !== sid) }))
      .sort((a, b) => new Set(b.other.map(id => subjOfQ[id])).size - new Set(a.other.map(id => subjOfQ[id])).size || b.w.length - a.w.length).slice(0, 3);
  }
  function crossHtml(q) {
    const ts = crossTerms(q);
    if (!ts.length) return "";
    return `<details class="sd"><summary>🧭 他の科目とのつながり</summary><div class="sb">${ts.map(x => {
      const by = {}; x.other.forEach(id => { (by[subjOfQ[id]] = by[subjOfQ[id]] || []).push(id); });
      const ex = qById[x.other[0]];
      return `<div class="xrow"><div><b>${esc(x.w)}</b> は ${Object.entries(by).map(([s, ids]) => `${esc(subjById[s].name)}（${ids.length}問）`).join("・")} にも出ています</div>
        <div class="xex">例：${esc(subjById[subjOfQ[ex.id]].name)}「${esc(shortQ(ex))}」</div>
        <button class="wbtn" data-cross="${esc(x.w)}">このセットの最後に${Math.min(4, x.other.length)}問追加</button></div>`;
    }).join("")}<p class="fact-tip">9科目を「まとめて」覚えると効率的です。</p></div></details>`;
  }
  function wireCross() {
    $app.querySelectorAll("[data-cross]").forEach(b => b.onclick = () => {
      if (!session) return;
      const w = b.dataset.cross, sid = subjOfQ[session.items[session.i].q.id];
      const have = new Set(session.items.map(x => x.q.id));
      const add = shuffle(crossIdx[w].filter(id => subjOfQ[id] !== sid && !have.has(id))).slice(0, 4).map(id => qById[id]);
      add.forEach(q => session.items.push(makeItem(q, "o")));
      b.disabled = true; b.textContent = add.length ? `✓ 最後に${add.length}問追加しました（科目横断）` : "追加できる問題はもうありません";
      session.back = null; // 科目をまたぐので、終わったらトップへ
      document.querySelector(".count").textContent = `${session.i + 1} / ${session.items.length}`;
      document.getElementById("next").textContent = nextLabel();
    });
  }

  // ---------- 用語集・年表 ----------
  const GLOSS = (window.GLOSSARY || []).map((g, i) => Object.assign({ i }, g));
  const GK = { person: "人物・理論", law: "法律・制度", guide: "指針・計画", intl: "国際" };
  function renderGlossary() {
    session = null; current = null;
    const st = { q: "", k: "", view: "list", card: null };
    const draw = () => {
      const qq = st.q.trim();
      let list = GLOSS.filter(g => (!st.k || g.k === st.k) && (!qq || (g.n + g.d + (g.y || "") + (g.a || "")).includes(qq)));
      if (st.view === "year") list = list.filter(g => g.yr).sort((a, b) => a.yr - b.yr || a.i - b.i);
      $app.querySelector("#glist").innerHTML = list.length ? list.map(g => `<div class="gi">
          <div class="gh">${st.view === "year" ? `<span class="gy">${g.yr}</span>` : ""}<b>${esc(g.n)}</b>${g.y && st.view !== "year" ? `<span class="gy2">${esc(g.y)}</span>` : st.view === "year" && g.y ? `<span class="gy2">${esc(g.y)}</span>` : ""}</div>
          <div class="gd">${esc(g.d)}</div>
          <div class="gs">${(g.s || []).map(s => subjById[s] ? `<span>${esc(subjById[s].name)}</span>` : "").join("")}<em>${GK[g.k] || ""}</em></div>
        </div>`).join("") : `<p class="note">見つかりませんでした。</p>`;
      $app.querySelectorAll("[data-gk]").forEach(b => b.classList.toggle("on", b.dataset.gk === st.k));
      $app.querySelectorAll("[data-gv]").forEach(b => b.classList.toggle("on", b.dataset.gv === st.view));
      document.getElementById("gcount").textContent = `${list.length}件`;
    };
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← トップ</button>
      <div class="brand"><span class="badge">📚 用語集・年表</span></div>
      <h1>用語集・年表</h1>
      <p class="lead">人物と理論、法律と制定年、指針・計画の改定年。直前期の暗記にも使えます。</p>
      <input type="search" id="gq" class="fi" placeholder="キーワードで検索（例：ピアジェ、1947、児童福祉法）">
      <div class="chips" style="margin:8px 0">${[["", "すべて"], ...Object.entries(GK)].map(([k, t]) => `<button class="chip" data-gk="${k}">${t}</button>`).join("")}</div>
      <div class="chips" style="margin:0 0 12px">${[["list", "一覧"], ["year", "年表（年の順）"]].map(([k, t]) => `<button class="chip" data-gv="${k}">${t}</button>`).join("")}<span class="gcount" id="gcount"></span></div>
      <button class="btn dark wide" id="gcard">🃏 暗記カード 10枚（年号・人物）</button>
      <div id="gcardbox"></div>
      <div class="glist" id="glist"></div>
      <p class="note">年は制定・公布（「施行」とあるものは施行）の年です。改定の多い指針・制度は、最新の内容を各分野の要点で確認してください。</p>
      ${footer()}`;
    document.getElementById("to-top").onclick = () => go(null);
    document.getElementById("gq").oninput = e => { st.q = e.target.value; draw(); };
    $app.querySelectorAll("[data-gk]").forEach(b => b.onclick = () => { st.k = b.dataset.gk; draw(); });
    $app.querySelectorAll("[data-gv]").forEach(b => b.onclick = () => { st.view = b.dataset.gv; draw(); });
    document.getElementById("gcard").onclick = () => {
      const deck = shuffle(GLOSS.filter(g => g.yr || g.k === "person")).slice(0, 10);
      let i = 0, flip = false, okN = 0;
      const box = document.getElementById("gcardbox");
      const show = () => {
        if (i >= deck.length) { box.innerHTML = `<div class="gcard done">おつかれさま！ ${okN} / ${deck.length} 枚 覚えていました。<button class="btn wide" id="gc-again" style="margin-top:8px">もう一度</button></div>`; document.getElementById("gc-again").onclick = () => document.getElementById("gcard").onclick(); return; }
        const g = deck[i];
        box.innerHTML = `<div class="gcard"><div class="gcn">${i + 1} / ${deck.length}</div>
          <div class="gcf">${esc(g.n)}<small>${g.k === "person" ? "何をした人？（理論・著作など）" : "何年？どんな内容？"}</small></div>
          ${flip ? `<div class="gcb">${g.y ? `<b>${esc(g.y)}</b>　` : ""}${esc(g.d)}</div><div class="actions"><button class="btn" id="gc-ng">あやふや</button><button class="btn dark" id="gc-ok">覚えていた</button></div>`
                 : `<button class="btn wide" id="gc-flip">答えを見る</button>`}</div>`;
        if (flip) { document.getElementById("gc-ok").onclick = () => { okN++; i++; flip = false; show(); }; document.getElementById("gc-ng").onclick = () => { deck.push(g); i++; flip = false; show(); }; }
        else document.getElementById("gc-flip").onclick = () => { flip = true; show(); };
      };
      show();
      box.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    draw();
    wireFooter();
    document.title = "用語集・年表｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  // ---------- 実技試験の準備 ----------
  const JITSUGI = [
    ["共通", [
      ["j-apply", "受験申請のときに、音楽・造形・言語の3分野から2分野を選んでいる（申請後は変更できない）"],
      ["j-guide", "その回の「受験の手引き」で課題・持ち物・日程を確認した（課題は回ごとに変わる）"],
      ["j-cond", "筆記試験の全科目合格（免除を含む）が受験の条件であることを確認した"],
      ["j-time", "本番と同じ時間で通して練習し、時間内に終える感覚をつかんだ"]
    ]],
    ["音楽", [
      ["m-song", "課題曲（例年2曲）の楽譜を用意し、歌詞を覚えた"],
      ["m-inst", "伴奏の楽器（ピアノ・ギター・アコーディオンなど、手引きで指定されたもの）を決めた"],
      ["m-arr", "弾きやすい伴奏・調に整えた（移調や簡易伴奏が認められるかを手引きで確認）"],
      ["m-kids", "子どもに向けて歌うつもりで、表情・声の大きさ・テンポを意識して通し練習した"],
      ["m-stop", "途中で間違えても止まらずに最後まで弾き歌いする練習をした"]
    ]],
    ["造形", [
      ["z-theme", "課題（保育の一場面）を、条件（人数・場面・表情など）に合わせて描く練習をした"],
      ["z-time", "例年の制限時間（45分程度）で、下描き→着彩→仕上げの時間配分を決めた"],
      ["z-tool", "指定の画材（例年は色鉛筆）をそろえ、色数・削り方などを準備した"],
      ["z-people", "保育者と子どもの表情・動き・服装を描き分けられる"],
      ["z-bg", "背景（室内・園庭など）まで描き込み、場面が伝わる構図にできる"]
    ]],
    ["言語", [
      ["g-story", "課題のお話（例年は昔話などから複数の候補）の中から1つを選んだ"],
      ["g-3min", "例年の形式（3歳児クラス程度の子どもを想定した、3分間のお話）で、時間ぴったりに話す練習をした"],
      ["g-nobook", "絵本や道具を使わない「素話（すばなし）」で話せる"],
      ["g-start", "はじめのあいさつ・題名の紹介・終わり方を決めた"],
      ["g-voice", "登場人物ごとの声・間・目線（子ども全体を見る）を意識して練習した"]
    ]]
  ];
  function renderJitsugi() {
    session = null; current = null;
    const on = k => ck[k] && ck[k].v;
    const total = JITSUGI.reduce((a, [, xs]) => a + xs.length, 0), done = JITSUGI.reduce((a, [, xs]) => a + xs.filter(([k]) => on(k)).length, 0);
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← トップ</button>
      <div class="brand"><span class="badge">🎹 実技試験</span></div>
      <h1>実技試験の準備チェック</h1>
      <p class="lead">筆記に合格したら、同じアプリで実技の準備まで。チェックした内容は記録に保存されます（${done} / ${total}）。</p>
      <div class="warn soft">課題・時間・画材などの具体的な内容は、その回の「受験の手引き」が正式な情報です。ここでは例年の形式をもとに、準備の観点をまとめています。</div>
      ${JITSUGI.map(([g, xs]) => `<h2 class="section-title">${g}</h2><div class="cklist">${xs.map(([k, t]) => `<label class="ckrow"><input type="checkbox" data-ck="${k}" ${on(k) ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div>`).join("")}
      ${footer()}`;
    document.getElementById("to-top").onclick = () => go(null);
    $app.querySelectorAll("[data-ck]").forEach(b => b.onchange = () => { ck[b.dataset.ck] = { v: b.checked ? 1 : 0, t: Date.now() }; saveLocal(); schedulePush(); });
    wireFooter();
    document.title = "実技試験の準備｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", e => {
    if (mock && !mock.done && document.querySelector(".mpal")) {
      const k = { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4 }[e.key];
      if (k !== undefined) mockSelect(k);
      else if (e.key === "ArrowRight" && mock.i + 1 < mock.items.length) { mock.i++; renderMock(); }
      else if (e.key === "ArrowLeft" && mock.i > 0) { mock.i--; renderMock(); }
      return;
    }
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
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
    return CODE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify({ s: stats, v: rv, f: fm, r: resetAt, rs: resets, l: log, cf, p: plan, mk, ck }))));
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
      const cleanF = {};
      Object.entries(obj.f && typeof obj.f === "object" ? obj.f : {}).forEach(([id, v]) => {
        if (v && typeof v === "object") cleanF[id] = { m: (+v.m || 0) & 255, t: +v.t || 0 };
      });
      stats = merge(stats, clean);
      rv = mergeRv(rv, cleanV);
      fm = mergeFm(fm, cleanF);
      const obj2 = o => o && typeof o === "object" && !Array.isArray(o) ? o : {};
      log = mergeLog(log, obj2(obj.l));
      cf = mergeT(cf, obj2(obj.cf));
      if (obj.p && typeof obj.p === "object" && typeof obj.p.exam === "string") plan = mergePlan(plan, obj.p);
      mk = mergeMk(mk, Array.isArray(obj.mk) ? obj.mk : []);
      ck = mergeT(ck, obj2(obj.ck));
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
      subjById[resetTarget].questions.forEach(q => { delete stats[q.id]; delete rv[q.id]; delete fm[q.id]; delete cf[q.id]; });
      mk = mk.filter(m => m.sid !== resetTarget);
    } else { stats = {}; rv = {}; fm = {}; cf = {}; log = {}; mk = []; ck = {}; resetAt = now; } // 学習プランの設定は残す
    saveLocal(); push();
    modal.classList.remove("show"); route();
  };

  if (/[?&]debug\b/.test(location.search)) window.__hk = { start, qById, variantOf, kindsOf, hotLevel, targetForms, ALL, drillItems, phasesOf, outlook, menuItems, mockPick, crossTerms, signal, get plan() { return plan; }, get log() { return log; } };
  route();
})();
