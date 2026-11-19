"""specs/<名前>.py（＋ specs_more/<名前>.py）から ../subjects/<科目ID>.js を生成する。

- 問題IDは並び順の連番（prefix-s001 / prefix-x001）。学習記録が問題IDに紐づくため、
  問題は specs → specs_more の順で「末尾に追加」のみとし、途中への挿入・削除・並べ替えはしない。
- META に base があれば、そのJSON（既存の問題）を先頭に置く（教育原理）。
"""
import importlib.util, json, random, itertools, glob, os, pathlib, re
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "subjects"
TF_LEAD = "次の文のうち、適切なものを○、不適切なものを×とした場合の正しい組み合わせを一つ選びなさい。"
KANA = ["ア", "イ", "ウ", "エ", "オ"]
LAB = ["A", "B", "C", "D", "E"]

def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def pick(correct, pool, rng, prefer):
    pool = [p for p in pool if p != correct]
    rng.shuffle(pool)
    pool.sort(key=prefer)
    near = pool[:8]; rng.shuffle(near)
    return near[:4]

def build(path):
    m = load(path)
    simple, exam = list(m.SIMPLE), list(m.EXAM)
    more = ROOT / "specs_more" / path.name
    if more.exists():
        mm = load(more); simple += list(getattr(mm, "SIMPLE", [])); exam += list(getattr(mm, "EXAM", []))
    meta, p = m.META, m.META["prefix"]
    cats = {c["id"] for c in m.CATS}
    qs = []
    if meta.get("base"):
        qs += json.loads((ROOT / meta["base"]).read_text())
    for n, (c, q, o, e) in enumerate(simple, 1):
        assert c in cats, (p, n, c); assert len(o) == 4 and len(set(o)) == 4, (p, n, o)
        qs.append(dict(id=f"{p}-s{n:03d}", c=c, q=q, o=o, a=0, e=e))
    positions = [i % 5 for i in range(len(exam))]
    random.Random(p).shuffle(positions)
    for n, item in enumerate(exam, 1):
        t, c = item[0], item[1]
        assert c in cats, (p, n, c)
        qid = f"{p}-x{n:03d}"
        rng = random.Random(qid)
        if t == "c5":
            _, _, q, o, a, e = item
            assert len(o) == 5 and len(set(o)) == 5, qid
            qs.append(dict(id=qid, c=c, q=q, o=o, a=a, e=e, fixed=True)); continue
        if t == "multi":  # 5つの選択肢から正しいものを2〜3つ選ぶ（2024年後期からの形式）
            _, _, q, opts, e = item
            assert len(opts) == 5, qid
            opts = list(opts); rng.shuffle(opts)
            ans = [i for i, (_, ok) in enumerate(opts) if ok]
            assert 2 <= len(ans) <= 3, (qid, len(ans))
            word = "適切なもの" if "不適切" not in q else "不適切なもの"
            qs.append(dict(id=qid, c=c, type="multi", q=q.replace("{n}", str(len(ans))), o=[s for s, _ in opts], a=ans, e=e)); continue
        extra, items = {}, []
        if t == "tf":
            _, _, head, sts, e = item
            q = TF_LEAD + (f"\n\n【{head}】" if head else "")
            corr = tuple("○" if b else "×" for _, b in sts)
            pool = list(itertools.product("○×", repeat=len(sts)))
            dist = lambda x: sum(a != b for a, b in zip(x, corr))
            ds = pick(corr, pool, rng, lambda x: abs(dist(x) - 1.5))
            items = [f"{LAB[i]}　{s}" for i, (s, _) in enumerate(sts)]
        elif t == "case":  # 事例＋○×組合せ
            _, _, case, head, sts, e = item
            q = f"次の【事例】を読んで、{head}として、適切なものを○、不適切なものを×とした場合の正しい組み合わせを一つ選びなさい。\n\n【事例】\n{case}"
            corr = tuple("○" if b else "×" for _, b in sts)
            pool = list(itertools.product("○×", repeat=len(sts)))
            dist = lambda x: sum(a != b for a, b in zip(x, corr))
            ds = pick(corr, pool, rng, lambda x: abs(dist(x) - 1.5))
            items = [f"{LAB[i]}　{s}" for i, (s, _) in enumerate(sts)]
        elif t == "match":
            _, _, q, left, right, ans, e = item
            assert sorted(ans) == list(range(len(right))), (qid, ans)
            corr = tuple(KANA[i] for i in ans)
            pool = list(itertools.permutations(KANA[:len(right)]))
            dist = lambda x: sum(a != b for a, b in zip(x, corr))
            ds = pick(corr, pool, rng, dist)
            items = [f"{LAB[i]}　{s}" for i, s in enumerate(left)]
            extra["pool"] = [f"{KANA[i]}　{s}" for i, s in enumerate(right)]
        elif t == "blank":
            _, _, q, ans, alts, e = item
            corr = tuple(ans)
            pool = list(itertools.product(*[[a] + al for a, al in zip(ans, alts)]))
            dist = lambda x: sum(a != b for a, b in zip(x, corr))
            ds = pick(corr, pool, rng, dist)
        else:
            raise ValueError(t)
        a = positions[n - 1]
        opts = [list(d) for d in ds]; opts.insert(a, list(corr))
        assert len(opts) == 5 and len({tuple(o) for o in opts}) == 5, qid
        d = dict(id=qid, c=c, type="combo", q=q, cols=LAB[:len(corr)], o=opts, a=a, e=e)
        if items: d["items"] = items
        d.update(extra); qs.append(d)
    ids = [q["id"] for q in qs]; assert len(ids) == len(set(ids)), "duplicate id"
    cats_out = [dict(c) for c in m.CATS]
    notes_file = ROOT / "notes" / path.name  # 分野ごとの要点（復習用の学習内容）
    if notes_file.exists():
        notes = load(notes_file).NOTES
        assert set(notes) <= cats, (p, set(notes) - cats)
        for c in cats_out:
            if notes.get(c["id"]): c["note"] = list(notes[c["id"]])
    subj = dict(id=meta["id"], name=meta["name"], icon=meta["icon"], examCount=meta["examCount"], categories=cats_out, questions=qs)
    themes_file = ROOT / "themes" / path.name  # 頻出テーマ（キーワードで問題を割り当てる）
    if themes_file.exists():
        out = []
        for tid, tname, pat, rank, cnt, refs in load(themes_file).THEMES:
            rx = re.compile(pat)
            def text(q):
                parts = [q["q"]] + q.get("items", []) + q.get("pool", [])  # 解説は含めない（主題で判定）
                if q.get("type") != "combo": parts += q["o"]
                else: parts += ["".join(o) for o in q["o"]]
                return "\n".join(parts)
            ids = [q["id"] for q in qs if rx.search(text(q))]
            out.append(dict(id=tid, name=tname, rank=rank, exam=cnt, refs=refs, qs=ids))
        subj["themes"] = out
    (OUT / f"{meta['id']}.js").write_text("registerSubject(" + json.dumps(subj, ensure_ascii=False, separators=(",", ":")) + ");\n")
    kinds = Counter("一問一答" if not (q.get("type") or q.get("fixed")) else {"combo": "組合せ", "multi": "複数選択"}.get(q.get("type"), "5択") for q in qs)
    print(f"{meta['name']:<9} 計{len(qs):>4}  {dict(kinds)}")

if __name__ == "__main__":
    for f in sorted(glob.glob(str(ROOT / "specs" / "*.py"))):
        build(pathlib.Path(f))
