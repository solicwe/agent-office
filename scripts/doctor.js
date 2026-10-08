// npm run doctor: is this machine ready to run Agent Office?
// Checks Node, the sandbox, folders, ports and each way of reaching Claude.
// It never spends tokens (the SWU check only lists models).
import path from "node:path";
import { nodeVersionOk, sandboxWorks, canWrite } from "../src/doctor.js";
import { portIsFree } from "../src/sandbox.js";
import { localClaudeInfo } from "../src/claude-code.js";
import { swuModels } from "../src/llm.js";

const rows = [];
let fatal = false;
const row = (ok, name, detail, isFatal = false) => {
  rows.push(`  ${ok === true ? "[ OK ]" : ok === false ? (isFatal ? "[FAIL]" : "[WARN]") : "[ -- ]"} ${name}${detail ? `: ${detail}` : ""}`);
  if (ok === false && isFatal) fatal = true;
};

row(nodeVersionOk(), "Node.js", `${process.version} (ต้องการ 22.13 ขึ้นไป)`, true);
if (nodeVersionOk()) {
  const sb = sandboxWorks();
  row(sb.ok, "Sandbox รันโค้ดของ AI", sb.detail, true);
}
const dataDir = path.resolve(process.env.DATA_DIR || "data");
const projectsDir = path.resolve(process.env.PROJECTS_DIR || "projects");
row(canWrite(dataDir), "เขียนโฟลเดอร์ data", dataDir, true);
row(canWrite(projectsDir), "เขียนโฟลเดอร์ projects", projectsDir, true);

const port = Number(process.env.PORT || 3000);
row(await portIsFree(port), `พอร์ต ${port}`, (await portIsFree(port)) ? "ว่าง" : "มีโปรแกรมอื่นใช้อยู่ (หรือ Agent Office เปิดอยู่แล้ว) ตั้ง PORT=xxxx เพื่อใช้พอร์ตอื่น");
const base = Number(process.env.APP_PORT_BASE || 4100);
let free = 0;
for (let p = base; p < base + 20; p++) if (await portIsFree(p)) free++;
row(free > 0, `พอร์ตสำหรับแอปที่ทีมสร้าง (${base}+)`, `ว่าง ${free}/20 พอร์ตแรก`);

// Ways to reach Claude: at least one is needed.
let providers = 0;
if (process.env.SWU_API_KEY) {
  try {
    const models = await swuModels(process.env.SWU_API_KEY);
    row(true, "SWU AI", `key ใช้ได้ โมเดล: ${models.map((m) => m.id).join(", ") || "-"}`);
    providers++;
  } catch (err) {
    row(false, "SWU AI", `key ใช้ไม่ได้หรือเชื่อมต่อไม่ได้ (${err.message})`);
  }
} else row(null, "SWU AI", "ไม่ได้ตั้ง SWU_API_KEY");
if (process.env.ANTHROPIC_API_KEY) { row(true, "Anthropic API key", "ตั้งไว้แล้ว (ไม่ได้ทดสอบเพื่อไม่ให้เสียโทเค็น)"); providers++; }
else row(null, "Anthropic API key", "ไม่ได้ตั้ง");
const local = await localClaudeInfo();
if (local.available) { row(true, "Claude Code ในเครื่อง", `${local.version} (ถ้ายังไม่ได้ล็อกอิน: พิมพ์ claude แล้ว /login)`); providers++; }
else row(null, "Claude Code ในเครื่อง", "ไม่พบ (ไม่จำเป็นถ้ามี key อื่น)");
row(providers > 0, "ช่องทางเชื่อม Claude", providers ? `พร้อม ${providers} ช่องทาง` : "ยังไม่มีเลย: ใส่ SWU_API_KEY หรือ ANTHROPIC_API_KEY ใน .env หรือติดตั้ง Claude Code", true);

console.log(`\n  Agent Office doctor\n\n${rows.join("\n")}\n\n  ${fatal ? "ยังไม่พร้อม: แก้รายการ [FAIL] ก่อน" : "พร้อมใช้งาน: npm start"}\n`);
process.exit(fatal ? 1 : 0);
