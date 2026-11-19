(function () {
  const STORE_KEY = "hoikushi-kyouikugenri-v1"; // 初版からの記録を引き継ぐためキー名は据え置き
  const DOC_ID = "kyouiku-genri";
  const KEYS4 = ["A", "B", "C", "D"];
  const ORDER = ["hoiku-genri", "kyouiku-genri", "shakaiteki-yougo", "kodomo-katei-fukushi", "shakai-fukushi",
                 "hoiku-shinri", "kodomo-hoken", "shoku-eiyou", "jisshu-riron"];
  const SUBJ = SUBJECTS.slice().sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const subjById = Object.fromEntries(SUBJ.map(s => [s.id, s]));
  const subjOfQ = {};
  SUBJ.forEach(s => s.questions.forEach(q => { subjOfQ[q.id] = s.id; }));
  const ALL = SUBJ.flatMap(s => s.questions);
  const isExam = q => q.type === "combo" || q.type === "multi" || q.fixed;

  // ---------- local storage (safe) ----------
  let stats = {}, resetAt = 0, resets = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
    if (raw.stats) { stats = raw.stats; resetAt = raw.resetAt || 0; resets = raw.resets || {}; }
    else stats = raw;
  } catch (e) { stats = {}; }
  function saveLocal() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ stats, resetAt, resets })); } catch (e) {} }

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
  function absorbMeta(rAt, rs) {
    if ((rAt || 0) > resetAt) resetAt = rAt;
    Object.entries(rs || {}).forEach(([k, v]) => { if ((v || 0) > (resets[k] || 0)) resets[k] = v; });
  }

  function record(id, ok) {
    const s = Object.assign({ c: 0, w: 0, last: null }, stats[id]);
    ok ? s.c++ : s.w++;
    s.last = ok; s.t = Date.now();
    stats[id] = s;
    saveLocal(); schedulePush();
  }
  const isWeak = q => stats[q.id] && stats[q.id].last === false;

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
  function schedulePush() { if (!docRef) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500); }
  async function push() {
    if (!docRef) return;
    if (writing) { dirty = true; return; }
    writing = true;
    try {
      await docRef.set({ stats: JSON.parse(JSON.stringify(stats)), resetAt, resets: Object.assign({}, resets), updatedAt: Date.now() });
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
    const before = JSON.stringify([stats, resetAt, resets]);
    absorbMeta(body.resetAt, body.resets);
    stats = merge(stats, body.stats || {});
    saveLocal();
    return JSON.stringify([stats, resetAt, resets]) !== before;
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
      if (!remote || JSON.stringify([remote.stats || {}, remote.resetAt || 0, remote.resets || {}]) !== JSON.stringify([stats, resetAt, resets])) await push();
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
  const optText = (q, i) => q.type === "multi" ? q.a.map(j => `${j + 1}. ${q.o[j]}`).join(" ／ ") : q.type === "combo" ? q.cols.map((c, k) => `${c}：${q.o[i][k]}`).join("　") : q.o[i];
  const ansLabel = q => q.type === "multi" ? q.a.map(j => j + 1).join("・") : isExam(q) ? String(q.a + 1) : "";
  function summary(qs) {
    let tried = 0, mastered = 0, c = 0, w = 0;
    qs.forEach(q => { const s = stats[q.id]; if (s) { tried++; c += s.c; w += s.w; if (s.last) mastered++; } });
    return { total: qs.length, tried, mastered, rate: (c + w) ? Math.round(c / (c + w) * 100) : null };
  }
  const rateHtml = r => r === null ? "<small>未挑戦</small>" : r + "<small>%</small>";
  const statBox = (s, weak) => `
    <div class="overall">
      <div class="stat"><div class="num">${s.tried}<small style="font-size:14px;color:var(--sub)">/${s.total}</small></div><div class="lbl">挑戦した問題</div></div>
      <div class="stat"><div class="num">${s.rate === null ? "–" : s.rate + "%"}</div><div class="lbl">通算正答率</div></div>
      <div class="stat"><div class="num" style="color:${weak ? "var(--wrong)" : "inherit"}">${weak}</div><div class="lbl">要復習</div></div>
    </div>`;

  // ---------- routing ----------
  let session = null, current = null, resetTarget = null;
  function route() {
    const id = (location.hash || "").replace(/^#/, "");
    if (subjById[id]) renderSubject(subjById[id]); else renderTop();
  }
  window.addEventListener("hashchange", () => { session = null; route(); });
  function go(id) {
    const h = id ? "#" + id : "";
    if ((location.hash || "") === h) { session = null; route(); return; }
    try { if (id) location.hash = id; else history.pushState(null, "", location.pathname + location.search); } catch (e) {}
    session = null; route();
  }

  // ---------- session ----------
  function start(title, pool) {
    if (!pool.length) return;
    session = {
      title, back: current ? current.id : null,
      items: shuffle(pool).map(q => {
        if (q.type === "multi") return { q, order: q.o.map((_, i) => i), answer: q.a, exam: true, multi: true, sel: [] };
        if (isExam(q)) return { q, order: q.o.map((_, i) => i), answer: q.a, exam: true };
        const order = shuffle(q.o.map((_, i) => i));
        return { q, order, answer: order.indexOf(q.a), exam: false };
      }),
      i: 0, results: []
    };
    renderQuestion();
  }
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

  function renderTop() {
    session = null; current = null;
    const all = summary(ALL);
    const weak = ALL.filter(isWeak).length;
    $app.innerHTML = `
      <div class="brand"><span class="badge">保育士試験対策</span></div>
      <h1>保育士資格試験問題集</h1>
      <p class="lead">筆記試験 全9科目・${ALL.length}問。科目を選んでください。</p>
      ${statBox(all, weak)}
      <div class="modes" style="margin-bottom:22px">
        <button class="mode" data-top="weak" ${weak ? "" : "disabled"}><span class="t">全科目の間違えた問題</span><span class="d">${weak ? weak + "問を復習" : "まだありません"}</span></button>
        <button class="mode" data-top="random"><span class="t">全科目ミックス 20問</span><span class="d">科目をまたいでおまかせ出題</span></button>
      </div>
      <h2 class="section-title">科目を選ぶ</h2>
      <div class="subjects">
        ${SUBJ.map(s => {
          const sm = summary(s.questions);
          const pct = Math.round(sm.mastered / sm.total * 100);
          return `<button class="subj" data-subj="${s.id}">
            <span class="ic">${s.icon}</span>
            <span class="name">${esc(s.name)}</span>
            <span class="meta">${sm.total}問・本番${s.examCount}問</span>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <span class="rate">${rateHtml(sm.rate)}</span>
          </button>`;
        }).join("")}
      </div>
      <p class="note">合格基準は各科目6割以上。「教育原理」と「社会的養護」は1科目として扱われ、それぞれ6割以上が必要です。</p>
      ${footer()}`;
    $app.querySelectorAll("[data-subj]").forEach(b => b.onclick = () => go(b.dataset.subj));
    $app.querySelectorAll("[data-top]").forEach(b => b.onclick = () => {
      if (b.dataset.top === "weak") start("全科目の復習", ALL.filter(isWeak));
      else start("全科目ミックス 20問", shuffle(ALL).slice(0, 20));
    });
    wireFooter();
    document.title = "保育士資格試験問題集";
    window.scrollTo(0, 0);
  }

  function renderSubject(S) {
    session = null; current = S;
    const QS = S.questions;
    const all = summary(QS);
    const exam = QS.filter(isExam);
    const weak = QS.filter(isWeak).length;
    const n = Math.min(S.examCount, exam.length);
    $app.innerHTML = `
      <button class="back" id="to-top" style="margin-bottom:14px">← 科目一覧</button>
      <div class="brand"><span class="badge">${S.icon} 保育士試験対策</span></div>
      <h1>${esc(S.name)}</h1>
      <p class="lead">全${QS.length}問（一問一答${QS.length - exam.length}問＋本番形式${exam.length}問）・本試験は${S.examCount}問</p>
      ${statBox(all, weak)}
      <div class="modes">
        <button class="mode primary" data-mode="exam" ${n ? "" : "disabled"}><span class="t">本番形式 ${n}問</span><span class="d">組合せ・5択問題から出題</span></button>
        <button class="mode" data-mode="random"><span class="t">ランダム10問</span><span class="d">この科目からおまかせ</span></button>
        <button class="mode" data-mode="weak" ${weak ? "" : "disabled"}><span class="t">間違えた問題を復習</span><span class="d">${weak ? weak + "問（正解すると外れます）" : "まだありません"}</span></button>
        <button class="mode" data-mode="unseen" ${all.tried < all.total ? "" : "disabled"}><span class="t">未挑戦の問題</span><span class="d">あと${all.total - all.tried}問</span></button>
      </div>
      <h2 class="section-title">分野別に解く</h2>
      <div class="cats">
        ${S.categories.map(c => {
          const qs = QS.filter(q => q.c === c.id);
          if (!qs.length) return "";
          const s = summary(qs);
          const ex = qs.filter(isExam).length;
          const pct = Math.round(s.mastered / s.total * 100);
          return `<button class="cat" data-cat="${c.id}">
            <span class="ic">${c.icon}</span>
            <span>
              <span class="name">${esc(c.name)}</span>
              <span class="meta">${s.total}問（うち本番形式${ex}）　直近正解 ${s.mastered}問</span>
              <div class="bar"><i style="width:${pct}%"></i></div>
            </span>
            <span class="rate">${rateHtml(s.rate)}</span>
          </button>`;
        }).join("")}
      </div>
      ${footer()}`;
    document.getElementById("to-top").onclick = () => go(null);
    $app.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
      const m = b.dataset.mode;
      if (m === "exam") start(`${S.name} 本番形式 ${n}問`, shuffle(exam).slice(0, n));
      if (m === "random") start(`${S.name} ランダム10問`, shuffle(QS).slice(0, 10));
      if (m === "weak") start(`${S.name} 復習`, QS.filter(isWeak));
      if (m === "unseen") start(`${S.name} 未挑戦`, QS.filter(q => !stats[q.id]));
    });
    $app.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => {
      const c = S.categories.find(x => x.id === b.dataset.cat);
      start(`${S.name}：${c.name}`, QS.filter(q => q.c === c.id));
    });
    wireFooter();
    document.title = `${S.name}｜保育士資格試験問題集`;
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

  function renderQuestion() {
    const it = session.items[session.i];
    const q = it.q;
    const S = subjById[subjOfQ[q.id]];
    const cat = S.categories.find(c => c.id === q.c) || { icon: "", name: "" };
    const n = session.items.length;
    $app.innerHTML = `
      <div class="topbar">
        <button class="back" id="quit">← やめる</button>
        <div class="progress"><i style="width:${session.i / n * 100}%"></i></div>
        <span class="count">${session.i + 1} / ${n}</span>
      </div>
      <div class="qcard">
        <div class="qcat">${session.back ? "" : `<span class="tag-subj">${esc(S.name)}</span>`}${cat.icon} ${esc(cat.name)}${it.exam ? '<span class="tag-exam">本番形式</span>' : ""}</div>
        <p class="qtext">${esc(q.q)}</p>
        ${q.items ? `<div class="stmts">${q.items.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${q.pool ? `<div class="stmts pool">${q.pool.map(s => `<div>${esc(s)}</div>`).join("")}</div>` : ""}
        ${optionsHtml(it)}
        <div class="explain" id="explain"></div>
        <button class="next" id="next">${session.i + 1 < n ? "次の問題へ" : "結果を見る"}</button>
      </div>
      <p class="hint">キーボード：${it.multi ? "1〜5で選択／Enterで回答・次へ" : (it.exam ? "1〜5" : "A〜D（1〜4）") + "で回答／Enterで次へ"}</p>`;
    document.getElementById("quit").onclick = () => session.results.length ? renderResult() : leave();
    $app.querySelectorAll(".opt").forEach(b => b.onclick = () => answer(+b.dataset.k));
    const sb = document.getElementById("submit");
    if (sb) sb.onclick = submitMulti;
    document.getElementById("next").onclick = next;
    window.scrollTo(0, 0);
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
    record(it.q.id, ok);
    session.results.push({ q: it.q, ok });
    $app.querySelectorAll(".opt").forEach((b, idx) => {
      b.disabled = true; b.classList.remove("sel");
      const isAns = it.answer.includes(idx), picked = it.sel.includes(idx);
      if (isAns) { b.classList.add("correct"); b.querySelector(".mk").textContent = picked ? "○" : "△"; }
      else if (picked) { b.classList.add("wrong"); b.querySelector(".mk").textContent = "×"; }
      else b.classList.add("dim");
    });
    document.getElementById("submit").style.display = "none";
    showExplain(it, ok, ansLabel(it.q));
  }
  function leave() { const b = session && session.back; session = null; b ? renderSubject(subjById[b]) : renderTop(); }

  function answer(k) {
    const it = session.items[session.i];
    if (k >= it.order.length) return;
    if (it.multi) return toggleMulti(it, k);
    if (it.chosen !== undefined) return;
    it.chosen = k;
    const ok = k === it.answer;
    record(it.q.id, ok);
    session.results.push({ q: it.q, ok });
    $app.querySelectorAll(".opt").forEach((b, idx) => {
      b.disabled = true;
      if (idx === it.answer) { b.classList.add("correct"); b.querySelector(".mk").textContent = "○"; }
      else if (idx === k) { b.classList.add("wrong"); b.querySelector(".mk").textContent = "×"; }
      else b.classList.add("dim");
    });
    showExplain(it, ok, label(it, it.answer));
  }
  function showExplain(it, ok, ansText) {
    const ex = document.getElementById("explain");
    ex.className = "explain show " + (ok ? "ok" : "ng");
    ex.innerHTML = `<div class="verdict">${ok ? "正解！" : "不正解… 正解は " + ansText}</div>${esc(it.q.e)}`;
    const nb = document.getElementById("next");
    nb.classList.add("show");
    setTimeout(() => { try { nb.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {} }, 60);
    document.querySelector(".progress > i").style.width = (session.results.length / session.items.length * 100) + "%";
  }
  function next() { if (session.i + 1 < session.items.length) { session.i++; renderQuestion(); } else renderResult(); }

  function renderResult() {
    const r = session.results;
    const okN = r.filter(x => x.ok).length;
    const pct = r.length ? Math.round(okN / r.length * 100) : 0;
    const missed = r.filter(x => !x.ok);
    const C = 2 * Math.PI * 60;
    const msg = pct >= 90 ? ["すばらしい！", "この調子で他の分野も固めましょう。"]
              : pct >= 60 ? ["合格ラインです", "合格基準は各科目6割以上。間違えた問題を見直してさらに上へ。"]
              : ["もう一歩！", "解説を読んで、間違えた問題を復習しましょう。"];
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
      </div>
      ${missed.length ? `<h2 class="section-title">間違えた問題（${missed.length}問）</h2>
        <div class="missed">${missed.map(x => `
          <div class="missed-item">${esc(x.q.q.split("\n")[0])}<div class="ans">正解：${x.q.type === "multi" ? "" : (isExam(x.q) ? ansLabel(x.q) + "　" : "")}${esc(optText(x.q, x.q.a))}</div></div>`).join("")}
        </div>` : ""}
      <div class="actions">
        <button class="btn" id="home">${session.back ? "科目のトップへ" : "科目一覧へ"}</button>
        <button class="btn dark" id="retry">${missed.length ? "間違えた問題を解き直す" : "もう一度"}</button>
      </div>`;
    const title = session.title, back = session.back;
    const pool = missed.length ? missed.map(x => x.q) : session.items.map(x => x.q);
    document.getElementById("home").onclick = leave;
    document.getElementById("retry").onclick = () => { current = back ? subjById[back] : null; start(missed.length ? "解き直し" : title, pool); };
    window.scrollTo(0, 0);
  }

  // ---------- keyboard ----------
  document.addEventListener("keydown", e => {
    if (!session || !document.querySelector(".qcard")) return;
    const it = session.items[session.i];
    const map = it.exam ? { "1": 0, "2": 1, "3": 2, "4": 3, "5": 4 } : { a: 0, b: 1, c: 2, d: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
    const k = map[e.key.toLowerCase()];
    if (k !== undefined) answer(k);
    else if (e.key === "Enter" && it.chosen !== undefined) next();
    else if (e.key === "Enter" && it.multi) submitMulti();
  });

  // ---------- transfer code (works without login) ----------
  const CODE_PREFIX = "HKG1:";
  function encode() {
    return CODE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify({ s: stats, r: resetAt, rs: resets }))));
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
      const clean = {};
      Object.entries(obj.s).forEach(([id, v]) => {
        if (v && typeof v === "object") clean[id] = { c: +v.c || 0, w: +v.w || 0, last: v.last === true ? true : v.last === false ? false : null, t: +v.t || 0 };
      });
      stats = merge(stats, clean);
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
      subjById[resetTarget].questions.forEach(q => { delete stats[q.id]; });
    } else { stats = {}; resetAt = now; }
    saveLocal(); push();
    modal.classList.remove("show"); route();
  };

  route();
})();
