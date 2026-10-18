// Importing a friend's plain-chat conversation (Gemini, ChatGPT...) used with TEAM_PROMPT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, verify } from "../src/audit.js";
import { loadAgents } from "../src/agents.js";
import { findLogBlocks, importChat } from "../src/importer.js";
import { rounds, exportMarkdown } from "../src/report.js";
import { buildShare } from "../scripts/export-team.js";

// What a friend copies out of Gemini: the pasted prompt (with its example block), two
// answers, one with the fence language lost by the chat app, plus an unrelated code block.
const CHAT = `${buildShare()["TEAM_PROMPT.md"]}

ปุ่มเข้าสู่ระบบกดไม่ได้

แผนทีม: ใช้ Max กับ Mia
### Max · Debugger
ชื่อฟังก์ชันไม่ตรง
\`\`\`js
console.log("not a log")
\`\`\`
### Final answer
แก้ onclick เป็น doLogin()
\`\`\`team-log
{"request": "แก้ปุ่มเข้าสู่ระบบที่กดไม่ได้", "order": "sequential", "roles": [{"id": "debugger", "why": "ปุ่มพัง", "task": "หาสาเหตุ", "summary": "onclick เรียก login() แต่ฟังก์ชันชื่อ doLogin()"}, {"id": "frontend", "why": "แก้ HTML", "task": "แก้ปุ่ม", "summary": "เปลี่ยนเป็น doLogin()"}], "final": "แก้ onclick ให้ตรงชื่อฟังก์ชัน"}
\`\`\`

ขอตรวจความปลอดภัยด้วย

\`\`\`json
{"request": "ตรวจความปลอดภัยของหน้า login", "roles": [{"id": "reviewer", "why": "เรื่อง login เสี่ยง", "summary": "ไม่พบปัญหา blocking"}], "final": "APPROVE"}
\`\`\`
\`\`\`team-log
{ this is not json
\`\`\`
`;

const fresh = () => ({ audit: new AuditLog(mkdtempSync(path.join(tmpdir(), "imp-"))), pool: () => loadAgents(".claude/agents") });

test("finds the team-log blocks, also when the chat app dropped the fence language", () => {
  const blocks = findLogBlocks(CHAT);
  assert.equal(blocks.filter((b) => b.request !== "the user's request in one sentence").length, 2);
});

test("an imported conversation becomes rounds, marked as imported and self-reported", () => {
  const { audit, pool } = fresh();
  const r = importChat(audit, pool, { text: CHAT, source: "Gemini", friend: "ต้น" });
  assert.equal(r.rounds, 2, "the example block inside the pasted prompt is not a round");
  assert.match(r.session_id, /^import-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  const e = audit.read(r.session_id);
  assert.equal(verify(e).ok, true);
  assert.ok(e.every((x) => x.imported === true && x.source === "Gemini"));
  const rs = rounds(e);
  assert.deepEqual(rs.map((x) => x.steps.map((s) => s.assigned.agent)), [["debugger", "frontend"], ["reviewer"]]);
  assert.equal(rs[0].steps[0].assigned.md_file, ".claude/agents/debugger.md");
  assert.equal(rs[0].steps[0].result.output, "onclick เรียก login() แต่ฟังก์ชันชื่อ doLogin()");
  assert.equal(rs[1].final.text, "APPROVE");
  assert.ok(e.find((x) => x.type === "import_raw").text.includes("ปุ่มเข้าสู่ระบบกดไม่ได้"), "the original text is kept");
  const md = exportMarkdown(r.session_id, e);
  assert.match(md, /นำเข้าจากแชท Gemini ของ ต้น/);
  assert.match(md, /รายงานเอง/);
});

test("a conversation without any team-log block is refused with what to do", () => {
  const { audit, pool } = fresh();
  assert.throws(() => importChat(audit, pool, { text: "สวัสดี ช่วยทำเว็บหน่อย" }), /ไม่พบบล็อก team-log/);
  assert.throws(() => importChat(audit, pool, { text: "   " }), /ไม่มีข้อความ/);
});

test("odd role ids are cleaned and unknown roles are kept as unknown, not trusted", () => {
  const { audit, pool } = fresh();
  const text = '```team-log\n{"request":"x","roles":[{"id":"../Hacker Role!","summary":"s"}],"final":"f"}\n```';
  const { session_id } = importChat(audit, pool, { text });
  const a = audit.read(session_id).find((x) => x.type === "agent_assigned");
  assert.equal(a.agent, "hackerrole");
  assert.equal(a.md_file, null);
});
