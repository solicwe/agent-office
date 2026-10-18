// Agent Office: a local window beside Claude Code. Claude Code posts its hook events
// here; the office animates them and every step goes into a hash-chained audit log.
// This server never calls an AI model and listens on this machine only.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";
import { loadAgents } from "./src/agents.js";
import { AuditLog, verify } from "./src/audit.js";
import { Flow } from "./src/flow.js";
import { Anchor } from "./src/anchor.js";
import { exportJson, exportMarkdown, rounds } from "./src/report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const WORKSPACE = path.resolve(process.env.WORKSPACE || here);
const AGENTS_DIR = path.resolve(process.env.AGENTS_DIR || path.join(WORKSPACE, ".claude", "agents"));
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(here, "logs"));
const ANCHOR = (process.env.AUDIT_ANCHOR || "github").toLowerCase(); // github | local | off

let pool = loadAgents(AGENTS_DIR);
const clients = new Set();
const recent = []; // last visual events, replayed to a window that opens mid-task
function broadcast(e) {
  const evt = { ...e, t: Date.now() };
  recent.push(evt);
  if (recent.length > 200) recent.shift();
  const chunk = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of clients) c.write(chunk);
}

// Teammates edit .md files while the office is open: reload and redraw.
try {
  let timer;
  watch(AGENTS_DIR, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { pool = loadAgents(AGENTS_DIR); broadcast({ type: "AGENTS_CHANGED", agents: pool.all, errors: pool.errors }); }, 200);
  });
} catch { /* folder appears later: the next request reloads */ }

const audit = new AuditLog(LOG_DIR);
const anchor = ANCHOR === "off" ? null : new Anchor({ repo: WORKSPACE, push: ANCHOR === "github" });
const flow = new Flow({
  audit,
  pool: () => pool,
  emit: broadcast,
  onRoundEnd: (sid) => {
    if (!anchor) return;
    const h = audit.head(sid);
    anchor.anchor({ session_id: sid, seq: h.seq, hash: h.hash }).then((r) => {
      audit.append(sid, "anchored", { anchored_seq: h.seq, anchored_hash: h.hash, ...r });
      broadcast({ type: "ANCHORED", session_id: sid, ...r });
    });
  },
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(here, "public")));

// Only this machine may post hooks or read logs, even if HOST is changed.
const local = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
app.use((req, res, next) => (local(req) ? next() : res.status(403).json({ error: "local only" })));

app.post("/hooks", (req, res) => {
  try { flow.handle(req.body || {}); } catch (err) { console.error("[hook]", err.message); }
  res.json({}); // empty output: Claude Code carries on as normal
});

app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "HELLO", agents: pool.all, errors: pool.errors, recent })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

app.get("/api/agents", (_req, res) => { pool = loadAgents(AGENTS_DIR); res.json({ dir: path.relative(WORKSPACE, AGENTS_DIR) || ".", agents: pool.all, errors: pool.errors }); });
app.get("/api/sessions", (_req, res) => res.json({ sessions: audit.sessions(), anchor: ANCHOR }));
app.get("/api/sessions/:id", (req, res) => {
  let entries;
  try { entries = audit.read(req.params.id); } catch { return res.status(400).json({ error: "bad id" }); }
  if (!entries.length) return res.status(404).json({ error: "ไม่พบ session" });
  res.json({ session_id: req.params.id, verification: verify(entries), rounds: rounds(entries), entries });
});
app.get("/api/sessions/:id/export.json", (req, res) => {
  let entries;
  try { entries = audit.read(req.params.id); } catch { return res.status(400).end(); }
  if (!entries.length) return res.status(404).end();
  res.set("Content-Disposition", `attachment; filename="audit-${req.params.id}.json"`).json(exportJson(req.params.id, entries));
});
app.get("/api/sessions/:id/export.md", (req, res) => {
  let entries;
  try { entries = audit.read(req.params.id); } catch { return res.status(400).end(); }
  if (!entries.length) return res.status(404).end();
  res.set({ "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="audit-${req.params.id}.md"` }).send(exportMarkdown(req.params.id, entries));
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Agent Office: http://localhost:${PORT}`);
  console.log(`  Roles from:   ${AGENTS_DIR} (${pool.agents.length} roles${pool.errors.length ? `, ${pool.errors.length} with errors` : ""})`);
  console.log(`  Audit logs:   ${LOG_DIR}`);
  console.log(`  Anchoring:    ${ANCHOR === "off" ? "off" : ANCHOR === "local" ? "local git branch audit-log" : "git branch audit-log, pushed to GitHub"}`);
  console.log("  Waiting for Claude Code hooks (.claude/settings.json)\n");
});
