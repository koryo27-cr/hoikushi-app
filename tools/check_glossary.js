// 用語集の年と、問題・解説の中の「名称（○○年）」「名称は○○年」などの年が食い違っていないかを確かめる
// 使い方: node tools/check_glossary.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
global.window = {}; global.SUBJECTS = []; global.registerSubject = s => SUBJECTS.push(s);
eval(fs.readFileSync(path.join(root, "glossary.js"), "utf8"));
for (const f of fs.readdirSync(path.join(root, "subjects"))) eval(fs.readFileSync(path.join(root, "subjects", f), "utf8"));
const qs = SUBJECTS.flatMap(s => s.questions);
let warn = 0, hit = 0;
for (const g of window.GLOSSARY) {
  if (!g.yr) continue;
  const key = g.n.replace(/（.*?）/g, "").replace(/・.*$/, "");
  const years = new Set(String(g.y || "").match(/\d{4}/g) || []);
  for (const q of qs) {
    const t = [q.q, ...(q.items || []), ...(q.pool || []), ...(Array.isArray(q.o) ? q.o.flat() : []), q.e].join(" ");
    let i = t.indexOf(key);
    while (i >= 0) {
      const win = t.slice(i, i + key.length + 14);
      const m = win.slice(key.length).match(/^[^。、]{0,8}?(\d{4})年/);
      if (m) { hit++; if (!years.has(m[1])) { warn++; console.log(`要確認 ${g.n}（用語集 ${g.y}） ⇔ ${q.id}: …${win}…`); } }
      i = t.indexOf(key, i + 1);
    }
  }
}
console.log(`照合 ${hit}か所・要確認 ${warn}か所`);
