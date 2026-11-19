// 指導者ページのパスコードと、先生の返信に付ける署名の鍵を管理する。
//
// しくみ：署名用の鍵（ECDSA P-256）を作り、秘密鍵をパスコードごとに暗号化して teacher_keys.js に置く。
//   - 指導者ページは、パスコードで秘密鍵を取り出せたときだけ開く
//   - 先生の返信コードはこの秘密鍵で署名し、生徒のアプリは公開鍵で確かめる（生徒が返信を自作しても通らない）
//   - パスコードそのものはどこにも保存しない（リポジトリにあるのは暗号化した鍵だけ）
//
// 使い方（リポジトリの直下で）:
//   node tools/teacher_keys.mjs new <名前>                 鍵を作り直し、最初のパスコードを発行（それまでのパスコードはすべて無効）
//   node tools/teacher_keys.mjs add <名前>                 パスコードを追加（環境変数 PASS に今あるパスコードのどれかを入れる）
//   node tools/teacher_keys.mjs remove <名前>              そのパスコードを無効にする
//   node tools/teacher_keys.mjs list                       パスコードの一覧（名前だけ）
// パスコードを指定したいときは、環境変数 NEWPASS に入れる（8文字以上）。指定しなければ自動で作る。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const { subtle } = globalThis.crypto;
const getRandomValues = a => globalThis.crypto.getRandomValues(a);
const FILE = new URL("../teacher_keys.js", import.meta.url);
const ITER = 210000;
const b64u = b => Buffer.from(b).toString("base64url");
const unb64u = s => new Uint8Array(Buffer.from(s, "base64url"));
const enc = new TextEncoder();
const norm = p => String(p).normalize("NFKC").replace(/[\s-]/g, "").toLowerCase(); // 空白・ハイフン・全角半角・大文字小文字の違いを無視

function load() {
  if (!existsSync(FILE)) return null;
  const m = readFileSync(FILE, "utf8").match(/window\.TEACHER_KEYS\s*=\s*(\{[\s\S]*\});/);
  return m ? JSON.parse(m[1]) : null;
}
function save(k) {
  writeFileSync(FILE, `// 指導者ページの鍵（tools/teacher_keys.mjs で生成。手で編集しない）\n// 秘密鍵はパスコードで暗号化してあり、パスコードそのものは含まれていません。\nwindow.TEACHER_KEYS = ${JSON.stringify(k, null, 1)};\n`);
}
async function wrapKey(pass) {
  const salt = getRandomValues(new Uint8Array(16));
  const base = await subtle.importKey("raw", enc.encode(norm(pass)), "PBKDF2", false, ["deriveKey"]);
  return { salt, key: await subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
}
async function lockFor(label, pass, pkcs8) {
  const { salt, key } = await wrapKey(pass);
  const iv = getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, pkcs8));
  return { label, it: ITER, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
}
async function unlock(k, pass) {
  for (const L of k.locks) {
    const base = await subtle.importKey("raw", enc.encode(norm(pass)), "PBKDF2", false, ["deriveKey"]);
    const key = await subtle.deriveKey({ name: "PBKDF2", salt: unb64u(L.salt), iterations: L.it, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    try { return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64u(L.iv) }, key, unb64u(L.ct))); } catch (e) {}
  }
  return null;
}
function newPass() {
  if (process.env.NEWPASS) { if (norm(process.env.NEWPASS).length < 8) throw new Error("NEWPASS は8文字以上にしてください"); return process.env.NEWPASS; }
  const A = "abcdefghjkmnpqrstuvwxyz23456789"; // 見まちがえやすい文字（i l o 0 1）を除く
  const r = getRandomValues(new Uint8Array(12));
  const s = Array.from(r, x => A[x % A.length]).join("");
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8);
}

const [cmd, label] = process.argv.slice(2);
if (cmd === "new") {
  if (!label) throw new Error("名前を指定してください");
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
  const pub = b64u(new Uint8Array(await subtle.exportKey("spki", kp.publicKey)));
  const pass = newPass();
  save({ v: 1, kid: b64u(getRandomValues(new Uint8Array(6))), pub, locks: [await lockFor(label, pass, pkcs8)] });
  console.log(`新しい鍵を作りました。「${label}」のパスコード: ${pass}`);
} else if (cmd === "add") {
  const k = load(); if (!k) throw new Error("先に new で鍵を作ってください");
  if (!label) throw new Error("名前を指定してください");
  if (k.locks.some(L => L.label === label)) throw new Error("同じ名前のパスコードがあります");
  const pkcs8 = await unlock(k, process.env.PASS || "");
  if (!pkcs8) throw new Error("PASS のパスコードで鍵を開けられませんでした");
  const pass = newPass();
  k.locks.push(await lockFor(label, pass, pkcs8));
  save(k);
  console.log(`「${label}」のパスコードを追加しました: ${pass}`);
} else if (cmd === "remove") {
  const k = load(); if (!k) throw new Error("鍵がありません");
  const n = k.locks.length;
  k.locks = k.locks.filter(L => L.label !== label);
  if (k.locks.length === n) throw new Error("その名前のパスコードはありません");
  if (!k.locks.length) throw new Error("最後のパスコードは消せません（new で作り直してください）");
  save(k);
  console.log(`「${label}」のパスコードを無効にしました。残り: ${k.locks.map(L => L.label).join("、")}`);
} else if (cmd === "list") {
  const k = load(); console.log(k ? k.locks.map(L => L.label).join("\n") : "鍵がありません");
} else {
  console.log("使い方は tools/teacher_keys.mjs の先頭を見てください");
}
