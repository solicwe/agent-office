// Check an audit log yourself:  npm run verify -- <export.json | logs/<id>.jsonl> [--repo <git folder>]
// 1. Recomputes every hash in the chain.
// 2. Compares the heads anchored in git (branch audit-log, anchors.jsonl) with the log:
//    an anchored hash must appear in the log at the same seq.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { verify } from "../src/audit.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : ".";
if (!file) {
  console.log("ใช้: npm run verify -- <audit-xxx.json หรือ logs/xxx.jsonl> [--repo <โฟลเดอร์ git>]");
  process.exit(2);
}

const text = readFileSync(file, "utf8");
const entries = file.endsWith(".json") ? JSON.parse(text).entries : text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sid = entries[0]?.session_id;
const v = verify(entries);
console.log(`\nsession ${sid} · ${entries.length} entries`);
console.log(v.ok ? `  [ OK ] hash chain ถูกต้อง · head ${v.head}` : `  [FAIL] ${v.reason}`);

let anchors = [];
for (const ref of ["audit-log", "origin/audit-log"]) {
  try {
    anchors = execFileSync("git", ["-C", repo, "show", `${ref}:anchors.jsonl`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.session_id === sid);
    break;
  } catch { /* try the next ref */ }
}
if (!anchors.length) console.log("  [ -- ] ไม่พบ hash ของ session นี้ใน branch audit-log (ยังไม่ได้ยึด หรือไม่ได้ fetch มา)");
let bad = 0;
for (const a of anchors) {
  const e = entries[a.seq];
  const match = e && e.hash === a.hash;
  if (!match) bad++;
  console.log(`  [${match ? " OK " : "FAIL"}] entry ${a.seq} ตรงกับ hash ที่ยึดไว้เมื่อ ${a.anchored_at}`);
}
console.log("");
process.exit(v.ok && !bad ? 0 : 1);
