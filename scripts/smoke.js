// End-to-end check on any OS: start the real server in a temporary workspace, post a
// whole Claude Code round of hooks, and confirm the log, its chain, the git anchor and
// both exports.  node scripts/smoke.js
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRound } from "../test/fixtures/round.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = await new Promise((r) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
const fail = (msg) => { console.error(`  [FAIL] ${msg}`); cleanup(); process.exit(1); };
const ok = (msg) => console.log(`  [ OK ] ${msg}`);

cpSync(path.join(root, ".claude", "agents"), path.join(dir, ".claude", "agents"), { recursive: true });
execFileSync("git", ["init", "-q", dir]);
execFileSync("git", ["-C", dir, "config", "user.email", "smoke@example.com"]);
execFileSync("git", ["-C", dir, "config", "user.name", "Smoke"]);

const server = spawn(process.execPath, [path.join(root, "server.js")], {
  env: { ...process.env, PORT: String(port), WORKSPACE: dir, LOG_DIR: path.join(dir, "logs"), AUDIT_ANCHOR: "local" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (d) => { logs += d; });
server.stderr.on("data", (d) => { logs += d; });
function cleanup() { server.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } }

console.log(`\nAgent Office smoke test · ${process.platform} · node ${process.version}`);
let up = false;
for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + "/api/agents")).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
if (!up) fail(`server did not start\n${logs}`);
ok("server started");

const { agents, errors } = await (await fetch(base + "/api/agents")).json();
if (errors.length || agents.length !== 9) fail(`roles: ${agents.length} loaded, errors ${JSON.stringify(errors)}`);
ok("7 roles + orchestrator + helper loaded from .md files");

const page = await (await fetch(base + "/")).text();
if (!page.includes("Agent Office") || !page.includes("office.js")) fail("page did not load");
ok("window page served");

for (const p of makeRound(dir, "smoke-1")) {
  const r = await fetch(base + "/hooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
  if (r.status !== 200) fail(`hook ${p.hook_event_name} -> ${r.status}`);
}
ok("a full round of hooks accepted");

let s;
for (let i = 0; i < 50; i++) {
  s = await (await fetch(base + "/api/sessions/smoke-1")).json();
  if (s.entries?.some((e) => e.type === "anchored")) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!s.verification?.ok) fail(`chain: ${JSON.stringify(s.verification)}`);
ok(`hash chain verifies (${s.entries.length} entries)`);
const step = s.rounds?.[0]?.steps?.[0];
if (step?.assigned.agent !== "frontend" || !step.assigned.md_sha256 || !step.result?.output) fail("round content missing");
ok("prompt, routing, .md used, output and final answer recorded");
const anchored = s.entries.find((e) => e.type === "anchored");
if (!anchored?.ok || !anchored.commit) fail(`anchor: ${JSON.stringify(anchored)}`);
const anchors = execFileSync("git", ["-C", dir, "show", "audit-log:anchors.jsonl"], { encoding: "utf8" });
if (!anchors.includes("smoke-1")) fail("anchor not in branch audit-log");
ok(`head anchored in git branch audit-log (${anchored.commit.slice(0, 10)})`);

const md = await (await fetch(base + "/api/sessions/smoke-1/export.md")).text();
const json = await (await fetch(base + "/api/sessions/smoke-1/export.json")).json();
if (!md.includes("Audit report") || json.verification?.ok !== true) fail("exports");
ok("export .md and .json");

cleanup();
console.log("  ทุกอย่างผ่าน\n");
process.exit(0);
