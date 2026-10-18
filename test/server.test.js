// The whole thing: a real server receives the hook payloads of a round, streams the
// visual events, keeps the log, anchors it, and exports it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeRound } from "./fixtures/round.js";

const PORT = await new Promise((resolve) => { const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
let dir, server;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "office-"));
  cpSync(".claude/agents", path.join(dir, ".claude", "agents"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), WORKSPACE: dir, LOG_DIR: path.join(dir, "logs"), AUDIT_ANCHOR: "local" },
    stdio: "pipe",
  });
  for (let i = 0; i < 200; i++) { // up to 20 s: the first start can be slow
    try { await fetch(BASE + "/api/agents"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
});
after(() => { server?.kill(); rmSync(dir, { recursive: true, force: true }); });

const post = (body) => fetch(BASE + "/hooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Read the event stream until `n` events (after HELLO) have arrived. */
async function events(n, during) {
  const res = await fetch(BASE + "/events");
  const reader = res.body.getReader();
  const out = [];
  let buf = "";
  const pump = (async () => {
    while (out.length < n + 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) out.push(JSON.parse(chunk.slice(6)));
      }
    }
    reader.cancel();
  })();
  await new Promise((r) => setTimeout(r, 100));
  await during();
  await Promise.race([pump, new Promise((r) => setTimeout(r, 5000))]);
  return out;
}

test("the office gets the roles, then the round as visual events", { timeout: 20_000 }, async () => {
  const round = makeRound(dir);
  const got = await events(9, async () => { for (const p of round) assert.equal((await post(p)).status, 200); });
  assert.equal(got[0].type, "HELLO");
  assert.deepEqual(got[0].agents.map((a) => a.id), ["orchestrator", "pm", "architect", "frontend", "backend", "qa", "debugger", "reviewer", "helper"]);
  const types = got.slice(1).map((e) => e.type);
  for (const t of ["ORCHESTRATOR_THINKING", "AGENT_ASSIGNED", "AGENT_WORKING", "AGENT_HANDOFF", "TASK_COMPLETE", "ANCHORED"]) assert.ok(types.includes(t), t);
  const anchored = got.find((e) => e.type === "ANCHORED");
  assert.equal(anchored.ok, true, JSON.stringify(anchored));
});

test("the session can be read, verified and exported", async () => {
  const { sessions } = await (await fetch(BASE + "/api/sessions")).json();
  assert.equal(sessions[0].session_id, "sess-1");
  assert.deepEqual(sessions[0].agents, ["frontend"]);
  const s = await (await fetch(BASE + "/api/sessions/sess-1")).json();
  assert.equal(s.verification.ok, true);
  assert.equal(s.rounds[0].steps[0].assigned.agent, "frontend");
  assert.ok(s.entries.some((e) => e.type === "anchored" && e.commit), "the anchor commit is in the log too");
  const j = await (await fetch(BASE + "/api/sessions/sess-1/export.json")).json();
  assert.equal(j.format, "agent-office-audit/1");
  assert.equal(j.verification.ok, true);
  const md = await (await fetch(BASE + "/api/sessions/sess-1/export.md")).text();
  assert.match(md, /Audit report: session sess-1/);
  assert.match(execFileSync("git", ["-C", dir, "show", "audit-log:anchors.jsonl"], { encoding: "utf8" }), /"session_id":"sess-1"/);
});

test("a friend's chat log can be imported over HTTP and is anchored like the rest", async () => {
  const text = '```team-log\n{"request":"ทำหน้า about","roles":[{"id":"frontend","why":"หน้าเว็บ","summary":"ทำแล้ว"}],"final":"เสร็จ"}\n```';
  const r = await (await fetch(BASE + "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, source: "Gemini", friend: "ปอย" }) })).json();
  assert.equal(r.rounds, 1);
  assert.equal(r.anchored.ok, true);
  const { sessions } = await (await fetch(BASE + "/api/sessions")).json();
  const s = sessions.find((x) => x.session_id === r.session_id);
  assert.deepEqual([s.imported, s.source, s.friend], [true, "Gemini", "ปอย"]);
  const bad = await fetch(BASE + "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "no log here" }) });
  assert.equal(bad.status, 422);
});

test("bad input is refused without breaking anything", async () => {
  assert.equal((await post({ hook_event_name: "Stop", session_id: "../../x" })).status, 200);
  assert.equal((await fetch(BASE + "/api/sessions/..%2F..%2Fx")).status, 400);
  assert.equal((await fetch(BASE + "/api/sessions/nope")).status, 404);
  assert.equal((await fetch(BASE + "/hooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" })).status >= 400, true);
});
