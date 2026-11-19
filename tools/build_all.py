"""specs/<id>.py から subjects/<id>.js を生成する。
- 問題IDは並び順の連番（prefix-s001 / prefix-x001）。記録が問題に紐づくので、問題は「末尾に追加」のみとし、途中への挿入・削除はしない。
"""
import importlib.util, json, random, itertools, sys, glob, os
from collections import Counter

import pathlib
ROOT = pathlib.Path(__file__).resolve().parent
OUT = str(ROOT.parent / "subjects")
TF_LEAD = "次の文のうち、適切なものを○、不適切なものを×とした場合の正しい組み合わせを一つ選びなさい。"
KANA = ["ア", "イ", "ウ", "エ", "オ"]
LAB = ["A", "B", "C", "D", "E"]

def pick(correct, pool, rng, prefer):
    pool = [p for p in pool if p != correct]
    rng.shuffle(pool)
    pool.sort(key=prefer)
    near = pool[:8]; rng.shuffle(near)
    return near[:4]

def build(path):
    spec = importlib.util.spec_from_file_location("s", path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    meta, p = m.META, m.META["prefix"]
    cats = {c["id"] for c in m.CATS}
    qs = []
    for n, (c, q, o, e) in enumerate(m.SIMPLE, 1):
        assert c in cats, (p, n, c); assert len(o) == 4 and len(set(o)) == 4, (p, n, o)
        qs.append(dict(id=f"{p}-s{n:03d}", c=c, q=q, o=o, a=0, e=e))
    positions = [i % 5 for i in range(len(m.EXAM))]
    random.Random(p).shuffle(positions)
    for n, item in enumerate(m.EXAM, 1):
        t, c = item[0], item[1]
        assert c in cats, (p, n, c)
        qid = f"{p}-x{n:03d}"
        rng = random.Random(qid)
        if t == "c5":
            _, _, q, o, a, e = item
            assert len(o) == 5 and len(set(o)) == 5
            qs.append(dict(id=qid, c=c, q=q, o=o, a=a, e=e, fixed=True)); continue
        extra, items = {}, []
        if t == "tf":
            _, _, head, sts, e = item
            q = TF_LEAD + (f"\n\n【{head}】" if head else "")
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
    subj = dict(id=meta["id"], name=meta["name"], icon=meta["icon"], examCount=meta["examCount"], categories=m.CATS, questions=qs)
    with open(f"{OUT}/{meta['id']}.js", "w") as f:
        f.write("registerSubject(" + json.dumps(subj, ensure_ascii=False, separators=(",", ":")) + ");\n")
    ex = sum(1 for q in qs if q.get("type") == "combo" or q.get("fixed"))
    print(f"{meta['name']:<10} 計{len(qs):>3}  一問一答{len(qs)-ex:>3}  本番{ex:>3}  分野{dict(Counter(q['c'] for q in qs))}")

if __name__ == "__main__":
    for f in sorted(glob.glob(str(ROOT / "specs" / "*.py"))):
        build(f)
