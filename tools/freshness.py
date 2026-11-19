"""制度情報の鮮度管理（作る側の道具）。

subjects/*.js を読み、数値・調査・制度改正にかかわる問題を一覧にして tools/freshness_report.md に書き出す。
- 「根拠」（tools/asof.py）が未設定のもの
- 調査・統計の根拠で、年が古いもの（今年から2年以上前）
を「点検」として上に並べる。新しい調査結果や制度改正が出たら、この一覧を見て問題と根拠を直す。
使い方: python3 tools/freshness.py
"""
import json, re, pathlib, datetime, importlib.util
ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("asof", ROOT / "asof.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ASOF = m.ASOF
RX = re.compile(r"待機児童|調査|統計|表示義務|特定原材料|推奨表示|令和[0-9]+年|20[2-9][0-9]年|第[一二三四五]次|過去最|推移|件数|合計特殊出生率|委託率|出生数|配置基準|定期接種|食事摂取基準")
THIS = datetime.date.today().year
rows = []
for f in sorted((ROOT.parent / "subjects").glob("*.js")):
    data = json.loads(f.read_text()[len("registerSubject("):-3])
    for q in data["questions"]:
        text = " ".join([q["q"], *q.get("items", []), q["e"]])
        if "架空" in text or not RX.search(text):
            continue
        years = sorted({int(y) for y in re.findall(r"(20[0-9]{2})年", text)})
        asof = ASOF.get(q["id"])
        ay = max([int(y) for y in re.findall(r"(20[0-9]{2})", asof or "")] or [0])
        stat = bool(re.search(r"調査|統計|時点|件数|取りまとめ", asof or ""))  # 調査・統計の数値は毎年変わる。制度改正は年が古くても有効
        flag = "未設定" if not asof else ("古い？" if stat and ay and ay <= THIS - 2 else "")
        rows.append((flag, data["name"], q["id"], asof or "", years, q["q"].split("\n")[0][:60]))
rows.sort(key=lambda r: ({"未設定": 0, "古い？": 1, "": 2}[r[0]], r[1], r[2]))
out = [f"# 制度情報の点検一覧（{datetime.date.today().isoformat()} 生成）", "",
       "数値・調査・制度改正にかかわる問題。根拠は `tools/asof.py` に書く（アプリの解説の下に表示）。", "",
       f"- 対象 {len(rows)}問／根拠あり {sum(1 for r in rows if r[3])}問／未設定 {sum(1 for r in rows if r[0] == '未設定')}問／古い？ {sum(1 for r in rows if r[0] == '古い？')}問", "",
       "| 点検 | 科目 | ID | 根拠 | 本文中の年 | 問題（冒頭） |", "|---|---|---|---|---|---|"]
for flag, name, qid, asof, years, head in rows:
    out.append(f"| {flag or '✓'} | {name} | {qid} | {asof} | {'・'.join(map(str, years))} | {head.replace('|', '／')} |")
(ROOT / "freshness_report.md").write_text("\n".join(out) + "\n")
print(f"tools/freshness_report.md に {len(rows)}問を書き出しました（未設定 {sum(1 for r in rows if r[0] == '未設定')}）")
