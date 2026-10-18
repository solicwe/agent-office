import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, verify } from "../src/audit.js";
import { Flow, toolSummary } from "../src/flow.js";
import { loadAgents } from "../src/agents.js";
import { exportMarkdown, rounds } from "../src/report.js";
import { makeRound } from "./fixtures/round.js";

function run(payloads) {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-"));
  const audit = new AuditLog(path.join(dir, "logs"));
  const pool = loadAgents(".claude/agents");
  const events = [];
  const ended = [];
  const flow = new Flow({ audit, pool: () => pool, emit: (e) => events.push(e), onRoundEnd: (s) => ended.push(s) });
  for (const p of (typeof payloads === "function" ? payloads(dir) : payloads)) flow.handle(p);
  return { audit, events, ended };
}

test("a round becomes the visual story: think -> assign -> work -> hand back -> done", () => {
  const { events, ended } = run((dir) => makeRound(dir));
  assert.deepEqual(events.map((e) => e.type), ["SESSION_START", "ORCHESTRATOR_THINKING", "AGENT_ASSIGNED", "AGENT_WORKING", "AGENT_WORKING", "AGENT_DONE", "AGENT_HANDOFF", "TASK_COMPLETE"]);
  const assigned = events.find((e) => e.type === "AGENT_ASSIGNED");
  assert.deepEqual([assigned.from, assigned.to, assigned.subtask], ["orchestrator", "frontend", "แก้ปุ่มสั่งซื้อ"]);
  assert.equal(events.filter((e) => e.type === "AGENT_WORKING")[1].badge, "แก้ public/cart.html");
  assert.deepEqual(ended, ["sess-1"], "the round end triggers anchoring");
});

test("the audit log holds what the professor needs, and the chain verifies", () => {
  const { audit } = run((dir) => makeRound(dir));
  const e = audit.read("sess-1");
  assert.equal(verify(e).ok, true);
  const byType = (t) => e.find((x) => x.type === t);
  assert.equal(byType("user_prompt").prompt, "ปุ่มสั่งซื้อกดไม่ได้");
  const a = byType("agent_assigned");
  assert.equal(a.agent, "frontend");
  assert.equal(a.md_file, ".claude/agents/frontend.md");
  assert.match(a.md_sha256, /^[0-9a-f]{64}$/, "the exact .md version used");
  assert.match(a.reasoning, /ให้ Mia/, "why Claude chose this role, from its transcript");
  assert.equal(a.input, "ปุ่มใน cart.html ไม่ทำงาน แก้ให้กดได้");
  assert.equal(a.execution, "sequential");
  assert.equal(byType("agent_result").output, "แก้ onclick ใน cart.html แล้ว");
  assert.ok(byType("agent_result").duration_ms >= 0);
  assert.deepEqual(byType("agent_finished").tokens, { input: 700, output: 300, cache_read: 0, cache_write: 0, messages: 1, models: [], source: "transcript" });
  const f = byType("final_response");
  assert.equal(f.text, "แก้เรียบร้อย ปุ่มสั่งซื้อกดได้แล้ว");
  assert.equal(f.agent_count, 1);
  assert.deepEqual(f.tokens_orchestrator.input, 2700, "each message counted once, from the real transcript");
  assert.equal(f.tokens_round_total.input + f.tokens_round_total.output, 2700 + 120 + 1000);
});

test("two agents launched together are logged as parallel", () => {
  const { audit } = run((dir) => {
    const r = makeRound(dir, "sess-2");
    const second = { ...r[2], tool_use_id: "tu9", tool_input: { subagent_type: "backend", description: "เช็ค API", prompt: "x" } };
    return [r[0], r[1], r[2], second];
  });
  const assigned = audit.read("sess-2").filter((x) => x.type === "agent_assigned");
  assert.deepEqual(assigned.map((x) => x.execution), ["sequential", "parallel"]);
});

test("built-in subagents (Explore, Plan) go to the helper desk; unknown events are ignored", () => {
  const { events, audit } = run((dir) => {
    const r = makeRound(dir, "sess-3");
    return [r[1], { ...r[2], tool_input: { subagent_type: "Explore", description: "หาไฟล์", prompt: "x" } }, { hook_event_name: "Whatever", session_id: "sess-3" }, { hook_event_name: "Stop", session_id: "../bad" }];
  });
  assert.equal(events.find((e) => e.type === "AGENT_ASSIGNED").to, "helper");
  assert.equal(audit.read("sess-3").find((x) => x.type === "agent_assigned").built_in, true);
});

test("the Markdown report tells the story in order", () => {
  const { audit } = run((dir) => makeRound(dir));
  const e = audit.read("sess-1");
  assert.equal(rounds(e).length, 1);
  const md = exportMarkdown("sess-1", e);
  for (const part of ["ตรวจ hash chain: **ผ่าน**", "1. คำสั่งของผู้ใช้", "2. Orchestrator ตัดสินใจ", "frontend", ".claude/agents/frontend.md", "4. คำตอบสุดท้าย", "แก้เรียบร้อย"]) assert.ok(md.includes(part), part);
});

test("badges describe tool calls in a few words", () => {
  assert.equal(toolSummary("Bash", { command: "npm test" }), "รัน npm test");
  assert.equal(toolSummary("Read", { file_path: "C:\\a\\b\\c.js" }), "อ่าน b/c.js");
});
