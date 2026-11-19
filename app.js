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
  // me:    先生に送るときの名前 { id: 生徒ごとの識別子, nick, t }
  // tf:    先生からの返信 { fb:[{id,t,fr,txt}] コメント, asg:[課題], done:{課題ID:t}, imp:{返信ID:t}, seen: t }
  let stats = {}, rv = {}, fm = {}, resetAt = 0, resets = {}, log = {}, cf = {}, plan = null, mk = [], ck = {}, me = null, tf = { fb: [], asg: [], done: {}, imp: {}, seen: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
    if (raw.stats) {
      stats = raw.stats; rv = raw.rv || {}; fm = raw.fm || {}; resetAt = raw.resetAt || 0; resets = raw.resets || {};
      log = raw.log || {}; cf = raw.cf || {}; plan = raw.plan || null; mk = raw.mk || []; ck = raw.ck || {};
      me = raw.me || null; tf = mergeTf(null, raw.tf);
    }
    else stats = raw;
  } catch (e) { stats = {}; }
  function saveLocal() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ stats, rv, fm, resetAt, resets, log, cf, plan, mk, ck, me, tf })); } catch (e) {} }

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
  // 先生からの返信：コメント・課題はIDで重ねる（消えない）。完了は早いほう
  function mergeTf(a, b) {
    a = a || {}; b = b || {};
    const byId = (x, y) => { const m = {}; (x || []).concat(y || []).forEach(o => { if (o && o.id && !m[o.id]) m[o.id] = o; }); return Object.values(m).sort((p, q) => (p.t || 0) - (q.t || 0)); };
    const minT = (x, y) => { const o = Object.assign({}, x); Object.entries(y || {}).forEach(([k, v]) => { if (!o[k] || v < o[k]) o[k] = v; }); return o; };
    return { fb: byId(a.fb, b.fb).slice(-60), asg: byId(a.asg, b.asg).slice(-120), done: minT(a.done, b.done), imp: minT(a.imp, b.imp), seen: Math.max(a.seen || 0, b.seen || 0) };
  }
  // me：新しいほうを優先しつつ、片方にしかない項目（提出用の鍵など）も残す
  const mergeMe = (a, b) => !a ? b || null : !b ? a : ((a.t || 0) >= (b.t || 0) ? Object.assign({}, b, a, { id: a.id || b.id }) : Object.assign({}, a, b, { id: a.id || b.id }));
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
  let tdocRef = null, docRef = null, syncState = "connecting", writing = false, dirty = false, pushTimer = null;
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
  const snapshot = () => JSON.stringify([stats, rv, fm, resetAt, resets, log, cf, plan, mk, ck, me, tf]);
  const plain = o => JSON.parse(JSON.stringify(o));
  function schedulePush() { if (!docRef) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); }
  async function push() {
    if (!docRef) return;
    if (writing) { dirty = true; return; }
    writing = true;
    try {
      await docRef.set({ stats: plain(stats), rv: plain(rv), fm: plain(fm), resetAt, resets: Object.assign({}, resets), log: plain(log), cf: plain(cf), plan: plan ? plain(plan) : null, mk: plain(mk), ck: plain(ck), me: me ? plain(me) : null, tf: plain(tf), updatedAt: Date.now() });
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
    me = mergeMe(me, body.me || null);
    tf = mergeTf(tf, body.tf || null);
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
      if (!remote || JSON.stringify([remote.stats || {}, remote.rv || {}, remote.fm || {}, remote.resetAt || 0, remote.resets || {}, remote.log || {}, remote.cf || {}, remote.plan || null, remote.mk || [], remote.ck || {}, remote.me || null, remote.tf || null]) !== snapshot()) await push();
      setSync("on");
      if (changed && !session) route();
      ref.onSnapshot(s => {
        if (!s.exists || s.metadata.hasPendingWrites) return;
        if (absorb(s.data()) && !session) route();
      }, () => { setSync("err"); docRef = null; });
      // 指導者ページのデータ（取り込んだレポート・送った返信）も、ログイン中は端末間で同期
      try {
        const tref = db.collection("data/users/" + uid).doc("teacher");
        const ts = await tref.get();
        tdocRef = tref;
        const tchanged = ts.exists && absorbTeacher(ts.data());
        if (Object.keys(tch.sts).length || tch.name || (tch.all || []).length) pushTeacher();
        if (tchanged && !session && /^#teacher/.test(location.hash)) route();
      } catch (e) { tdocRef = null; }
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
    const raw = (location.hash || "").replace(/^#/, "");
    if (/^r=/.test(raw)) { // 生徒から届いたレポートのリンク（指導者ページが開いているときだけ取り込む）
      if (!tKey) { pendingReport = raw.slice(2); replaceHash("teacher"); return renderTLock(); }
      return linkImport(raw.slice(2));
    }
    if (/^j=/.test(raw)) { pendingJoin = raw.slice(2); replaceHash("send"); return renderSend(); } // 教室への参加リンク
    if (/^f=/.test(raw)) { pendingReply = raw.slice(2); replaceHash("send"); return renderSend(); } // 先生からの返信のリンク
    const [id, sub, third] = raw.split("/");
    const S = subjById[id];
    if (S && sub && S.categories.some(c => c.id === sub)) renderNote(S, S.categories.find(c => c.id === sub));
    else if (S) renderSubject(S);
    else if (id === "plan") sub === "setup" ? renderSetup() : renderPlan();
    else if (id === "cram") renderCram();
    else if (id === "digest") renderDigest(sub);
    else if (id === "glossary") renderGlossary();
    else if (id === "jitsugi") renderJitsugi();
    else if (id === "send") renderSend();
    else if (id === "teacher") {
      if (!tKey) renderTLock();
      else if (sub === "s" && tch.sts[third]) renderTStudent(third);
      else if (sub === "print" && tch.sts[third]) renderTPrint(third);
      else if (sub === "class") renderTClass();
      else if (sub === "all") renderTAll();
      else renderTeacher();
    }
    else renderTop();
  }
  window.addEventListener("hashchange", () => { session = null; route(); });
  function replaceHash(h) { try { history.replaceState(null, "", location.pathname + location.search + (h ? "#" + h : "")); } catch (e) {} }
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
      title, back: current ? current.id : null, review: !!opts.review, theme: opts.theme || null, menu: opts.menu || null, asg: opts.asg || null,
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
      <div class="foot">${syncBadge()}<span class="links"><button class="link-btn" id="xfer-open">記録の引き継ぎ</button><button class="link-btn" id="to-teacher">指導者ページ（先生用）</button><button class="link-btn" id="reset">${current ? "この科目の記録をリセット" : "すべての記録をリセット"}</button></span></div>`;
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
    document.getElementById("to-teacher").onclick = () => go("teacher");
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
      ${fbCardHtml()}
      ${!plan && asgMenuItems().length ? asgBoxHtml() : ""}
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
        <button class="tool" data-go="send"><span>✉️</span><b>先生に送る</b><small>学習レポート・先生からの返信</small></button>
      </div>
      ${footer()}`;
    if (plan) wireMenu(plan); else wireAsgBox();
    wireFbCard();
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
    if (session.asg && r.length) { markAsg(session.asg); session.asg = null; }
    if (r.length) maybeAutoSubmit(true);
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
  const logRef = () => log;
  function streak(src) {
    src = src || log;
    let n = 0, i = src[dayKey(Date.now())] && src[dayKey(Date.now())].n ? 0 : 1;
    for (; ; i++) { const L = src[dayKey(Date.now() - i * DAY)]; if (L && L.n) n++; else break; }
    return n;
  }
  function calendarHtml(weeks, src) {
    weeks = weeks || 18;
    const log = src || logRef(); // 指導者ページでは生徒のレポートの記録を表示
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
    let wk = 0; for (let i = 0; i < 7; i++) { const L = log[dayKey(Date.now() - i * DAY)]; if (L) wk += L.n || 0; }
    const act = Object.values(log).filter(L => L.n).length;
    return `<div class="calbox">
      <div class="calhead"><b>🔥 ${streak(log)}日連続</b><span>この7日間 ${wk}問・学習した日 ${act}日</span></div>
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
  const allMenuItems = p => (daysTo(p.exam) >= -1 ? asgMenuItems() : []).concat(menuItems(p));
  function menuHtml(p, compact) {
    const items = allMenuItems(p), D = daysTo(p.exam);
    const { cur } = phaseNow(p);
    const head = D > 0 ? `受験日まで <b>${D}日</b>　<span class="phase p${cur.k}">${cur.name}期</span>` : D === 0 ? "<b>試験1日目</b>" : D === -1 ? "<b>試験2日目</b>" : "試験日を過ぎました";
    let body;
    if (D < -1) body = `<p class="mnote">おつかれさまでした。結果が出たら、合格した科目を入れて次の回の計画を作りましょう。</p><button class="btn dark wide" data-go="plan/setup">結果を入れて次の計画へ</button>`;
    else if (D === -1) body = `<p class="mnote">2日目の科目、がんばってください。</p>`;
    else if (!items.length) body = `<p class="mnote">受験科目を選ぶと、毎日のメニューが出ます。</p>`;
    else if (D < 0) body = "";
    else body = items.map((x, i) => `<div class="mi${x.done ? " done" : ""}${x.off ? " off" : ""}">
        <button class="mbtn" data-mi="${i}" ${x.off ? "disabled" : ""}>${x.badge ? `<span class="mbadge${/^a:/.test(x.key) ? " t" : ""}">${x.badge}</span>` : ""}<span class="mt">${x.done ? "✓ " : ""}${esc(x.t)}</span><span class="md">${esc(x.d)}</span></button>
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
    const items = allMenuItems(p);
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
  function startMock(S, menuKey, asgId) {
    const qs = mockPick(S);
    if (!qs.length) return;
    session = null;
    mock = { S, items: qs.map(q => ({ q, sel: [], chosen: null })), i: 0, t0: Date.now(), limit: examMin(S) * 60000, menu: menuKey || null, asg: asgId || null, timer: null };
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
    if (mock.asg) markAsg(mock.asg);
    maybeAutoSubmit(true);
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

  // =====================================================================
  // 指導者フィードバック（A方式：サーバーを使わず、コードを送り合う）
  //   生徒：「先生に送る」→ 学習の要約を詰めたレポートコード（HKR1:）をLINE等で送る
  //   先生：指導者ページに貼る → 一覧・声かけ・詳細・クラス共通のつまずき・面談用レポート
  //         → コメント・課題・受験科目の変更を返信コード（HKT1:）で返す
  //   生徒：返信コードを貼る → コメントはトップに、課題は今日のメニューに入る
  // =====================================================================
  const REP_PREFIX = "HKR1:", REPLY_PREFIX = "HKT2:", OLD_REPLY_PREFIX = "HKT1:", TBK_PREFIX = "HKB1:";
  const TEACHER_KEY = "hoikushi-teacher-v1";
  const SHORT = { "hoiku-genri": "原理", "kyouiku-genri": "教育", "shakaiteki-yougo": "養護", "kodomo-katei-fukushi": "家福", "shakai-fukushi": "社福", "hoiku-shinri": "心理", "kodomo-hoken": "保健", "shoku-eiyou": "栄養", "jisshu-riron": "実習" };
  const SJ_CODE = { now: "n", later: "l", pass: "p" }, SJ_FROM = { n: "now", l: "later", p: "pass" };
  const SJ_NAME = { now: "今回", later: "次の回", pass: "免除" };
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function ensureMe() { if (!me || !me.id) { me = { id: rid(), nick: "", t: Date.now() }; saveLocal(); schedulePush(); } return me; }
  const fmtDT = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const ago = t => { const n = Math.round((today0() - dayStart(t)) / DAY); return n <= 0 ? "今日" : n === 1 ? "昨日" : n + "日前"; };
  const nl = s => esc(s).replace(/\n/g, "<br>");

  // ---------- コードの圧縮と読み取り ----------
  const b64u = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  async function viaStream(bytes, st) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(st)).arrayBuffer()); }
  async function pack(prefix, obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== "undefined") { try { return prefix + "z" + b64u(await viaStream(bytes, new CompressionStream("deflate-raw"))); } catch (e) {} }
    return prefix + "j" + b64u(bytes);
  }
  async function unpackOne(kind, data) {
    let bytes = unb64u(data);
    if (kind === "z") {
      if (typeof DecompressionStream === "undefined") throw new Error("old");
      bytes = await viaStream(bytes, new DecompressionStream("deflate-raw"));
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  // 貼り付けた文章・リンクの中からコードを全部探す（改行で切れていても読めるように空白は除く）
  function findCodes(prefix, text) {
    let s = String(text || "").replace(/\s+/g, "");
    try { s = decodeURIComponent(s); } catch (e) {}
    const head = prefix.slice(0, -1); // 続けて貼られた次のコードの頭（HKR1: など）で区切る
    const rx = new RegExp(head + ":([zj])((?:(?!" + head + ":)[A-Za-z0-9_-])+)", "g"), out = [];
    let m; while ((m = rx.exec(s))) out.push([m[1], m[2]]);
    return out;
  }
  const appLink = () => (/^https:$/.test(location.protocol) && window.top === window.self && !/claude/.test(location.hostname)) ? location.origin + location.pathname : "";
  function codeOutHtml(code, linkHash, what) {
    const link = appLink();
    return `<textarea class="fi codebox" readonly id="co-text">${esc(code)}</textarea>
      <div class="codebtns">
        <button class="btn dark" id="co-copy">コードをコピー</button>
        ${navigator.share ? `<button class="btn" id="co-share">LINEなどで送る</button>` : ""}
        ${link ? `<button class="btn" id="co-link">リンクをコピー</button>` : ""}
      </div>
      <p class="fh">${code.length.toLocaleString()}文字。${what}${link ? "リンクで送ると、相手はタップするだけで取り込めます。" : ""}</p>`;
  }
  function wireCodeOut(code, linkHash, title) {
    const link = appLink() ? appLink() + "#" + linkHash + "=" + code : "";
    const copy = async (txt, btn, done) => {
      try { await navigator.clipboard.writeText(txt); btn.textContent = done; }
      catch (e) { const ta = document.getElementById("co-text"); ta.focus(); ta.select(); btn.textContent = "選択しました。長押しでコピー"; }
    };
    const c = document.getElementById("co-copy"); if (c) c.onclick = () => copy(code, c, "コピーしました ✓");
    const l = document.getElementById("co-link"); if (l) l.onclick = () => copy(link, l, "リンクをコピーしました ✓");
    const sh = document.getElementById("co-share");
    if (sh) sh.onclick = () => { navigator.share({ title, text: link ? title + "\n" + link : title + "\n" + code }).catch(() => {}); };
  }

  // ---------- 生徒：レポートを作る ----------
  function buildReport() {
    ensureMe();
    const now = Date.now(), d = {};
    for (let i = 0; i < 42; i++) { const k = dayKey(now - i * DAY), L = log[k]; if (L && L.n) d[k] = [L.n, L.c, Math.round((L.ms || 0) / 60000)]; }
    const s = {};
    SUBJ.forEach(S => {
      const sm = summary(S.questions), tgt = plan && plan.subj[S.id] === "now";
      if (!sm.tried && !tgt) return;
      const sg = signal(S);
      s[S.id] = [sm.tried, sm.total, sm.c, sm.w, S.questions.filter(inQueue).length, S.questions.filter(isDue).length, sg.lv, sg.rate, sg.u, sg.mp];
    });
    const wk = [];
    SUBJ.forEach(S => S.categories.forEach(c => {
      const sm = summary(S.questions.filter(q => q.c === c.id));
      if (sm.c + sm.w >= 4 && sm.rate < 70) wk.push([S.id, c.id, sm.rate, sm.c + sm.w]);
    }));
    wk.sort((a, b) => a[2] - b[2]);
    const since = now - 30 * DAY, r = { k: 0, y: 0, m: 0, u: 0 };
    let g = 0;
    Object.values(cf).forEach(x => { if (!x || (x.t || 0) < since) return; if (x.r && r[x.r] !== undefined) r[x.r]++; if (x.g) g++; });
    const gq = Object.entries(cf).filter(([id, x]) => x && x.g && qById[id]).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(0, 15).map(([id]) => id);
    const x = Object.keys(stats).filter(id => qById[id] && (stats[id].last === false || (rv[id] && rv[id].s > 0 && !rv[id].f)))
      .sort((a, b) => (stats[b].t || 0) - (stats[a].t || 0)).slice(0, 80);
    let p = null;
    if (plan) {
      const ol = outlook(plan);
      p = { ex: plan.exam, tpl: plan.tpl, sj: SUBJ.map(S => SJ_CODE[plan.subj[S.id]] || "n").join(""), ph: ol.cur.k, lag: Math.max(0, ol.lag || 0), big: ol.lagBig ? 1 : 0,
        wn: ol.warn ? ol.warn.mockDays : null, cap: ol.cap, un: ol.unseen, wd: plan.wd, we: plan.we, goal: plan.goal || "" };
    }
    return { v: 1, id: me.id, nk: me.nick || "", t: now, d, s, wk: wk.slice(0, 8), r, g, gq, x, p,
      mk: mk.slice(-20).map(m => [m.sid, m.t, m.n, m.c, m.up ? 1 : 0]), a: Object.assign({}, tf.done),
      tot: Object.values(log).reduce((a2, L) => a2 + (L.n || 0), 0) };
  }

  // ---------- 生徒：先生の課題 ----------
  function asgLabel(a) {
    const S = subjById[a.sid], c = S && S.categories.find(x => x.id === a.c), th = S && (S.themes || []).find(x => x.id === a.th);
    const main = a.k === "cat" && c ? `${S.name}「${c.name}」${a.n}問`
      : a.k === "theme" && th ? `頻出テーマ「${th.name.replace(/（.*$/, "")}」${a.n}問`
      : a.k === "mock" && S ? `模擬試験：${S.name}`
      : a.k === "note" && c ? `${S.name}「${c.name}」の要点を読む`
      : a.k === "rv" ? "「今日の復習」を片付ける"
      : a.k === "free" ? (a.txt || "自由課題") : "課題";
    return main;
  }
  const asgNote = a => a.k === "free" ? "" : (a.txt || "");
  function markAsg(id) {
    if (!id || tf.done[id]) return;
    tf.done[id] = Date.now();
    saveLocal(); schedulePush();
  }
  function runAsg(a) {
    const S = subjById[a.sid];
    current = null;
    const title = "先生の課題：" + asgLabel(a);
    if (a.k === "cat" && S) {
      const qs = S.questions.filter(q => q.c === a.c);
      const rank = q => isWeakQ(q) ? 0 : !stats[q.id] ? 1 : (cf[q.id] && cf[q.id].g) ? 2 : 3;
      return start(title, shuffle(qs).sort((x, y) => rank(x) - rank(y)).slice(0, a.n || 10), { keep: true, asg: a.id });
    }
    if (a.k === "theme" && S) {
      const th = (S.themes || []).find(x => x.id === a.th);
      if (th) { const qs = th.qs.map(id => qById[id]).filter(Boolean); return start(title, drillItems(qs, Math.min(a.n || 10, qs.length)), { keep: true, theme: th, asg: a.id }); }
    }
    if (a.k === "mock" && S) return startMock(S, null, a.id);
    if (a.k === "note" && S) { markAsg(a.id); return go(`${a.sid}/${a.c}`); }
    if (a.k === "rv") {
      const pool = reviewPool(plan ? targetQs(plan) : ALL);
      if (pool.length) return start("先生の課題：今日の復習", pool, { review: true, asg: a.id });
      markAsg(a.id); return route();
    }
    markAsg(a.id); route(); // 自由課題は「やった」で完了
  }
  // 今日のメニューに並べる先生の課題（未完了と、完了して3日以内のもの）
  function asgMenuItems() {
    const now = Date.now();
    return tf.asg.filter(a => !tf.done[a.id] || now - tf.done[a.id] < 3 * DAY).slice(-8).map(a => ({
      key: "a:" + a.id, badge: "先生の課題", t: asgLabel(a), done: !!tf.done[a.id],
      d: ((asgNote(a) ? "「" + asgNote(a) + "」" : "") + (a.due ? `　期限 ${fmtMD(parseDay(a.due))}` : "") + (a.k === "free" && !tf.done[a.id] ? "　終わったらタップ" : "")).trim(),
      note: (a.k === "cat" || a.k === "note") && a.c ? `${a.sid}/${a.c}` : null,
      run: () => runAsg(a)
    }));
  }
  function asgBoxHtml() {
    const items = asgMenuItems();
    return `<div class="menu"><div class="mh"><span class="mtitle">👩‍🏫 先生の課題</span><span class="mcount">${items.filter(x => x.done).length} / ${items.length} 完了</span></div>
      ${items.map((x, i) => `<div class="mi${x.done ? " done" : ""}"><button class="mbtn" data-ai="${i}"><span class="mbadge t">${x.badge}</span><span class="mt">${x.done ? "✓ " : ""}${esc(x.t)}</span>${x.d ? `<span class="md">${esc(x.d)}</span>` : ""}</button>
        ${x.note ? `<button class="mnote-btn" data-go="${x.note}">📖<span>要点</span></button>` : ""}</div>`).join("")}</div>`;
  }
  function wireAsgBox() {
    const items = asgMenuItems();
    $app.querySelectorAll("[data-ai]").forEach(b => b.onclick = () => items[+b.dataset.ai].run());
  }
  // トップの「先生から」カード（14日以内の最新のコメント）
  function fbCardHtml() {
    const f = tf.fb[tf.fb.length - 1];
    if (!f || Date.now() - f.t > 14 * DAY) return "";
    const unseen = f.t > (tf.seen || 0);
    return `<div class="fbcard${unseen ? " new" : ""}"><div class="fbh"><b>👩‍🏫 ${esc(f.fr || "先生")}から</b><span>${fmtMD(f.t)}${unseen ? '<i class="fbnew">新着</i>' : ""}</span></div>
      <div class="fbt">${nl(f.txt)}</div>
      <div class="fbf">${unseen ? `<button class="link-btn" id="fb-seen">読みました</button>` : ""}<button class="link-btn" data-go="send">これまでのメッセージ・先生に送る →</button></div></div>`;
  }
  function wireFbCard() {
    const b = document.getElementById("fb-seen");
    if (b) b.onclick = () => { tf.seen = Date.now(); saveLocal(); schedulePush(); route(); };
  }

  // ---------- 生徒：返信を取り込む ----------
  const ASG_KINDS = ["cat", "theme", "mock", "note", "rv", "free"];
  function cleanAsg(a, o) {
    if (!a || typeof a !== "object" || !ASG_KINDS.includes(a.k)) return null;
    return { id: String(a.id || rid()).slice(0, 40), t: +o.t || Date.now(), k: a.k, sid: subjById[a.sid] ? a.sid : null, c: a.c ? String(a.c).slice(0, 40) : null,
      th: a.th ? String(a.th).slice(0, 60) : null, n: Math.max(1, Math.min(60, +a.n || 10)), txt: String(a.txt || "").slice(0, 300), due: /^\d{4}-\d\d-\d\d$/.test(a.due || "") ? a.due : "", fr: String(o.fr || "").slice(0, 30) };
  }
  function replySummary(o) {
    const out = [];
    if (o.c) out.push("コメント");
    if ((o.a || []).length) out.push(`課題${o.a.length}件`);
    if (o.sj && Object.keys(o.sj).length) out.push("受験科目の変更：" + Object.entries(o.sj).filter(([k]) => subjById[k]).map(([k, v]) => `${subjById[k].name}→${SJ_NAME[v] || v}`).join("、"));
    if (o.wd != null || o.we != null) out.push(`1日の時間の変更：${o.wd != null ? "平日" + o.wd + "分" : ""}${o.we != null ? " 週末" + o.we + "分" : ""}`);
    return out;
  }
  function applyTeacherPlan(o) {
    const now = Date.now(), by = "teacher", label = { now: "今回の受験科目に", later: "次の回に", pass: "免除（合格済み）に" };
    let p = plan ? JSON.parse(JSON.stringify(plan)) : null, created = false, subjChanged = false;
    if (!p) {
      const ex = PRESETS[0].d;
      p = { exam: ex, tpl: recommendTpl(daysTo(ex)), wd: 30, we: 90, goal: "", subj: Object.fromEntries(SUBJ.map(s => [s.id, "now"])), day1: DAY1_DEFAULT.slice(), hist: [], start: now };
      created = true;
    }
    p.hist = p.hist || [];
    if (o.sj) SUBJ.forEach(s => {
      const v = o.sj[s.id];
      if (v && label[v] && p.subj[s.id] !== v) { p.subj[s.id] = v; p.hist.push({ t: now, by, sid: s.id, v, txt: `${s.name}を${label[v]}変更` }); subjChanged = true; }
    });
    if (o.wd != null && +o.wd !== p.wd) { p.hist.push({ t: now, by, txt: `平日の時間を${p.wd}分から${+o.wd}分に変更` }); p.wd = +o.wd; }
    if (o.we != null && +o.we !== p.we) { p.hist.push({ t: now, by, txt: `週末の時間を${p.we}分から${+o.we}分に変更` }); p.we = +o.we; }
    if (!Object.values(p.subj).includes("now")) return false;
    if (created) p.hist.unshift({ t: now, by, txt: `学習プランを作成（受験日 ${fmtMD(parseDay(p.exam))}・受験日は設定で確認してください）` });
    p.hist = p.hist.slice(-50); p.t = now;
    if (created || subjChanged) p.b = { t: now, tried: targetQs(p).filter(q => stats[q.id]).length };
    plan = p;
    return true;
  }
  function applyReply(o) {
    tf.imp[o.id] = Date.now();
    if (o.c) tf.fb.push({ id: o.id, t: +o.t || Date.now(), fr: String(o.fr || "").slice(0, 30), txt: String(o.c).slice(0, 2000) });
    (Array.isArray(o.a) ? o.a : []).forEach(a => { const x = cleanAsg(a, o); if (x && !tf.asg.some(y => y.id === x.id)) tf.asg.push(x); });
    if ((o.sj && Object.keys(o.sj).length) || o.wd != null || o.we != null) applyTeacherPlan(o);
    tf = mergeTf(tf, null);
    saveLocal(); schedulePush();
  }
  async function readReplies(text) {
    ensureMe();
    const codes = findCodes(REPLY_PREFIX, text), res = [];
    findCodes(OLD_REPLY_PREFIX, text).forEach(() => res.push({ st: "unsigned" }));
    for (const [k, d] of codes) {
      try {
        if (!hasCrypto()) { res.push({ st: "nocrypto" }); continue; }
        const w = await unpackOne(k, d), o = await verifyReply(w);
        if (!o) { res.push({ st: "unsigned" }); continue; }
        if (!o.id) throw new Error("shape");
        const st = tf.imp[o.id] ? "done" : (o.to === "*" || o.to === me.id) ? "ok" : "other";
        res.push({ o, st });
      } catch (e) { res.push({ st: e && e.message === "old" ? "old" : "bad" }); }
    }
    return { codes: res.length, res };
  }

  // ---------- 生徒：先生に送る画面 ----------
  let pendingReply = "";
  function renderSend() {
    session = null; current = null; ensureMe();
    const fbs = tf.fb.slice().reverse(), asgs = tf.asg.slice().reverse(), srv = me.srv;
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← トップ</button>
      <div class="brand"><span class="badge">✉️ 先生とのやりとり</span></div>
      <h1>先生に送る・先生から受け取る</h1>
      <p class="lead">${srv ? `「${esc(srv.n || "教室")}」に参加しています。「提出する」を押すと、学習の状況が先生に届きます。先生からの返信は、アプリを開くと自動で届きます。`
        : "先生からもらった「教室への参加リンク」を開くと、アプリから直接提出できるようになります。参加していなくても、レポートコードをLINEやメールで送れます。"}</p>
      <div id="s-join"></div>
      ${fbs.length ? `<h2 class="section-title">先生からのメッセージ</h2><div class="fblist">${fbs.slice(0, 10).map(f => `<div class="fbitem"><div class="fbh"><b>${esc(f.fr || "先生")}</b><span>${fmtMD(f.t)}</span></div><div class="fbt">${nl(f.txt)}</div></div>`).join("")}</div>` : ""}
      ${asgs.length ? `<h2 class="section-title">先生の課題<small>${asgs.filter(a => tf.done[a.id]).length} / ${asgs.length} 完了</small></h2>
        <div class="asglist">${asgs.slice(0, 20).map(a => `<div class="asgrow${tf.done[a.id] ? " done" : ""}"><span>${tf.done[a.id] ? "✓" : "□"}</span><div><b>${esc(asgLabel(a))}</b>${asgNote(a) ? `<small>「${esc(asgNote(a))}」</small>` : ""}<small>${fmtMD(a.t)}に受け取り${a.due ? "・期限 " + fmtMD(parseDay(a.due)) : ""}${tf.done[a.id] ? "・" + fmtMD(tf.done[a.id]) + "に完了" : ""}</small></div>${tf.done[a.id] ? "" : `<button class="wbtn" data-run="${esc(a.id)}">${a.k === "free" ? "やった" : "始める"}</button>`}</div>`).join("")}</div>` : ""}
      <h2 class="section-title">① 先生に${srv ? "提出する" : "レポートを送る"}</h2>
      <div class="form">
        <label class="fl">ニックネーム<small>本名でなくてかまいません。先生がわかる名前に</small></label>
        <input id="s-nick" class="fi" maxlength="20" value="${esc(me.nick || "")}" placeholder="例：ゆうこ" style="width:100%">
        <label class="fl">先生に見えるもの</label>
        <ul class="sendlist">
          <li>ニックネームと、${srv ? "提出" : "レポートを作っ"}た日時</li>
          <li>直近6週間の、日ごとの問題数・正答数・学習時間</li>
          <li>科目ごとの成績（挑戦した数・正答率・合格ライン信号・最頻出テーマの理解度・復習の数）と苦手分野</li>
          <li>間違いの理由の内訳、迷って正解した数</li>
          <li>間違えた問題・迷って正解した問題の番号（先生のアプリで同じ問題を開くため）</li>
          <li>模擬試験の結果、学習プラン（受験日・受験科目・段階・遅れ）、先生の課題が終わったかどうか</li>
        </ul>
        <p class="fh">送らないもの：本名・メールアドレス・端末の情報、1問ごとの解答の細かい記録。${srv ? "提出したレポートは先生のGoogleスプレッドシートに保存され、指導者ページのパスコードを知っている先生だけが読めます。" : "レポートはどこにも保存されず、コードを受け取った人だけが読めます。送り先をまちがえないようにしてください。"}</p>
        <details class="howto" id="s-prevd"><summary>先生の画面での見え方を確認する</summary><div id="s-prev"></div></details>
        <label class="ckrow consent"><input type="checkbox" id="s-ok"${srv && me.auto ? " checked" : ""}><span>内容を確認しました。先生に送ります</span></label>
        ${srv ? `<button class="btn dark wide" id="s-submit" ${me.auto ? "" : "disabled"} style="background:var(--accent);border-color:var(--accent)">📮 提出する</button>
          <label class="ckrow consent"><input type="checkbox" id="s-auto"${me.auto ? " checked" : ""}><span>これからは、アプリを開いたときと学習のあとに自動で提出する（1日1回〜3時間おき）</span></label>
          <p class="fh" id="s-last">${me.lastSub ? `前回の提出：${fmtDT(me.lastSub)}（${ago(me.lastSub)}）` : "まだ提出していません。"}</p>` : ""}
        <button class="btn ${srv ? "" : "dark "}wide" id="s-make" disabled>${srv ? "かわりにレポートコードを作る（LINEなどで送る）" : "レポートコードを作る"}</button>
        <p class="fh" id="s-msg"></p>
        <div id="s-out"></div>
      </div>
      <h2 class="section-title" style="margin-top:22px">② 教室（提出先）</h2>
      <div class="form" style="padding-top:12px">
        ${srv ? `<p style="margin:0 0 6px">📮 <b>${esc(srv.n || "教室")}</b> に参加しています${srv.t ? `（${fmtMD(srv.t)}から）` : ""}</p>
          <div class="codebtns"><button class="btn" id="s-inbox">先生からの返信を確認する</button><button class="btn" id="s-leave">教室から抜ける</button></div>
          <p class="fh" id="s-inmsg"></p>`
        : `<label class="fl" style="margin-top:0">先生からもらった参加リンク（または参加コード HKJ1:…）を貼る</label>
          <textarea id="s-jin" class="fi codebox"></textarea>
          <button class="btn wide" id="s-jread" style="margin-top:6px">参加する</button>
          <p class="fh" id="s-jmsg"></p>`}
      </div>
      <h2 class="section-title" style="margin-top:22px">③ 返信コードを取り込む<small>先生からコードで届いたとき</small></h2>
      <div class="form" style="padding-top:12px">
        <textarea id="s-in" class="fi codebox" placeholder="先生から届いた返信コード（HKT2:…）を貼り付け">${esc(pendingReply)}</textarea>
        <div id="s-inres"></div>
        <button class="btn dark wide" id="s-read" style="margin-top:8px">読み取る</button>
      </div>
      ${footer()}`;
    const q = id => document.getElementById(id);
    q("to-top").onclick = () => go(null);
    $app.querySelectorAll("[data-run]").forEach(b => b.onclick = () => { const a = tf.asg.find(x => x.id === b.dataset.run); if (a) runAsg(a); });
    const nick = q("s-nick"), ok = q("s-ok"), mk2 = q("s-make"), sub = q("s-submit"), msg = q("s-msg");
    const upd = () => { mk2.disabled = !ok.checked; if (sub) sub.disabled = !ok.checked; };
    ok.onchange = upd; upd();
    nick.onchange = () => { me.nick = nick.value.trim().slice(0, 20); me.t = Date.now(); saveLocal(); schedulePush(); };
    const needNick = () => { const nv = nick.value.trim().slice(0, 20); if (!nv) { msg.textContent = "ニックネームを入れてください。"; msg.style.color = "var(--wrong)"; nick.focus(); return null; } if (nv !== me.nick) { me.nick = nv; me.t = Date.now(); saveLocal(); schedulePush(); } return nv; };
    q("s-prevd").ontoggle = e => { if (e.target.open) { const r = buildReport(); r.nk = nick.value.trim() || "（ニックネーム）"; q("s-prev").innerHTML = `<div class="tprev">${studentBodyHtml(r, { preview: true })}</div>`; } };
    mk2.onclick = async () => {
      const nv = needNick(); if (!nv) return;
      mk2.disabled = true; mk2.textContent = "作成中…";
      const code = await pack(REP_PREFIX, buildReport());
      msg.textContent = "";
      q("s-out").innerHTML = `<div class="codeout">${codeOutHtml(code, "r", "このコードを先生に送ってください。")}</div>`;
      wireCodeOut(code, "r", `${nv}さんの学習レポート（保育士試験アプリ）`);
      mk2.textContent = "作り直す"; mk2.disabled = false;
    };
    if (sub) {
      const au = q("s-auto");
      au.onchange = () => { me.auto = au.checked; me.t = Date.now(); saveLocal(); schedulePush(); };
      sub.onclick = async () => {
        if (!needNick()) return;
        sub.disabled = true; sub.textContent = "提出しています…";
        try {
          await submitReport();
          msg.style.color = "var(--accent)"; msg.textContent = `✓ 提出しました（${fmtDT(me.lastSub)}）。先生が指導者ページを開くと届きます。`;
          q("s-last").textContent = `前回の提出：${fmtDT(me.lastSub)}（今日）`;
          sub.textContent = "📮 もう一度提出する";
        } catch (e) {
          msg.style.color = "var(--wrong)";
          msg.textContent = e.message === "tok" ? "この端末からは提出できません。最初に提出した端末で「記録の引き継ぎ」をしてから提出してください。"
            : "提出できませんでした。電波のよいところでもう一度試すか、かわりにレポートコードを作って送ってください。";
          sub.textContent = "📮 提出する";
        }
        sub.disabled = !ok.checked;
      };
    }
    // 教室への参加
    const showJoin = async code => {
      const box = q("s-join"), r = await readJoin(code);
      if (r.st !== "ok") { box.innerHTML = `<div class="warn">${r.st === "none" ? "参加リンクが見つかりません。" : "先生が作った参加リンクとして確かめられません。先生にもう一度もらってください。"}</div>`; return; }
      box.innerHTML = `<div class="rprev" style="margin-bottom:16px"><b>📮「${esc(r.srv.n || "教室")}」に参加しますか？</b><span>参加すると、このアプリから先生に直接提出でき、先生からの返信が自動で届きます。${me.srv ? `（いまの「${esc(me.srv.n || "教室")}」から切り替わります）` : ""}</span>
        <div class="codebtns" style="margin-top:8px"><button class="btn dark" id="s-jok" style="background:var(--accent);border-color:var(--accent)">参加する</button><button class="btn" id="s-jno">やめる</button></div></div>`;
      q("s-jok").onclick = () => { me.srv = r.srv; if (!me.tok) me.tok = newTok(); me.t = Date.now(); saveLocal(); schedulePush(); pendingJoin = ""; renderSend(); window.scrollTo(0, 0); syncServer(true); };
      q("s-jno").onclick = () => { pendingJoin = ""; box.innerHTML = ""; };
      box.scrollIntoView({ block: "center" });
    };
    if (pendingJoin) showJoin(pendingJoin);
    const jr = q("s-jread"); if (jr) jr.onclick = () => showJoin(q("s-jin").value);
    const lv = q("s-leave");
    if (lv) lv.onclick = () => { if (!lv.dataset.c) { lv.dataset.c = 1; lv.textContent = "もう一度押すと抜けます"; return; } delete me.srv; me.auto = false; me.t = Date.now(); saveLocal(); schedulePush(); renderSend(); };
    const ib = q("s-inbox");
    if (ib) ib.onclick = async () => {
      ib.disabled = true; const m = q("s-inmsg"); m.style.color = ""; m.textContent = "確認しています…";
      const n = await checkInbox(true);
      if (n > 0) { renderSend(); return; }
      ib.disabled = false;
      m.textContent = n === 0 ? "新しい返信はありません。" : "確認できませんでした。電波のよいところでもう一度試してください。";
    };
    const readBtn = q("s-read");
    readBtn.onclick = async () => {
      const box = q("s-inres"), txt = q("s-in").value;
      const { codes, res } = await readReplies(txt);
      if (!codes) { box.innerHTML = `<p class="fh" style="color:var(--wrong)">返信コード（HKT2:で始まるもの）が見つかりません。全体をコピーできているか確認してください。</p>`; return; }
      const good = res.filter(x => x.st === "ok");
      box.innerHTML = res.map(x => x.st === "ok" ? `<div class="rprev"><b>${esc(x.o.fr || "先生")}からの返信（${fmtMD(x.o.t)}${x.o.to === "*" ? "・クラス全員あて" : ""}）</b><span>${replySummary(x.o).map(esc).join("／") || "内容なし"}</span>${x.o.c ? `<div class="fbt">${nl(x.o.c)}</div>` : ""}${(x.o.a || []).map(a => `<div class="rpa">□ ${esc(asgLabel(a))}${asgNote(a) ? `「${esc(asgNote(a))}」` : ""}</div>`).join("")}</div>`
        : `<p class="fh" style="color:var(--wrong)">${x.st === "done" ? "この返信はもう取り込んであります。" : x.st === "other" ? "別の生徒あての返信です（ニックネームのちがう人に届いたものかもしれません）。" : x.st === "old" || x.st === "nocrypto" ? "このブラウザでは読み取れません。Safari・Chromeを最新にしてください。" : x.st === "unsigned" ? "先生の返信として確かめられないコードです（指導者ページで作られたものではないか、古い形式です）。先生にもう一度作ってもらってください。" : "読み取れないコードがありました。"}</p>`).join("")
        + (good.length ? `<button class="btn dark wide" id="s-apply" style="margin-top:8px;background:var(--accent);border-color:var(--accent)">取り込む</button>${good.some(x => x.o.sj || x.o.wd != null || x.o.we != null) ? `<p class="fh">受験科目・時間の変更は学習プランに反映され、変更履歴に「先生が変更」と残ります。あとから自分で設定を変えることもできます。</p>` : ""}` : "");
      readBtn.style.display = good.length ? "none" : "";
      const ap = q("s-apply");
      if (ap) ap.onclick = () => { good.forEach(x => applyReply(x.o)); pendingReply = ""; go(null); };
    };
    if (pendingReply) readBtn.onclick();
    wireFooter();
    document.title = "先生に送る｜保育士資格試験問題集";
    if (!pendingJoin) window.scrollTo(0, 0);
  }

  // ---------- 指導者ページの鍵（パスコード）と返信の署名 ----------
  // teacher_keys.js：署名用の秘密鍵をパスコードごとに暗号化したもの（tools/teacher_keys.mjs で生成）。
  // パスコードで秘密鍵を取り出せたときだけ指導者ページが開き、返信コードに署名できる。
  // 生徒のアプリは公開鍵で署名を確かめるので、パスコードを知らない人が返信を作っても取り込めない。
  const TK = window.TEACHER_KEYS && window.TEACHER_KEYS.pub ? window.TEACHER_KEYS : null;
  const UNLOCK_KEY = "hoikushi-teacher-unlock";
  const hasCrypto = () => !!(window.crypto && crypto.subtle);
  const normPass = p => String(p).normalize("NFKC").replace(/[\s-]/g, "").toLowerCase();
  let tKey = null, tLabel = "", tApi = "", pendingReport = "";
  // 受け取り用サーバー（Apps Script）に先生だと示す合言葉。同じ鍵ならどのパスコードで開いても同じになる
  async function apiToken(pkcs8) { return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hoikushi-api:" + b64u(pkcs8))))); }
  const importSign = pkcs8 => crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  async function unlockTeacher(pass, remember) {
    if (!TK || !hasCrypto()) return false;
    const enc = new TextEncoder();
    for (const L of TK.locks) {
      try {
        const base = await crypto.subtle.importKey("raw", enc.encode(normPass(pass)), "PBKDF2", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: unb64u(L.salt), iterations: L.it, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        const pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(L.iv) }, key, unb64u(L.ct)));
        tKey = await importSign(pkcs8); tLabel = L.label; tApi = await apiToken(pkcs8);
        try {
          if (remember) localStorage.setItem(UNLOCK_KEY, JSON.stringify({ kid: TK.kid, label: L.label, k: b64u(pkcs8), exp: Date.now() + 30 * DAY }));
          else localStorage.removeItem(UNLOCK_KEY);
        } catch (e) {}
        return true;
      } catch (e) { /* このパスコードの鍵ではない */ }
    }
    return false;
  }
  // 「この端末では30日間パスコードを省く」を選んだとき
  async function restoreTeacher() {
    try {
      const r = JSON.parse(localStorage.getItem(UNLOCK_KEY) || "null");
      if (!r) return;
      // 鍵が作り直された・パスコードが無効にされた・期限切れのときは使わない
      if (!TK || !hasCrypto() || r.kid !== TK.kid || !TK.locks.some(L => L.label === r.label) || r.exp < Date.now()) { localStorage.removeItem(UNLOCK_KEY); return; }
      tKey = await importSign(unb64u(r.k)); tLabel = r.label; tApi = await apiToken(unb64u(r.k));
    } catch (e) { tKey = null; }
  }
  function lockTeacher() { tKey = null; tLabel = ""; tApi = ""; try { localStorage.removeItem(UNLOCK_KEY); } catch (e) {} }
  async function signReply(o) {
    const p = JSON.stringify(o);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, tKey, new TextEncoder().encode(p)));
    return { p, s: b64u(sig), k: TK.kid };
  }
  let pubKeyP = null;
  async function verifyReply(w) {
    if (!TK || !hasCrypto() || !w || typeof w.p !== "string" || typeof w.s !== "string") return null;
    pubKeyP = pubKeyP || crypto.subtle.importKey("spki", unb64u(TK.pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    try {
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await pubKeyP, unb64u(w.s), new TextEncoder().encode(w.p));
      return ok ? JSON.parse(w.p) : null;
    } catch (e) { return null; }
  }
  // ---------- 受け取り用サーバー（Googleスプレッドシート＋Apps Script）とのやりとり ----------
  const JOIN_PREFIX = "HKJ1:";
  const okServerUrl = u => /^https:\/\/script\.google(usercontent)?\.com\/[^\s"'<>]+$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s"'<>]*$/.test(u);
  async function api(url, payload) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const tm = setTimeout(() => { if (ctl) ctl.abort(); }, 30000);
    try {
      // Content-Type を付けない（text/plain）ことで、Apps Script にそのまま届く
      const r = await fetch(url, { method: "POST", body: JSON.stringify(payload), redirect: "follow", signal: ctl ? ctl.signal : undefined });
      return await r.json();
    } finally { clearTimeout(tm); }
  }
  const newTok = () => b64u(crypto.getRandomValues(new Uint8Array(18)));
  function repSummary(r) {
    const M = repMetrics(r);
    return { last: M.last ? fmtMD(M.last) : "", w: M.w1.n, rate: M.w1.rate, ph: r.p ? PH[r.p.ph] + "期" : "",
      lag: r.p ? (r.p.lag ? r.p.lag + "問遅れ" : "予定どおり") : "", flags: M.flags.filter(f => f[0] !== "old").map(f => f[1]).join("／") };
  }
  async function submitReport() {
    ensureMe();
    if (!me.srv) throw new Error("nosrv");
    if (!me.tok) { me.tok = newTok(); me.t = Date.now(); }
    const r = buildReport();
    const j = await api(me.srv.u, { act: "submit", rep: r, tok: me.tok, sum: repSummary(r) });
    if (!j || !j.ok) throw new Error((j && j.err) || "ng");
    me.lastSub = Date.now(); me.t = Date.now();
    saveLocal(); schedulePush();
    return j;
  }
  // 1日1回（学習のあとは3時間おき）に自動で提出（本人が「自動で提出」を選んだときだけ）
  let autoBusy = false;
  async function maybeAutoSubmit(afterStudy) {
    if (autoBusy || !me || !me.srv || !me.auto || !me.nick) return;
    const last = me.lastSub || 0;
    if (afterStudy ? Date.now() - last < 3 * 3600e3 : dayKey(last) === dayKey(Date.now())) return;
    autoBusy = true;
    try { await submitReport(); } catch (e) {} finally { autoBusy = false; }
  }
  // 先生からの返信を受け取る（署名を確かめてから取り込む）
  let inboxBusy = false, inboxAt = 0;
  async function checkInbox(force) {
    if (inboxBusy || !me || !me.srv || !hasCrypto()) return -1;
    if (!force && Date.now() - inboxAt < 10 * 60000) return 0;
    inboxBusy = true;
    try {
      const j = await api(me.srv.u, { act: "inbox", id: me.id, tok: me.tok || "" });
      inboxAt = Date.now();
      if (!j || !j.ok) return -1;
      let n = 0;
      for (const w of j.w || []) {
        try {
          const o = await verifyReply(JSON.parse(w));
          if (o && o.id && !tf.imp[o.id] && (o.to === "*" || o.to === me.id)) { applyReply(o); n++; }
        } catch (e) {}
      }
      return n;
    } catch (e) { return -1; } finally { inboxBusy = false; }
  }
  async function syncServer(force) {
    if (!me || !me.srv) return;
    await maybeAutoSubmit(false);
    const n = await checkInbox(force);
    // 返信が届いたら、トップ・プランを開いているときだけ表示を更新（入力中の画面はそのまま）
    if (n > 0 && !session && !mock && /^#?(plan)?$/.test(location.hash || "")) route();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncServer(false); });
  // 参加リンク：先生の署名つき。先生が作ったものだけ受け付ける
  async function readJoin(text) {
    const c = findCodes(JOIN_PREFIX, text)[0];
    if (!c) return { st: "none" };
    try {
      const o = await verifyReply(await unpackOne(c[0], c[1]));
      if (!o || !okServerUrl(String(o.u || ""))) return { st: "bad" };
      return { st: "ok", srv: { u: o.u, n: String(o.n || "").slice(0, 40), t: Date.now() } };
    } catch (e) { return { st: "bad" }; }
  }
  let pendingJoin = "";

  function renderTLock(msg) {
    session = null; current = null;
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← トップ</button>
      <div class="brand"><span class="badge">🔒 指導者ページ</span></div>
      <h1>指導者ページ（先生専用）</h1>
      <p class="lead">指導教員のパスコードを入れると開きます。生徒の方は、トップの「先生に送る」からレポートを送ってください。</p>
      ${!TK ? `<div class="warn">このアプリには指導者ページの鍵が設定されていません。管理者に連絡してください。</div>`
        : !hasCrypto() ? `<div class="warn">このブラウザ（または https でない開き方）では指導者ページを開けません。Safari・Chromeの最新版で、https のページから開いてください。</div>`
        : `<div class="form" style="padding-top:12px">
        <label class="fl" style="margin-top:0">パスコード</label>
        <input id="tl-pass" class="fi" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" style="width:100%" placeholder="例：xxxx-xxxx-xxxx">
        <label class="ckrow consent"><input type="checkbox" id="tl-rem"><span>この端末では30日間パスコードを省く（自分専用の端末のときだけ）</span></label>
        <button class="btn dark wide" id="tl-go">開く</button>
        <p class="fh" id="tl-msg" style="color:var(--wrong)">${msg || ""}</p>
        ${pendingReport ? `<p class="fh">開いたあと、届いたレポートを取り込みます。</p>` : ""}
      </div>`}
      <div class="actions" style="margin-top:16px"><button class="btn" data-go="send">先生に送る（生徒用）</button><button class="btn" data-go="">トップへ</button></div>`;
    document.getElementById("to-top").onclick = () => go(null);
    $app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
    const inp = document.getElementById("tl-pass"), btn = document.getElementById("tl-go");
    if (inp) {
      const tryOpen = async () => {
        if (!inp.value.trim()) return;
        btn.disabled = true; btn.textContent = "確認中…";
        const ok = await unlockTeacher(inp.value, document.getElementById("tl-rem").checked);
        if (ok) {
          if (pendingReport) { const c = pendingReport; pendingReport = ""; return linkImport(c); }
          return route();
        }
        await new Promise(r => setTimeout(r, 800)); // 続けて試しにくくする
        btn.disabled = false; btn.textContent = "開く";
        document.getElementById("tl-msg").textContent = "パスコードがちがいます。";
        inp.select();
      };
      btn.onclick = tryOpen;
      inp.onkeydown = e => { if (e.key === "Enter") tryOpen(); };
      setTimeout(() => inp.focus(), 50);
    }
    document.title = "指導者ページ｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  // ---------- 指導者ページのデータ ----------
  // sts: { 生徒ID: { rep 最新のレポート, sent:[送った返信], memo, goal } }, all: [クラス全員あての返信], tpl: 定型コメント
  let tch = { name: "", sts: {}, all: [], tpl: null, t: 0 };
  try { const raw = JSON.parse(localStorage.getItem(TEACHER_KEY) || "null"); if (raw && typeof raw === "object") tch = Object.assign(tch, raw); } catch (e) {}
  const DEFAULT_TPL = [
    "毎日続けられていますね。この調子でいきましょう！",
    "復習がたまってきています。今週は「今日の復習」を先に片付けましょう。",
    "最頻出テーマの理解度を上げると、合格ラインがぐっと近づきます。",
    "模擬試験で6割を超えました。間違えた分野の要点をもう一度確認しましょう。",
    "少し間があいています。1日10問からでいいので再開しましょう。",
    "「読み違い」が多めです。「不適切なもの」に印をつけてから選ぶ習慣を。"
  ];
  const tplList = () => tch.tpl || DEFAULT_TPL;
  let tpushTimer = null;
  function saveTeacher() { tch.t = Date.now(); try { localStorage.setItem(TEACHER_KEY, JSON.stringify(tch)); } catch (e) {} clearTimeout(tpushTimer); tpushTimer = setTimeout(pushTeacher, 1200); }
  function pushTeacher() { if (!tdocRef) return; tdocRef.set(plain(Object.assign({}, tch, { updatedAt: Date.now() }))).catch(() => {}); }
  function absorbTeacher(b) {
    if (!b || typeof b !== "object") return false;
    const before = JSON.stringify(tch);
    Object.entries(b.sts || {}).forEach(([id, x]) => {
      if (!x || !x.rep) return;
      const cur = tch.sts[id];
      if (!cur) { tch.sts[id] = x; return; }
      const sent = {}; (cur.sent || []).concat(x.sent || []).forEach(r => { if (r && r.id) sent[r.id] = r; });
      tch.sts[id] = Object.assign({}, cur, (x.rep.t || 0) > (cur.rep.t || 0) ? { rep: x.rep } : {}, { sent: Object.values(sent).sort((p, q) => p.t - q.t).slice(-60),
        memo: cur.memo || x.memo || "", goal: cur.goal || x.goal || "" });
    });
    const all = {}; (tch.all || []).concat(b.all || []).forEach(r => { if (r && r.id) all[r.id] = r; });
    tch.all = Object.values(all).sort((p, q) => p.t - q.t).slice(-60);
    if ((b.t || 0) > (tch.t || 0)) { if (b.name) tch.name = b.name; if (b.tpl) tch.tpl = b.tpl; }
    const changed = JSON.stringify(tch) !== before;
    if (changed) { try { localStorage.setItem(TEACHER_KEY, JSON.stringify(tch)); } catch (e) {} }
    return changed;
  }
  function mergeReport(r) {
    if (!r || typeof r.id !== "string" || typeof r.t !== "number") throw new Error("shape");
    r.nk = String(r.nk || "").slice(0, 20);
    const cur = tch.sts[r.id];
    if (cur && (cur.rep.t || 0) >= r.t) return false;
    tch.sts[r.id] = Object.assign({ sent: [], memo: "", goal: "" }, cur, { rep: r });
    return true;
  }
  // 受け取り用サーバーから提出を読み込む
  let tLoadAt = 0, tLoadMsg = "";
  async function loadServer() {
    if (!tch.srv || !tApi) return { ok: false, err: "nosrv" };
    try {
      const j = await api(tch.srv.u, { act: "reports", auth: tApi });
      tLoadAt = Date.now();
      if (!j || !j.ok) return { ok: false, err: (j && j.err) || "ng" };
      let n = 0, names = [];
      (j.reps || []).forEach(x => { try { const r = JSON.parse(x); if (mergeReport(r)) { n++; names.push(r.nk || "名前なし"); } } catch (e) {} });
      tch.srv.at = tLoadAt;
      saveTeacher();
      return { ok: true, n, total: (j.reps || []).length, names };
    } catch (e) { return { ok: false, err: "net" }; }
  }
  async function importReports(text) {
    const codes = findCodes(REP_PREFIX, text);
    let ok = 0, ng = 0, old = 0, stale = 0;
    const names = [];
    for (const [k, d] of codes) {
      try {
        const r = await unpackOne(k, d);
        if (!mergeReport(r)) stale++;
        ok++; names.push(r.nk || "名前なし");
      } catch (e) { if (e && e.message === "old") old++; else ng++; }
    }
    if (ok) saveTeacher();
    return { found: codes.length, ok, ng, old, stale, names };
  }
  let teacherMsg = "";
  async function linkImport(code) {
    const r = await importReports(code);
    teacherMsg = r.ok ? `${r.names.map(esc).join("・")}さんのレポートを取り込みました${r.stale ? "（すでに同じか新しいレポートがありました）" : ""}。` : "リンクからレポートを読み取れませんでした。";
    const one = r.ok === 1 ? Object.values(tch.sts).find(x => x.rep.nk === r.names[0]) : null;
    replaceHash(one ? "teacher/s/" + one.rep.id : "teacher");
    route();
  }

  // ---------- 指導者ページ：レポートから読み取る指標 ----------
  function repMetrics(r) {
    const keys = Object.keys(r.d || {}).filter(k => r.d[k][0]).sort();
    const last = keys.length ? parseDay(keys[keys.length - 1]) : null;
    const range = (a, b) => {
      let n = 0, c = 0, min = 0, days = 0;
      keys.forEach(k => { const age = Math.round((dayStart(r.t) - parseDay(k)) / DAY); if (age >= a && age < b) { n += r.d[k][0]; c += r.d[k][1]; min += r.d[k][2] || 0; days++; } });
      return { n, c, min, days, rate: n ? Math.round(c / n * 100) : null };
    };
    const w1 = range(0, 7), prev = range(7, 28), m30 = range(0, 30);
    const idle = last === null ? null : Math.round((today0() - last) / DAY);
    const S = Object.values(r.s || {});
    const due = S.reduce((a, x) => a + (x[5] || 0), 0), queued = S.reduce((a, x) => a + (x[4] || 0), 0);
    const age = Math.round((today0() - dayStart(r.t)) / DAY);
    const flags = [];
    if (idle === null) flags.push(["idle", "学習の記録がまだありません"]);
    else if (idle >= 3) flags.push(["idle", `${idle}日学習なし`]);
    if (r.p && r.p.wn !== null && r.p.wn !== undefined) flags.push(["lag", `このペースだと実戦が${r.p.wn}日しか取れません`]);
    else if (r.p && r.p.big) flags.push(["lag", `計画より${r.p.lag}問遅れ`]);
    if (w1.n >= 20 && prev.n >= 20 && prev.rate - w1.rate >= 10) flags.push(["drop", `正答率が下がっています（${prev.rate}%→${w1.rate}%）`]);
    if (due >= 30) flags.push(["rv", `復習が${due}問たまっています`]);
    if (age >= 7) flags.push(["old", `レポートが${age}日前のものです`]);
    return { last, idle, w1, prev, m30, due, queued, age, flags };
  }
  const repTargets = r => r.p ? SUBJ.filter((S, i) => r.p.sj[i] === "n").map(S => S.id) : Object.keys(r.s || {});
  const sgOf = x => ({ lv: x[6] || 0, label: ["データ不足", "要強化", "もう一歩", "合格圏"][x[6] || 0], tip: "" });
  const repLog = r => Object.fromEntries(Object.entries(r.d || {}).map(([k, v]) => [k, { n: v[0], c: v[1] }]));
  const asgStatus = (a, r) => r && r.a && r.a[a.id] ? `<span class="tdone">✓ ${fmtMD(r.a[a.id])} 完了</span>` : `<span class="tpend">未完了</span>`;

  // 生徒の詳細（指導者ページ・生徒の確認画面・面談レポートで共通）
  function studentBodyHtml(r, opt) {
    opt = opt || {};
    const M = repMetrics(r), tg = repTargets(r);
    const rs = r.r || {}, rTot = (rs.k || 0) + (rs.y || 0) + (rs.m || 0) + (rs.u || 0);
    const mocks = {}; (r.mk || []).forEach(m => { (mocks[m[0]] = mocks[m[0]] || []).push(m); });
    const qlist = (ids, max) => {
      const qs = (ids || []).map(id => qById[id]).filter(Boolean);
      return qs.slice(0, max).map(q => `<details class="missed-item"><summary><small class="tsub">${esc(subjById[subjOfQ[q.id]].name)}・${esc(catOf(q).name)}</small> ${esc(shortQ(q))}</summary><div class="sb">${factsHtml(q)}<p class="ex">${esc(q.e)}</p></div></details>`).join("")
        + (qs.length > max ? `<p class="fh">ほか${qs.length - max}問</p>` : "");
    };
    const p = r.p;
    return `
      <div class="overall">
        <div class="stat"><div class="num">${M.w1.n}</div><div class="lbl">この7日間の問題数</div></div>
        <div class="stat"><div class="num">${M.w1.rate === null ? "–" : M.w1.rate + "%"}</div><div class="lbl">7日間の正答率${M.prev.rate !== null ? `<br><small>その前3週 ${M.prev.rate}%</small>` : ""}</div></div>
        <div class="stat"><div class="num">${M.w1.min}<small style="font-size:13px">分</small></div><div class="lbl">7日間の学習時間</div></div>
      </div>
      ${M.flags.length && !opt.preview ? `<div class="warn soft">${M.flags.map(f => `<div>⚠ ${esc(f[1])}</div>`).join("")}</div>` : ""}
      <p class="note" style="margin:-8px 2px 14px">最後に学習した日：${M.last ? fmtMD(M.last) + "（" + ago(M.last) + "）" : "なし"}・通算 ${r.tot || 0}問・レポート作成 ${fmtDT(r.t)}（${ago(r.t)}）</p>
      ${calendarHtml(8, repLog(r))}
      <h2 class="section-title">学習プラン</h2>
      ${p ? `<div class="olbox">
        <div><span>受験日</span><b>${fmtMD(parseDay(p.ex))}</b><small>${dateJa(p.ex)}・あと${daysTo(p.ex)}日・${esc((TEMPLATES[p.tpl] || TEMPLATES.half).name)}</small></div>
        <div><span>いまの段階</span><b><span class="phase p${p.ph}">${PH[p.ph]}期</span></b><small>${PH_DESC[p.ph]}</small></div>
        <div><span>計画との差</span><b>${p.lag ? p.lag + "問遅れ" : "予定どおり"}</b><small>${p.wn !== null && p.wn !== undefined ? `このペースだと実戦が${p.wn}日しか取れません。` : ""}基礎の残り ${p.un}問・1日の目安 ${p.cap}問（平日${p.wd}分・週末${p.we}分）${p.goal ? "・基礎を終える日 " + fmtMD(parseDay(p.goal)) : ""}</small></div>
        <div><span>受験科目</span><b>${tg.length}科目</b><small>今回：${tg.map(id => esc(subjById[id].name)).join("・") || "なし"}${SUBJ.some((S, i) => p.sj[i] === "l") ? `<br>次の回：${SUBJ.filter((S, i) => p.sj[i] === "l").map(S => esc(S.name)).join("・")}` : ""}${SUBJ.some((S, i) => p.sj[i] === "p") ? `<br>免除：${SUBJ.filter((S, i) => p.sj[i] === "p").map(S => esc(S.name)).join("・")}` : ""}</small></div>
      </div>` : `<p class="note">学習プランはまだ作っていません。返信で受験科目を指定すると、プランが作られます。</p>`}
      <h2 class="section-title">科目ごとの状況<small>合格ライン（6割）に届きそうか</small></h2>
      <div class="sgrid">${SUBJ.filter(S => (r.s || {})[S.id]).map(S => { const x = r.s[S.id];
        return `<div class="srow"><span class="sn">${S.icon} ${esc(S.name)}${tg.includes(S.id) ? "" : ' <small class="tsub">今回は受験しない</small>'}</span>${sigDot(sgOf(x))}
          <span class="sd2">挑戦 ${x[0]}/${x[1]}・正答率 ${x[7] === null ? "–" : x[7] + "%"}・最頻出の理解度 ${x[8] === null ? "–" : x[8] + "%"}${x[9] !== null ? "・模試 " + x[9] + "%" : ""}・復習中 ${x[4]}問${x[5] ? `（今日の分 ${x[5]}）` : ""}${mocks[S.id] ? `<br>模擬試験：${mocks[S.id].slice(-5).map(m => Math.round(m[3] / m[2] * 100) + "%").join(" → ")}（最新 ${fmtMD(mocks[S.id][mocks[S.id].length - 1][1])}）` : ""}</span>
          <span class="bar"><i style="width:${Math.round(x[0] / x[1] * 100)}%"></i></span></div>`; }).join("") || `<p class="note">まだ問題を解いていません。</p>`}</div>
      ${(r.wk || []).length ? `<h2 class="section-title" style="margin-top:18px">苦手分野<small>4回以上解いて正答率70%未満</small></h2>
        <div class="phtable">${r.wk.map(w => { const S = subjById[w[0]], c = S && S.categories.find(x => x.id === w[1]); return c ? `<div class="phrow"><span>${c.icon} ${esc(c.name)}<small class="tsub"> ${esc(S.name)}</small></span><span></span><b style="color:var(--wrong)">${w[2]}%</b></div>` : ""; }).join("")}</div>` : ""}
      <h2 class="section-title" style="margin-top:18px">間違いの理由<small>この30日・本人の記録</small></h2>
      ${rTot ? `<div class="reasons">${REASONS.map(([k, t]) => `<div><span>${t}</span><i style="width:${Math.round((rs[k] || 0) / rTot * 100)}%"></i><b>${rs[k] || 0}</b></div>`).join("")}</div>
        <p class="fh">${(rs.k || 0) + (rs.y || 0) >= (rs.m || 0) + (rs.u || 0) ? "知識不足（知らなかった・うろ覚え）が中心です。要点を読んでから解く流れが合っています。" : "読み違い・うっかりが中心です。知識はあるので、問題文の読み方の練習が効きます。"}</p>` : `<p class="note">記録がありません。</p>`}
      <p class="note">迷って正解した問題：この30日で${r.g || 0}問</p>
      ${(r.x || []).length ? `<h2 class="section-title" style="margin-top:18px">間違えたまま・復習中の問題<small>${r.x.length}問</small></h2><div class="missed">${qlist(r.x, opt.preview ? 5 : 12)}</div>` : ""}
      ${(r.gq || []).length && !opt.preview ? `<h2 class="section-title">迷って正解した問題</h2><div class="missed">${qlist(r.gq, 8)}</div>` : ""}`;
  }

  // ---------- 指導者ページ：提出の受け取り（Googleスプレッドシート） ----------
  const srvErr = e => e === "auth" ? "受け取り先に先生として認められませんでした。指導者ページの鍵を作り直した場合は、Apps Script の「スクリプト プロパティ」で TEACHER を削除してから、もう一度「接続する」を押してください。"
    : e === "net" ? "受け取り先につながりませんでした。電波の状態と、ウェブアプリのURLを確認してください。" : "受け取り先でエラーが起きました（" + esc(e || "") + "）。";
  const SCRIPT_URL = "https://github.com/koryo27-cr/hoikushi-app/blob/main/server/Code.gs";
  function srvSectionHtml() {
    const S = tch.srv;
    if (S) return `<h2 class="section-title" style="margin-top:20px">📮 提出の受け取り<small>Googleスプレッドシート</small></h2>
      <div class="form" style="padding-top:12px">
        <p style="margin:0 0 4px"><b>${esc(S.n || "教室")}</b> とつながっています。生徒が「提出する」を押すと、ここに届きます。</p>
        <p class="fh" id="t-srvmsg" style="${tLoadMsg ? "color:var(--accent)" : ""}">${tLoadMsg || (S.at ? `最後に読み込んだ日時：${fmtDT(S.at)}` : "")}</p>
        <div class="codebtns"><button class="btn dark" id="t-load">最新の提出を読み込む</button><button class="btn" id="t-join">生徒用の参加リンクを作る</button></div>
        <div id="t-joinout"></div>
        <button class="link-btn" id="t-disc" style="margin-top:6px">接続を解除する</button>
      </div>`;
    return `<h2 class="section-title" style="margin-top:20px">📮 提出の受け取り<small>まだ設定していません</small></h2>
      <div class="form" style="padding-top:12px">
        <p style="margin:0 0 6px;font-size:14px">Googleスプレッドシートを受け取り先にすると、生徒はアプリの「提出する」で直接送れ、先生の返信も生徒のアプリに自動で届きます（コードの貼り付けが不要になります）。</p>
        <ol class="steps">
          <li>Googleスプレッドシートを新しく作る（名前は自由）。</li>
          <li>メニューの「拡張機能」→「Apps Script」を開き、最初からある中身を消して、下の「スクリプトをコピー」で写したものを貼り付けて保存。</li>
          <li>右上の「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」。実行するユーザー「自分」、アクセスできるユーザー「全員」で「デプロイ」し、Googleアカウントでアクセスを承認。</li>
          <li>表示された「ウェブアプリのURL」を下に貼り、「接続する」。</li>
        </ol>
        <div class="codebtns"><button class="btn" id="t-scopy">スクリプトをコピー</button><a class="btn" href="${SCRIPT_URL}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">スクリプトを見る</a></div>
        <textarea id="t-stext" class="fi codebox" readonly style="display:none;height:120px;margin-top:6px"></textarea>
        <label class="fl">ウェブアプリのURL</label>
        <input id="t-surl" class="fi" style="width:100%" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" spellcheck="false">
        <label class="fl">教室の名前<small>生徒の画面に出ます</small></label>
        <input id="t-sname" class="fi" style="width:100%" maxlength="40" placeholder="例：保育士試験対策講座 火曜クラス">
        <button class="btn dark wide" id="t-sconn" style="margin-top:10px">接続する</button>
        <p class="fh" id="t-srvmsg"></p>
        <p class="fh">提出されたレポートは先生のGoogleドライブ（このスプレッドシート）に保存されます。誰がいつ消すかを教室で決めておいてください。</p>
      </div>`;
  }
  function wireSrvSection() {
    const q = id => document.getElementById(id), msg = q("t-srvmsg");
    const say = (t, bad) => { msg.style.color = bad ? "var(--wrong)" : "var(--accent)"; msg.innerHTML = t; };
    tLoadMsg = "";
    if (!tch.srv) {
      q("t-scopy").onclick = async e => {
        const b = e.target;
        try {
          let txt = "";
          for (const f of ["server/Code.gs", "server/Code.txt"]) { // claude.ai版は .txt で置いている
            try { txt = await (await fetch(f, { cache: "no-store" })).text(); } catch (_) { txt = ""; }
            if (/function doPost/.test(txt)) break;
          }
          if (!/function doPost/.test(txt)) throw 0;
          const ta = q("t-stext"); ta.value = txt; ta.style.display = "";
          try { await navigator.clipboard.writeText(txt); b.textContent = "コピーしました ✓"; } catch (_) { ta.focus(); ta.select(); b.textContent = "下を全部選んでコピー"; }
        } catch (err) { b.textContent = "読み込めませんでした。「スクリプトを見る」からコピー"; }
      };
      q("t-sconn").onclick = async () => {
        const u = q("t-surl").value.trim(), n = q("t-sname").value.trim().slice(0, 40);
        if (!okServerUrl(u)) return say("ウェブアプリのURL（https://script.google.com/macros/s/…/exec）を貼ってください。", true);
        say("接続しています…");
        try {
          const a = await api(u, { act: "setup", auth: tApi });
          if (!a || !a.ok) return say(a && a.already ? srvErr("auth") : "接続できませんでした。デプロイのとき「アクセスできるユーザー：全員」にしたか確認してください。", true);
          const p = await api(u, { act: "ping", auth: tApi });
          if (!p || !p.teacher) return say(srvErr("auth"), true);
          tch.srv = { u, n: n || "教室", t: Date.now() };
          saveTeacher(); tLoadAt = 0;
          teacherMsg = `受け取り先「${esc(tch.srv.n)}」に接続しました。次に「生徒用の参加リンクを作る」で生徒に配ってください。`;
          renderTeacher();
        } catch (e) { say("接続できませんでした。URLが正しいか、デプロイのとき「アクセスできるユーザー：全員」にしたか確認してください。", true); }
      };
      return;
    }
    q("t-load").onclick = async e => {
      e.target.disabled = true; say("読み込んでいます…");
      const r = await loadServer();
      if (!r.ok) { e.target.disabled = false; return say(srvErr(r.err), true); }
      tLoadMsg = r.n ? `新しい提出 ${r.n}件（${r.names.map(esc).join("・")}）を読み込みました。` : `新しい提出はありません（提出 ${r.total}件）。`;
      renderTeacher();
    };
    q("t-join").onclick = async () => {
      const code = await pack(JOIN_PREFIX, await signReply({ u: tch.srv.u, n: tch.srv.n, t: Date.now() }));
      q("t-joinout").innerHTML = `<div class="codeout">${codeOutHtml(code, "j", "生徒に送ってください。生徒がリンクを開く（またはコードを「先生に送る」画面に貼る）と、この教室に参加できます。")}</div>`;
      wireCodeOut(code, "j", `「${tch.srv.n}」への参加リンク（保育士試験アプリ）`);
    };
    const dc = q("t-disc");
    dc.onclick = () => { if (!dc.dataset.c) { dc.dataset.c = 1; dc.textContent = "もう一度押すと解除します（スプレッドシートのデータは残ります）"; return; } delete tch.srv; saveTeacher(); renderTeacher(); };
  }

  // ---------- 指導者ページ：トップ（一覧） ----------
  function renderTeacher() {
    session = null; current = null;
    const list = Object.values(tch.sts).map(x => ({ x, M: repMetrics(x.rep) })).sort((a, b) => (a.x.rep.nk || "").localeCompare(b.x.rep.nk || "", "ja"));
    const need = list.filter(o => o.M.flags.some(f => f[0] !== "old")).sort((a, b) => b.M.flags.length - a.M.flags.length);
    const msg = teacherMsg; teacherMsg = "";
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← トップ</button>
      <div class="brand"><span class="badge">👩‍🏫 指導者ページ</span></div>
      <h1>指導者ページ（先生用）</h1>
      <p class="tlockbar">🔓 パスコード「${esc(tLabel)}」で開いています<button class="link-btn" id="t-lock">ロックする</button></p>
      <p class="lead">${tch.srv ? "生徒がアプリから提出したレポートが、下の一覧に届きます。生徒を選ぶと、コメント・課題・受験科目の変更をアプリに直接送れます。" : "生徒から届いたレポートコードを貼ると、学習の状況が一覧で見られます。コメント・課題・受験科目の変更は「返信コード」にして生徒に送ります。"}</p>
      ${tch.srv ? srvSectionHtml() : ""}
      <div class="form" style="padding-top:12px;margin-top:${tch.srv ? "18px" : "0"}">
        <label class="fl" style="margin-top:0">${tch.srv ? "コードで届いたレポートを取り込む" : "生徒から届いたレポートを取り込む"}<small>複数まとめて貼ってもかまいません</small></label>
        <textarea id="t-in" class="fi codebox" placeholder="レポートコード（HKR1:…）やリンクを貼り付け"></textarea>
        <button class="btn dark wide" id="t-imp" style="margin-top:8px">取り込む</button>
        <p class="fh" id="t-msg" style="${msg ? "color:var(--accent)" : ""}">${msg}</p>
        <label class="fl">返信に表示する先生の名前</label>
        <input id="t-name" class="fi" maxlength="20" value="${esc(tch.name || "")}" placeholder="例：山田先生" style="width:100%">
      </div>
      ${tch.srv ? "" : srvSectionHtml()}
      ${!list.length && tch.srv ? `<div class="notecard" style="margin-top:18px"><b>使い方</b><ol class="steps">
          <li>「生徒用の参加リンクを作る」で作ったリンクを、生徒に送ります（グループLINEなど）。</li>
          <li>生徒がリンクを開いて教室に参加し、「先生に送る」→「提出する」を押すと、ここに届きます。</li>
          <li>生徒を選んでコメントや課題を書き「返信を送る」と、生徒が次にアプリを開いたときに届きます。</li></ol></div>` : ""}
      ${!list.length && !tch.srv ? `<div class="notecard" style="margin-top:18px"><b>使い方</b><ol class="steps">
          <li>生徒が、アプリのトップ →「先生に送る」でレポートコードを作り、LINEやメールで先生に送ります。</li>
          <li>届いたコード（またはリンク）を上の欄に貼って「取り込む」。</li>
          <li>生徒を選ぶと、科目ごとの状況・苦手分野・間違いの理由が見られます。コメントや課題を書いて「返信コードを作る」。</li>
          <li>返信コードを生徒に送ると、生徒のアプリにコメントと課題が入ります。</li></ol>
        <p class="fh">取り込んだレポートは、この端末（claude.ai版でログインしているときはあなたのアカウント）にだけ保存されます。</p></div>` : ""}
      ${need.length ? `<h2 class="section-title" style="margin-top:20px">声かけが必要な生徒<small>${need.length}人</small></h2>
        <div class="tneed">${need.map(o => `<button class="tnrow" data-st="${esc(o.x.rep.id)}"><b>${esc(o.x.rep.nk || "名前なし")}</b><span>${o.M.flags.filter(f => f[0] !== "old").map(f => `<i class="tf ${f[0]}">${esc(f[1])}</i>`).join("")}</span></button>`).join("")}</div>` : ""}
      ${list.length ? `<h2 class="section-title" style="margin-top:20px">クラス一覧<small>${list.length}人</small></h2>
        <div class="tlist">${list.map(({ x, M }) => { const r = x.rep, tg = repTargets(r), pend = (x.sent || []).concat(tch.all || []).flatMap(s => s.a || []).filter(a => !(r.a || {})[a.id]).length;
          return `<button class="tst" data-st="${esc(r.id)}">
            <span class="tn">${esc(r.nk || "名前なし")}${M.flags.length ? `<i class="tfc">${M.flags.length}</i>` : ""}</span>
            <span class="tm">最終学習 ${M.last ? fmtMD(M.last) + "（" + ago(M.last) + "）" : "なし"}・今週 ${M.w1.n}問・正答率 ${M.w1.rate === null ? "–" : M.w1.rate + "%"}</span>
            <span class="tm">${r.p ? `<span class="phase p${r.p.ph}">${PH[r.p.ph]}期</span> あと${daysTo(r.p.ex)}日・${r.p.lag ? r.p.lag + "問遅れ" : "予定どおり"}` : "プランなし"}${pend ? `・課題 未完了${pend}` : ""}・レポート ${ago(r.t)}</span>
            <span class="tsig">${tg.filter(id => (r.s || {})[id]).map(id => `<span class="sig s${r.s[id][6] || 0}"><i></i>${SHORT[id]}</span>`).join("")}</span>
          </button>`; }).join("")}</div>
        <div class="tools" style="margin-top:14px">
          <button class="tool" data-go="teacher/class"><span>📊</span><b>クラス共通のつまずき</b><small>多くの生徒が間違えている問題・分野</small></button>
          <button class="tool" data-go="teacher/all"><span>📣</span><b>クラス全員に返信</b><small>同じコメント・課題を全員に</small></button>
        </div>` : ""}
      <details class="howto" style="margin-top:18px"><summary>定型コメントを編集する</summary>
        <p>よく使う励ましや助言を1行に1つ書きます。返信を書くときに一押しで入れられます。</p>
        <textarea id="t-tpl" class="fi" style="width:100%;height:150px">${esc(tplList().join("\n"))}</textarea>
        <button class="btn wide" id="t-tplsave" style="margin-top:6px">保存</button></details>
      <details class="howto"><summary>指導者ページのデータを別の端末へ移す・削除する</summary>
        <p>取り込んだレポートと送った返信を、コードにして別の端末へ移せます。</p>
        <button class="btn wide" id="t-bk">バックアップのコードを作る</button><div id="t-bkout"></div>
        <textarea id="t-bkin" class="fi codebox" placeholder="バックアップのコード（HKB1:…）を貼り付け" style="margin-top:8px"></textarea>
        <button class="btn wide" id="t-bkload" style="margin-top:6px">読み込む</button>
        <button class="link-btn" id="t-clear" style="margin-top:10px;color:var(--wrong)">指導者ページのデータをすべて削除</button></details>
      ${footer()}`;
    document.getElementById("to-top").onclick = () => go(null);
    document.getElementById("t-lock").onclick = () => { lockTeacher(); go(null); };
    $app.querySelectorAll("[data-st]").forEach(b => b.onclick = () => go("teacher/s/" + b.dataset.st));
    $app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
    document.getElementById("t-name").onchange = e => { tch.name = e.target.value.trim().slice(0, 20); saveTeacher(); };
    wireSrvSection();
    // 受け取り先につながっていれば、開いたときに最新の提出を読み込む（1分に1回まで）
    if (tch.srv && tApi && Date.now() - tLoadAt > 60000) loadServer().then(r => {
      tLoadMsg = r.ok ? (r.n ? `新しい提出 ${r.n}件（${r.names.map(esc).join("・")}）を読み込みました。` : `新しい提出はありません（提出 ${r.total}件）。`) : srvErr(r.err);
      if (!session && /^#teacher$/.test(location.hash)) { teacherMsg = msg; renderTeacher(); }
    });
    document.getElementById("t-imp").onclick = async () => {
      const r = await importReports(document.getElementById("t-in").value);
      teacherMsg = !r.found ? "" : r.ok ? `${r.names.map(esc).join("・")}さんのレポートを取り込みました。${r.stale ? `（${r.stale}件は、すでに同じか新しいレポートがありました）` : ""}${r.ng ? `読み取れないコードが${r.ng}件ありました。` : ""}` : "";
      if (!r.ok) { const m = document.getElementById("t-msg"); m.style.color = "var(--wrong)"; m.textContent = !r.found ? "レポートコード（HKR1:で始まるもの）が見つかりません。" : r.old ? "このブラウザでは読み取れません。Safari・Chromeを最新にしてください。" : "コードを読み取れませんでした。全体をコピーできているか確認してください。"; return; }
      renderTeacher();
    };
    document.getElementById("t-tplsave").onclick = e => { tch.tpl = document.getElementById("t-tpl").value.split("\n").map(x => x.trim()).filter(Boolean).slice(0, 30); saveTeacher(); e.target.textContent = "保存しました ✓"; };
    document.getElementById("t-bk").onclick = async () => {
      const code = await pack(TBK_PREFIX, tch);
      document.getElementById("t-bkout").innerHTML = `<div class="codeout">${codeOutHtml(code, "", "別の端末の指導者ページで読み込んでください。生徒の記録が入っているので、扱いに気をつけてください。")}</div>`;
      wireCodeOut(code, "", "指導者ページのバックアップ");
      const l = document.getElementById("co-link"); if (l) l.remove();
      const sh = document.getElementById("co-share"); if (sh) sh.remove();
    };
    document.getElementById("t-bkload").onclick = async e => {
      const c = findCodes(TBK_PREFIX, document.getElementById("t-bkin").value)[0];
      try { if (!c) throw 0; absorbTeacher(Object.assign(await unpackOne(c[0], c[1]), { t: 0 })); saveTeacher(); teacherMsg = "バックアップを読み込みました。"; renderTeacher(); }
      catch (err) { e.target.textContent = "読み取れませんでした"; }
    };
    const clr = document.getElementById("t-clear");
    clr.onclick = () => { if (!clr.dataset.c) { clr.dataset.c = 1; clr.textContent = "もう一度押すと削除します（元に戻せません）"; return; } tch = { name: tch.name, sts: {}, all: [], tpl: tch.tpl, t: Date.now() }; saveTeacher(); renderTeacher(); };
    wireFooter();
    document.title = "指導者ページ｜保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  // ---------- 指導者ページ：返信を書く ----------
  const drafts = {};
  let presetAsg = null; // クラス共通のつまずきから「全員の課題にする」
  const MINS = [0, 15, 30, 45, 60, 90, 120, 180, 240];
  const minLabel = v => v < 60 ? v + "分" : (v / 60) + "時間" + (v % 60 ? "半" : "");
  function composerHtml(key, r) {
    const dr = drafts[key];
    const S = subjById[dr.nb.sid] || SUBJ[0];
    const ths = (S.themes || []).filter(t => t.qs.length).sort((a, b) => b.exam - a.exam);
    const base = r && r.p ? Object.fromEntries(SUBJ.map((s, i) => [s.id, SJ_FROM[r.p.sj[i]] || "now"])) : Object.fromEntries(SUBJ.map(s => [s.id, "now"]));
    const k = dr.nb.k;
    return `<div class="form comp">
      <label class="fl">コメント</label>
      <textarea id="c-text" class="fi" style="width:100%;height:110px" maxlength="2000" placeholder="例：社会的養護、伸びてますね。今週は福祉系の復習を中心に。">${esc(dr.c)}</textarea>
      <div class="chips">${tplList().map((t, i) => `<button class="chip tplc" data-tpl="${i}">${esc(t.length > 18 ? t.slice(0, 18) + "…" : t)}</button>`).join("")}</div>
      <label class="fl">課題<small>生徒の「今日のメニュー」に入ります</small></label>
      ${dr.a.length ? `<div class="asglist">${dr.a.map((a, i) => `<div class="asgrow"><span>□</span><div><b>${esc(asgLabel(a))}</b>${asgNote(a) ? `<small>「${esc(asgNote(a))}」</small>` : ""}${a.due ? `<small>期限 ${fmtMD(parseDay(a.due))}</small>` : ""}</div><button class="wbtn" data-adel="${i}">削除</button></div>`).join("")}</div>` : ""}
      <div class="nb">
        <select id="nb-k" class="fi">${[["cat", "分野の問題を解く"], ["theme", "頻出テーマの特訓"], ["mock", "模擬試験"], ["note", "分野の要点を読む"], ["rv", "今日の復習を片付ける"], ["free", "自由課題（文章で指示）"]].map(([v, t]) => `<option value="${v}"${k === v ? " selected" : ""}>${t}</option>`).join("")}</select>
        ${k === "rv" || k === "free" ? "" : `<select id="nb-s" class="fi">${SUBJ.map(s => `<option value="${s.id}"${s.id === S.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>`}
        ${k === "cat" || k === "note" ? `<select id="nb-c" class="fi">${S.categories.filter(c => S.questions.some(q => q.c === c.id)).map(c => `<option value="${c.id}"${c.id === dr.nb.c ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : ""}
        ${k === "theme" ? `<select id="nb-th" class="fi">${ths.map(t => `<option value="${t.id}"${t.id === dr.nb.th ? " selected" : ""}>${t.exam >= 8 ? "🔥" : ""}${esc(t.name.replace(/（.*$/, ""))}</option>`).join("")}</select>` : ""}
        ${k === "cat" || k === "theme" ? `<select id="nb-n" class="fi">${[5, 10, 15, 20, 30].map(n => `<option value="${n}"${+dr.nb.n === n ? " selected" : ""}>${n}問</option>`).join("")}</select>` : ""}
        <input id="nb-txt" class="fi" maxlength="300" placeholder="${k === "free" ? "例：保育所保育指針の第1章を音読する" : "ひとこと（任意）例：要点を読んでから"}" value="${esc(dr.nb.txt || "")}">
        <span class="row2"><span>期限（任意）</span><input type="date" id="nb-due" class="fi" value="${esc(dr.nb.due || "")}"></span>
        <button class="btn" id="nb-add">＋ 課題を追加</button>
      </div>
      ${r !== undefined ? `<details class="howto"${dr.sjOpen ? " open" : ""} id="c-sjd"><summary>計画の調整（受験科目・1日の時間）</summary>
        <p>変えたいところだけ選びます。生徒が返信を取り込むと学習プランに反映され、履歴に「先生が変更」と残ります。${r && r.p ? "" : "この生徒はまだプランがないので、取り込むとプランが作られます。"}</p>
        <div class="subjset">${SUBJ.map(s => { const v = dr.sj[s.id] || base[s.id]; return `<div class="ss"><span>${s.icon} ${esc(s.name)}${dr.sj[s.id] ? ' <small class="chg">変更</small>' : ""}</span><span class="seg">${["now", "later", "pass"].map(x => `<button class="${v === x ? "on" : ""}" data-csj="${s.id}" data-v="${x}">${SJ_NAME[x]}</button>`).join("")}</span></div>`; }).join("")}</div>
        <div class="row2" style="margin-top:8px"><span>平日</span><select id="c-wd" class="fi"><option value="">変えない${r && r.p ? `（${minLabel(r.p.wd)}）` : ""}</option>${MINS.map(v => `<option value="${v}"${dr.wd === String(v) ? " selected" : ""}>${minLabel(v)}</option>`).join("")}</select>
          <span>週末</span><select id="c-we" class="fi"><option value="">変えない${r && r.p ? `（${minLabel(r.p.we)}）` : ""}</option>${MINS.map(v => `<option value="${v}"${dr.we === String(v) ? " selected" : ""}>${minLabel(v)}</option>`).join("")}</select></div>
      </details>` : ""}
      <button class="btn dark wide" id="c-make" style="margin-top:12px">${tch.srv ? "返信を送る" : "返信コードを作る"}</button>
      <p class="fh" id="c-msg"></p>
      <div id="c-out"></div>
    </div>`;
  }
  function wireComposer(key, r, to, onSent) {
    const dr = drafts[key], rerender = () => { const y = window.scrollY; onSent(null); window.scrollTo(0, y); };
    const q = id => document.getElementById(id);
    const keepText = () => { dr.c = q("c-text").value; dr.nb.txt = q("nb-txt").value; dr.nb.due = q("nb-due").value; };
    q("c-text").oninput = e => { dr.c = e.target.value; };
    $app.querySelectorAll("[data-tpl]").forEach(b => b.onclick = () => { const t = tplList()[+b.dataset.tpl]; const ta = q("c-text"); ta.value = (ta.value ? ta.value.replace(/\s*$/, "") + "\n" : "") + t; dr.c = ta.value; });
    const sel = (id, f) => { const el = q(id); if (el) el.onchange = e => { keepText(); f(e.target.value); rerender(); }; };
    sel("nb-k", v => { dr.nb.k = v; });
    sel("nb-s", v => { dr.nb.sid = v; dr.nb.c = null; dr.nb.th = null; });
    sel("nb-c", v => { dr.nb.c = v; });
    sel("nb-th", v => { dr.nb.th = v; });
    sel("nb-n", v => { dr.nb.n = +v; });
    q("nb-add").onclick = () => {
      keepText();
      const nb = dr.nb, S = subjById[nb.sid] || SUBJ[0];
      if (nb.k === "free" && !nb.txt.trim()) { q("nb-txt").focus(); q("nb-txt").placeholder = "自由課題の内容を書いてください"; return; }
      const a = { id: rid(), k: nb.k, n: nb.n || 10, txt: (nb.txt || "").trim(), due: nb.due || "" };
      if (!["rv", "free"].includes(nb.k)) a.sid = S.id;
      if (nb.k === "cat" || nb.k === "note") a.c = q("nb-c").value;
      if (nb.k === "theme") { a.th = q("nb-th").value; if (!a.th) return; }
      dr.a.push(a);
      nb.txt = ""; nb.due = "";
      rerender();
    };
    $app.querySelectorAll("[data-adel]").forEach(b => b.onclick = () => { keepText(); dr.a.splice(+b.dataset.adel, 1); rerender(); });
    $app.querySelectorAll("[data-csj]").forEach(b => b.onclick = () => {
      keepText(); dr.sjOpen = true;
      const base = r && r.p ? SJ_FROM[r.p.sj[SUBJ.findIndex(s => s.id === b.dataset.csj)]] : "now";
      if (b.dataset.v === base) delete dr.sj[b.dataset.csj]; else dr.sj[b.dataset.csj] = b.dataset.v;
      rerender();
    });
    const sd = q("c-sjd"); if (sd) sd.ontoggle = () => { dr.sjOpen = sd.open; };
    if (q("c-wd")) { q("c-wd").onchange = e => { dr.wd = e.target.value; }; q("c-we").onchange = e => { dr.we = e.target.value; }; }
    q("c-make").onclick = async () => {
      keepText();
      const msg = q("c-msg");
      const sj = Object.keys(dr.sj).length ? Object.assign({}, dr.sj) : null;
      if (sj) { const base = r && r.p ? Object.fromEntries(SUBJ.map((s, i) => [s.id, SJ_FROM[r.p.sj[i]]])) : Object.fromEntries(SUBJ.map(s => [s.id, "now"])); if (!SUBJ.some(s => (sj[s.id] || base[s.id]) === "now")) { msg.style.color = "var(--wrong)"; msg.textContent = "「今回」の受験科目を1つ以上残してください。"; return; } }
      if (!dr.c.trim() && !dr.a.length && !sj && !dr.wd && !dr.we) { msg.style.color = "var(--wrong)"; msg.textContent = "コメントか課題を入れてください。"; return; }
      const o = { v: 1, id: rid(), to, t: Date.now(), fr: tch.name || "", c: dr.c.trim(), a: dr.a.map(a => Object.assign({}, a)) };
      if (sj) o.sj = sj;
      if (dr.wd) o.wd = +dr.wd;
      if (dr.we) o.we = +dr.we;
      if (!tKey) { msg.style.color = "var(--wrong)"; msg.textContent = "指導者ページがロックされました。パスコードを入れ直してください。"; return; }
      const w = await signReply(o);
      const code = await pack(REPLY_PREFIX, w);
      let sent = null;
      if (tch.srv && tApi) {
        q("c-make").disabled = true; msg.style.color = ""; msg.textContent = "送っています…";
        try { const j = await api(tch.srv.u, { act: "reply", auth: tApi, rid: o.id, to, w, sum: (replySummary(o).join("／") + (o.c ? "：" + o.c : "")).slice(0, 300) }); sent = !!(j && j.ok); }
        catch (e) { sent = false; }
      }
      const rec = { id: o.id, t: o.t, c: o.c, a: o.a, sj: o.sj || null, wd: o.wd, we: o.we };
      if (to === "*") tch.all = (tch.all || []).concat(rec).slice(-60);
      else { const x = tch.sts[to]; x.sent = (x.sent || []).concat(rec).slice(-60); }
      saveTeacher();
      delete drafts[key];
      onSent(code, sent);
    };
  }
  const newDraft = () => ({ c: "", a: [], sj: {}, wd: "", we: "", nb: { k: "cat", sid: SUBJ[0].id, c: null, th: null, n: 10, txt: "", due: "" } });
  function sentHtml(sent, r) {
    if (!sent.length) return "";
    return `<h2 class="section-title" style="margin-top:20px">送った返信</h2><div class="fblist">${sent.slice().reverse().slice(0, 12).map(s => `<div class="fbitem"><div class="fbh"><b>${fmtDT(s.t)}</b><span>${s.sj ? "受験科目の変更あり" : ""}</span></div>
      ${s.c ? `<div class="fbt">${nl(s.c)}</div>` : ""}${(s.a || []).map(a => `<div class="rpa">${esc(asgLabel(a))}${asgNote(a) ? `「${esc(asgNote(a))}」` : ""} ${r ? asgStatus(a, r) : ""}</div>`).join("")}</div>`).join("")}</div>`;
  }

  // ---------- 指導者ページ：生徒の詳細 ----------
  // 返信を作ったあとの表示：受け取り先があれば「送りました」、なければ（または失敗したら）コードを表示
  function sentBoxHtml(code, sent, who) {
    if (sent === true) return `<div class="codeout" style="margin-bottom:12px"><b>✓ ${who}のアプリに送りました</b><p class="fh" style="margin:0">生徒が次にアプリを開いたときに届きます。</p>
      <details class="howto" style="margin-top:6px"><summary>コードでも送る（LINEなど）</summary>${codeOutHtml(code, "f", "受け取り先を使わずに送るときのコードです。")}</details>
      <button class="btn wide" id="c-new" style="margin-top:8px">続けて別の返信を書く</button></div>`;
    return `<div class="codeout" style="margin-bottom:12px">${sent === false ? `<div class="warn" style="margin-bottom:8px">受け取り先に送れませんでした。かわりに下のコードを送ってください。</div>` : ""}<b>返信コードができました</b>${codeOutHtml(code, "f", "このコードを生徒に送ってください。生徒が「先生に送る」画面に貼ると取り込めます。")}<button class="btn wide" id="c-new" style="margin-top:8px">続けて別の返信を書く</button></div>`;
  }
  function renderTStudent(id, code, sent) {
    session = null; current = null;
    const x = tch.sts[id], r = x.rep;
    if (!drafts[id]) drafts[id] = newDraft();
    const own = (x.sent || []), cls = (tch.all || []).filter(s => s.t > 0);
    const allAsg = own.concat(cls).flatMap(s => s.a || []);
    const pend = allAsg.filter(a => !(r.a || {})[a.id]);
    $app.innerHTML = `
      <button class="back" id="to-t" style="margin-bottom:14px">← クラス一覧</button>
      <div class="brand"><span class="badge">👩‍🏫 指導者ページ</span></div>
      <h1>${esc(r.nk || "名前なし")}さん</h1>
      <p class="lead">レポート ${fmtDT(r.t)}（${ago(r.t)}）　<button class="link-btn" id="t-print">🖨 面談用の1枚レポート</button></p>
      ${studentBodyHtml(r)}
      ${allAsg.length ? `<h2 class="section-title" style="margin-top:18px">出した課題<small>${allAsg.length - pend.length} / ${allAsg.length} 完了（このレポート時点）</small></h2>
        <div class="asglist">${allAsg.slice().reverse().slice(0, 20).map(a => `<div class="asgrow${(r.a || {})[a.id] ? " done" : ""}"><span>${(r.a || {})[a.id] ? "✓" : "□"}</span><div><b>${esc(asgLabel(a))}</b>${asgNote(a) ? `<small>「${esc(asgNote(a))}」</small>` : ""}<small>${cls.some(s => (s.a || []).includes(a)) ? "クラス全員あて・" : ""}${a.due ? "期限 " + fmtMD(parseDay(a.due)) + "・" : ""}${asgStatus(a, r)}</small></div></div>`).join("")}</div>` : ""}
      <h2 class="section-title" style="margin-top:20px">✉️ ${esc(r.nk || "")}さんに返信する</h2>
      ${code ? sentBoxHtml(code, sent, esc(r.nk || "生徒") + "さん") : composerHtml(id, r)}
      <label class="fl">先生のメモ<small>生徒には送られません</small></label>
      <textarea id="t-memo" class="fi" style="width:100%;height:70px">${esc(x.memo || "")}</textarea>
      ${sentHtml(own, r)}
      <button class="link-btn" id="t-del" style="margin-top:18px;color:var(--wrong)">この生徒のデータを削除</button>
      ${footer()}`;
    document.getElementById("to-t").onclick = () => go("teacher");
    document.getElementById("t-print").onclick = () => go("teacher/print/" + id);
    document.getElementById("t-memo").onchange = e => { x.memo = e.target.value.slice(0, 2000); saveTeacher(); };
    if (code) { wireCodeOut(code, "f", `${tch.name || "先生"}からの返信（保育士試験アプリ）`); document.getElementById("c-new").onclick = () => renderTStudent(id); }
    else wireComposer(id, r, id, (c, sn) => renderTStudent(id, c, sn));
    const del = document.getElementById("t-del");
    del.onclick = () => {
      if (!del.dataset.c) { del.dataset.c = 1; del.textContent = tch.srv ? "もう一度押すと削除します（スプレッドシートの提出と返信も消します）" : "もう一度押すと削除します"; return; }
      if (tch.srv && tApi) api(tch.srv.u, { act: "remove", auth: tApi, id }).catch(() => {});
      delete tch.sts[id]; saveTeacher(); go("teacher");
    };
    wireFooter();
    document.title = `${r.nk || "生徒"}｜指導者ページ`;
    if (!code) window.scrollTo(0, 0); else setTimeout(() => { const o = document.querySelector(".codeout"); if (o) o.scrollIntoView({ block: "center" }); }, 30);
  }

  // ---------- 指導者ページ：クラス全員に返信 ----------
  function renderTAll(code, sent) {
    session = null; current = null;
    if (!drafts["*"]) drafts["*"] = newDraft();
    if (presetAsg) { drafts["*"].a.push(Object.assign({ id: rid() }, presetAsg)); presetAsg = null; }
    $app.innerHTML = `
      <button class="back" id="to-t" style="margin-bottom:14px">← クラス一覧</button>
      <div class="brand"><span class="badge">👩‍🏫 指導者ページ</span></div>
      <h1>クラス全員に返信</h1>
      <p class="lead">同じコメント・課題をクラス全員に送ります。${tch.srv ? "教室に参加している生徒のアプリに届きます" : "誰でも取り込める返信コードになるので、グループLINEなどで送れます"}（受験科目の変更は生徒ごとの返信でおこないます）。</p>
      ${code ? sentBoxHtml(code, sent, "クラス全員") : composerHtml("*", undefined)}
      ${sentHtml(tch.all || [], null)}
      ${footer()}`;
    document.getElementById("to-t").onclick = () => go("teacher");
    if (code) { wireCodeOut(code, "f", `${tch.name || "先生"}からクラスへの返信（保育士試験アプリ）`); document.getElementById("c-new").onclick = () => renderTAll(); }
    else wireComposer("*", undefined, "*", (c, sn) => renderTAll(c, sn));
    wireFooter();
    document.title = "クラス全員に返信｜指導者ページ";
    window.scrollTo(0, 0);
  }

  // ---------- 指導者ページ：クラス共通のつまずき ----------
  function renderTClass() {
    session = null; current = null;
    const sts = Object.values(tch.sts).map(x => x.rep), N = sts.length;
    const qn = {}, cat = {};
    sts.forEach(r => {
      new Set(r.x || []).forEach(id => { const q = qById[id]; if (!q) return; qn[id] = (qn[id] || 0) + 1; const k = subjOfQ[id] + "/" + q.c; (cat[k] = cat[k] || { st: new Set(), q: 0, rates: [] }).st.add(r.id); cat[k].q++; });
      (r.wk || []).forEach(w => { const k = w[0] + "/" + w[1]; (cat[k] = cat[k] || { st: new Set(), q: 0, rates: [] }).rates.push(w[2]); cat[k].st.add(r.id); });
    });
    const topQ = Object.entries(qn).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const topC = Object.entries(cat).sort((a, b) => b[1].st.size - a[1].st.size || b[1].q - a[1].q).slice(0, 10);
    const subjAvg = SUBJ.map(S => { const xs = sts.map(r => (r.s || {})[S.id]).filter(x => x && x[0]); if (!xs.length) return null;
      const rates = xs.map(x => x[7]).filter(v => v !== null), lv = [0, 0, 0, 0]; xs.forEach(x => lv[x[6] || 0]++);
      return { S, n: xs.length, rate: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null, lv }; }).filter(Boolean);
    $app.innerHTML = `
      <button class="back" id="to-t" style="margin-bottom:14px">← クラス一覧</button>
      <div class="brand"><span class="badge">👩‍🏫 指導者ページ</span></div>
      <h1>クラス共通のつまずき</h1>
      <p class="lead">取り込んだ${N}人のレポートから集計しました。授業で取り上げる内容を選ぶのに使えます。</p>
      ${subjAvg.length ? `<h2 class="section-title">科目ごとの状況</h2><div class="phtable">${subjAvg.map(o => `<div class="phrow"><span>${o.S.icon} ${esc(o.S.name)}</span><span>平均正答率 <b>${o.rate === null ? "–" : o.rate + "%"}</b></span><span class="tsig">${[3, 2, 1].map(l => o.lv[l] ? `<span class="sig s${l}"><i></i>${o.lv[l]}人</span>` : "").join("")}</span></div>`).join("")}</div>` : ""}
      <h2 class="section-title">つまずいている分野<small>間違えたまま・苦手分野にあげている人数</small></h2>
      ${topC.length ? `<div class="phtable">${topC.map(([k, o]) => { const [sid, cid] = k.split("/"), S = subjById[sid], c = S && S.categories.find(x => x.id === cid); if (!c) return "";
        return `<div class="phrow"><span>${c.icon} ${esc(c.name)}<small class="tsub"> ${esc(S.name)}</small></span><b>${o.st.size}人</b><button class="wbtn" data-preset="${k}">全員の課題に</button><small>${o.q ? `間違えたままの問題 のべ${o.q}問` : ""}${o.rates.length ? `${o.q ? "・" : ""}苦手分野の正答率 ${Math.min(...o.rates)}〜${Math.max(...o.rates)}%` : ""}</small></div>`; }).join("")}</div>` : `<p class="note">まだ集計できるデータがありません。</p>`}
      <h2 class="section-title">多くの生徒が間違えている問題</h2>
      ${topQ.length ? `<div class="missed">${topQ.map(([id, n]) => { const q = qById[id]; return `<details class="missed-item"><summary><b>${n}人</b>　<small class="tsub">${esc(subjById[subjOfQ[id]].name)}・${esc(catOf(q).name)}</small> ${esc(shortQ(q))}</summary><div class="sb">${factsHtml(q)}<p class="ex">${esc(q.e)}</p></div></details>`; }).join("")}</div>` : `<p class="note">まだ集計できるデータがありません。</p>`}
      ${footer()}`;
    document.getElementById("to-t").onclick = () => go("teacher");
    $app.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => { const [sid, c] = b.dataset.preset.split("/"); presetAsg = { k: "cat", sid, c, n: 10, txt: "", due: "" }; go("teacher/all"); });
    wireFooter();
    document.title = "クラス共通のつまずき｜指導者ページ";
    window.scrollTo(0, 0);
  }

  // ---------- 指導者ページ：面談用の1枚レポート（印刷） ----------
  function renderTPrint(id) {
    session = null; current = null;
    const x = tch.sts[id], r = x.rep, M = repMetrics(r), tg = repTargets(r);
    const mocks = {}; (r.mk || []).filter(m => m[1] > r.t - 30 * DAY).forEach(m => { (mocks[m[0]] = mocks[m[0]] || []).push(m); });
    const rs = r.r || {}, rTot = (rs.k || 0) + (rs.y || 0) + (rs.m || 0) + (rs.u || 0);
    const own = (x.sent || []).concat(tch.all || []).filter(s => s.t > r.t - 30 * DAY).flatMap(s => s.a || []);
    $app.innerHTML = `
      <div class="noprint">
        <button class="back" id="to-s" style="margin-bottom:14px">← ${esc(r.nk || "")}さん</button>
        <div class="actions" style="margin-bottom:14px"><button class="btn dark" id="p-print">🖨 印刷する</button><button class="btn" id="to-s2">もどる</button></div>
        <p class="fh" style="margin-bottom:12px">「次の目標」は書き込んでから印刷できます（保存されます）。</p>
      </div>
      <div class="printpage">
        <div class="pp-h"><h1>学習レポート（面談用）</h1><span>${esc(r.nk || "")}さん　${fmtMD(r.t - 29 * DAY)}〜${fmtMD(r.t)}　${esc(tch.name || "")}</span></div>
        <div class="overall">
          <div class="stat"><div class="num">${M.m30.days}<small style="font-size:13px">日</small></div><div class="lbl">学習した日（30日間）</div></div>
          <div class="stat"><div class="num">${M.m30.n}</div><div class="lbl">解いた問題</div></div>
          <div class="stat"><div class="num">${M.m30.rate === null ? "–" : M.m30.rate + "%"}</div><div class="lbl">正答率・${Math.round(M.m30.min / 6) / 10}時間</div></div>
        </div>
        ${calendarHtml(5, repLog(r))}
        ${r.p ? `<p class="pp-p">受験日 ${dateJa(r.p.ex)}（あと${daysTo(r.p.ex)}日）・${PH[r.p.ph]}期・${r.p.lag ? "計画より" + r.p.lag + "問遅れ" : "計画どおり"}・受験科目 ${tg.length}科目</p>` : ""}
        <table class="qtable pp-t"><thead><tr><th>科目</th><th>合格ライン</th><th>挑戦</th><th>正答率</th><th>最頻出の理解度</th><th>模擬試験</th></tr></thead><tbody>
          ${SUBJ.filter(S => (r.s || {})[S.id]).map(S => { const v = r.s[S.id]; return `<tr${tg.includes(S.id) ? "" : ' class="pp-dim"'}><td>${esc(S.name)}</td><td>${["データ不足", "要強化", "もう一歩", "合格圏"][v[6] || 0]}</td><td class="n">${v[0]}/${v[1]}</td><td class="n">${v[7] === null ? "–" : v[7] + "%"}</td><td class="n">${v[8] === null ? "–" : v[8] + "%"}</td><td class="n">${mocks[S.id] ? mocks[S.id].map(m => Math.round(m[3] / m[2] * 100) + "%").join("→") : "–"}</td></tr>`; }).join("")}
        </tbody></table>
        <div class="pp-2">
          <div><h3>苦手分野</h3>${(r.wk || []).slice(0, 5).map(w => { const S = subjById[w[0]], c = S && S.categories.find(y => y.id === w[1]); return c ? `<div>${esc(c.name)}（${esc(SHORT[w[0]])}）${w[2]}%</div>` : ""; }).join("") || "<div>なし</div>"}</div>
          <div><h3>間違いの理由（30日）</h3>${rTot ? REASONS.map(([k, t]) => `<div>${t}：${rs[k] || 0}</div>`).join("") : "<div>記録なし</div>"}<div>迷って正解：${r.g || 0}問</div></div>
        </div>
        ${own.length ? `<h3>この1か月の課題</h3><div class="pp-a">${own.map(a => `<div>${(r.a || {})[a.id] ? "✓" : "□"} ${esc(asgLabel(a))}</div>`).join("")}</div>` : ""}
        <h3>次の目標</h3>
        <textarea id="p-goal" class="fi pp-goal" placeholder="例：社会福祉の最頻出テーマの理解度を60%に。週末に模擬試験を1回。">${esc(x.goal || "")}</textarea>
      </div>`;
    document.getElementById("to-s").onclick = document.getElementById("to-s2").onclick = () => go("teacher/s/" + id);
    document.getElementById("p-print").onclick = () => window.print();
    document.getElementById("p-goal").onchange = e => { x.goal = e.target.value.slice(0, 1000); saveTeacher(); };
    document.title = `${r.nk || ""}さん 学習レポート`;
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
    return CODE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify({ s: stats, v: rv, f: fm, r: resetAt, rs: resets, l: log, cf, p: plan, mk, ck, me, tf }))));
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
      if (obj.me && typeof obj.me === "object" && typeof obj.me.id === "string") {
        const m = { id: obj.me.id.slice(0, 40), nick: String(obj.me.nick || "").slice(0, 20), t: +obj.me.t || 0 };
        if (typeof obj.me.tok === "string") m.tok = obj.me.tok.slice(0, 64);
        if (obj.me.srv && typeof obj.me.srv.u === "string") m.srv = { u: obj.me.srv.u, n: String(obj.me.srv.n || "").slice(0, 40), t: +obj.me.srv.t || 0 };
        if (obj.me.auto !== undefined) m.auto = !!obj.me.auto;
        me = mergeMe(me, m);
      }
      if (obj.tf && typeof obj.tf === "object") tf = mergeTf(tf, obj.tf);
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
    } else { stats = {}; rv = {}; fm = {}; cf = {}; log = {}; mk = []; ck = {}; resetAt = now; } // 学習プランの設定・先生からの返信は残す
    saveLocal(); push();
    modal.classList.remove("show"); route();
  };

  if (/[?&]debug\b/.test(location.search)) window.__hk = { start, qById, variantOf, kindsOf, hotLevel, targetForms, ALL, drillItems, phasesOf, outlook, menuItems, mockPick, crossTerms, signal, get plan() { return plan; }, get log() { return log; } };
  restoreTeacher().finally(() => { route(); setTimeout(() => syncServer(true), 1200); });
})();
