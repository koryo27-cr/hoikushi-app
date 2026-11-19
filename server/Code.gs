// 保育士試験アプリ：提出と返信の受け取り（Googleスプレッドシート＋Apps Script）
//
// 設定のしかた（先生が1回だけ）
//   1. Googleスプレッドシートを新しく作る（名前は自由。例：保育士試験アプリ 提出）
//   2. メニューの「拡張機能」→「Apps Script」を開き、最初からある中身を消して、このファイルの内容をすべて貼り付けて保存
//   3. 右上の「デプロイ」→「新しいデプロイ」→ 種類の歯車で「ウェブアプリ」を選ぶ
//      実行するユーザー：自分　／　アクセスできるユーザー：全員　→「デプロイ」→ Googleアカウントでアクセスを承認
//   4. 表示された「ウェブアプリのURL」（https://script.google.com/macros/s/…/exec）をコピーし、
//      アプリの指導者ページ →「提出の受け取り」に貼って「接続する」
//
// しくみ
//   - 生徒はログイン不要。レポートを「提出」シートに送り、先生からの返信を受け取る
//   - 提出の読み出しと返信の書き込みは、指導者ページのパスコードで開いた先生だけができる
//     （最初に「接続する」を押した先生のパスコードの鍵を登録。登録をやり直すときは、
//       Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」で TEACHER を削除）
//   - 生徒あての返信は、本人の端末の鍵がないと受け取れない。返信には先生の署名がついていて、生徒のアプリが確かめる
//   - 「提出」シートは生徒1人につき1行（新しい提出で上書き）。「返信」シートは送った順に1行ずつ
const REPORTS = "提出", REPLIES = "返信";
const HEAD_R = ["生徒ID", "ニックネーム", "提出日時", "最後に学習した日", "この7日間の問題数", "7日間の正答率", "段階", "計画との差", "声かけ", "レポート（アプリ用・編集しない）", "鍵（編集しない）"];
const HEAD_Y = ["返信ID", "宛先（*はクラス全員）", "送信日時", "内容", "返信（アプリ用・編集しない）"];
const ID_RX = /^[a-z0-9]{6,40}$/;
const KEEP_DAYS = 90; // 返信を生徒に配る期間

function doGet() { return out({ ok: true, app: "hoikushi", v: 1 }); }
function doPost(e) {
  let q;
  try { q = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, err: "json" }); }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return out(handle(q || {})); }
  catch (x) { return out({ ok: false, err: String((x && x.message) || x) }); }
  finally { lock.releaseLock(); }
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sheet(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}
function isTeacher(q) {
  const h = PropertiesService.getScriptProperties().getProperty("TEACHER");
  return !!(h && q.auth && sha(q.auth) === h);
}

function handle(q) {
  const P = PropertiesService.getScriptProperties();
  switch (q.act) {
    case "ping":
      return { ok: true, teacher: isTeacher(q), ready: !!P.getProperty("TEACHER") };

    case "setup": // 最初に接続した先生の鍵を登録する
      if (P.getProperty("TEACHER")) return { ok: isTeacher(q), already: true };
      if (!q.auth || String(q.auth).length < 20) return { ok: false, err: "bad" };
      P.setProperty("TEACHER", sha(q.auth));
      return { ok: true, first: true };

    case "submit": { // 生徒のレポート（1人1行、上書き）
      const r = q.rep;
      if (!r || !ID_RX.test(String(r.id)) || typeof q.tok !== "string" || q.tok.length < 16) return { ok: false, err: "bad" };
      const json = JSON.stringify(r);
      if (json.length > 45000) return { ok: false, err: "big" };
      const sh = sheet(REPORTS, HEAD_R), vals = sh.getDataRange().getValues(), th = sha(q.tok);
      let row = -1;
      for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === r.id) {
        if (vals[i][10] && vals[i][10] !== th) return { ok: false, err: "tok" }; // 別の人が同じIDを名乗っている
        row = i + 1; break;
      }
      const s = q.sum || {};
      const line = [r.id, String(r.nk || "").slice(0, 20), new Date(), String(s.last || ""), +s.w || 0, s.rate == null ? "" : s.rate + "%",
        String(s.ph || ""), String(s.lag || ""), String(s.flags || "").slice(0, 200), json, th];
      if (row > 0) sh.getRange(row, 1, 1, line.length).setValues([line]); else sh.appendRow(line);
      return { ok: true, t: Date.now() };
    }

    case "inbox": { // 生徒が自分あて・クラス全員あての返信を受け取る
      if (!ID_RX.test(String(q.id))) return { ok: false, err: "bad" };
      const vals = sheet(REPORTS, HEAD_R).getDataRange().getValues();
      let mine = false;
      for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === q.id) { mine = !!vals[i][10] && vals[i][10] === sha(q.tok || ""); break; }
      const from = Date.now() - KEEP_DAYS * 864e5;
      const ys = sheet(REPLIES, HEAD_Y).getDataRange().getValues().slice(1)
        .filter(y => (String(y[1]) === "*" || (mine && String(y[1]) === q.id)) && new Date(y[2]).getTime() > from);
      return { ok: true, mine, w: ys.slice(-60).map(y => String(y[4])) };
    }

    case "reports": // 先生：提出をすべて読む
      if (!isTeacher(q)) return { ok: false, err: "auth" };
      return { ok: true, reps: sheet(REPORTS, HEAD_R).getDataRange().getValues().slice(1).map(v => String(v[9])).filter(Boolean) };

    case "reply": { // 先生：返信を置く（署名つき）
      if (!isTeacher(q)) return { ok: false, err: "auth" };
      const to = String(q.to || "");
      if (to !== "*" && !ID_RX.test(to)) return { ok: false, err: "bad" };
      const w = JSON.stringify(q.w || {});
      if (w.length > 45000) return { ok: false, err: "big" };
      sheet(REPLIES, HEAD_Y).appendRow([String(q.rid || ""), to, new Date(), String(q.sum || "").slice(0, 500), w]);
      return { ok: true };
    }

    case "remove": { // 先生：生徒の提出と返信を消す
      if (!isTeacher(q)) return { ok: false, err: "auth" };
      [[REPORTS, HEAD_R, 0], [REPLIES, HEAD_Y, 1]].forEach(([n, h, col]) => {
        const sh = sheet(n, h), vals = sh.getDataRange().getValues();
        for (let i = vals.length - 1; i >= 1; i--) if (String(vals[i][col]) === String(q.id)) sh.deleteRow(i + 1);
      });
      return { ok: true };
    }
  }
  return { ok: false, err: "act" };
}
