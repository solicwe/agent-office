import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runJob } from "./src/orchestrator.js";
import { ClaudeLLM, SwuLLM, swuModels, SWU_BASE_URL, MODELS, EFFORTS, DEFAULT_MODEL, serverHasKey } from "./src/llm.js";
import { LocalClaudeLLM, localClaudeInfo } from "./src/claude-code.js";
import * as usage from "./src/usage.js";
import * as access from "./src/access.js";
import { ensureApp, restartApp, stopApp, stopAll } from "./src/apprunner.js";
import { startupProblems } from "./src/doctor.js";
import * as tunnel from "./src/tunnel.js";
import { FallbackLLM } from "./src/fallback.js";
import { safePath, zip } from "./src/workspace.js";
import { PROJECTS_DIR, createProject, writeProjectFile, readMeta, loadProjectFiles, listProjects, isSlug, projectExists, appendJobEvents, readJobEvents, recordJob, deleteProject, setMember, canAccess, isProjectOwner } from "./src/projects.js";
import { offlineStep, BRIEF_SCHEMA, BRIEF_SYSTEM, briefPrompt } from "./src/brief.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const MAX_RUNNING = Number(process.env.MAX_RUNNING_JOBS || 3);
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

// Refuse to start on a machine that can't run the team safely, and say why.
const problems = startupProblems({ dataDir: path.resolve(process.env.DATA_DIR || "data"), projectsDir: PROJECTS_DIR });
if (problems.length) {
  console.error(`\n  Agent Office เปิดไม่ได้:\n${problems.map((p) => `  - ${p}`).join("\n")}\n  ตรวจทั้งหมดได้ด้วย: npm run doctor\n`);
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(here, "public")));

/** @type {Map<string, {events: object[], clients: Set<import('express').Response>, done: boolean, abort: AbortController, slug: string, owner: string, writes: Promise<void>}>} */
const jobs = new Map();
const running = () => [...jobs.values()].filter((j) => !j.done).length;

/** Addresses other people can open: PUBLIC_URL, the outside-link tunnel, then this machine's LAN address. */
function shareBases() {
  if (PUBLIC_URL) return [PUBLIC_URL];
  const out = tunnel.mainPublicUrl() ? [tunnel.mainPublicUrl()] : [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

// ---------- access: owner on this machine, friends via invite links ----------
app.get("/i/:code", (req, res) => {
  const inv = access.findInvite(req.params.code);
  if (!inv) return res.status(404).type("text/plain; charset=utf-8").send("ลิงก์เชิญนี้ใช้ไม่ได้แล้ว ขอลิงก์ใหม่จากเจ้าของ");
  res.cookie(access.COOKIE, inv.code, { httpOnly: true, sameSite: "lax", maxAge: 90 * 24 * 3600 * 1000 });
  // ?p=<project> opens that shared project straight away.
  const p = typeof req.query.p === "string" && isSlug(req.query.p) ? req.query.p : "";
  res.redirect(p ? `/#p=${encodeURIComponent(p)}` : "/");
});

// Owner sign-in: start.bat / start.command open /owner?token=... from data/owner-token.txt.
const OWNER_COOKIE_OPTS = { httpOnly: true, sameSite: "strict", maxAge: 365 * 24 * 3600 * 1000 };
app.get("/owner", (req, res) => {
  if (!access.isOwnerToken(req.query.token)) return res.status(403).type("text/plain; charset=utf-8").send("รหัสเจ้าของไม่ถูกต้อง");
  res.cookie(access.OWNER_COOKIE, access.ownerToken, OWNER_COOKIE_OPTS);
  res.redirect("/");
});

// Block cross-site writes: a page from another origin (for example an app the team
// built, running on another port) must not be able to act on Agent Office.
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  let crossSite = Boolean(site) && !["same-origin", "none"].includes(site);
  if (!crossSite && origin) {
    try { crossSite = origin === "null" || new URL(origin).host !== req.headers.host; } catch { crossSite = true; }
  }
  if (crossSite) return res.status(403).json({ error: "คำขอจากเว็บอื่นถูกปฏิเสธ" });
  next();
});

app.post("/api/owner-login", (req, res) => {
  if (!access.isOwnerToken(req.body?.token)) return res.status(403).json({ error: "รหัสเจ้าของไม่ถูกต้อง" });
  res.cookie(access.OWNER_COOKIE, access.ownerToken, OWNER_COOKIE_OPTS);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  req.user = access.identify(req);
  if (req.user.role === "none" && req.path !== "/config") return res.status(401).json({ error: "ต้องเปิดผ่านลิงก์เชิญ หรือเข้าสู่ระบบเจ้าของเครื่อง" });
  next();
});
const ownerOnly = (req, res, next) => (req.user.role === "owner" ? next() : res.status(403).json({ error: "เฉพาะเจ้าของเครื่อง" }));

/**
 * Token usage as this user sees it: the owner sees everything used since the last
 * reset; a friend sees what they used and whether their quota is gone.
 */
function budgetFor(user) {
  const g = usage.snapshot();
  if (user.role !== "guest") {
    const learned = { roundLimit: g.roundLimit, periodMs: g.periodMs, nextResetAt: g.nextResetAt, roundsSeen: g.roundsSeen };
    return { used: g.used, exhausted: g.exhausted, since: g.since, lastReset: g.lastReset, ...learned, ...(user.role === "owner" ? { rounds: g.rounds } : {}) };
  }
  const inv = user.invite;
  return { used: inv.used, limit: inv.limit, exhausted: g.exhausted || access.inviteRemaining(inv) <= 0, since: inv.createdAt };
}
const isOut = (user) => user.role === "guest" && access.inviteRemaining(user.invite) <= 0;
function charge(user, input, output) {
  usage.addUsage(input, output);
  if (user.role === "guest") access.chargeInvite(user.invite.code, (input || 0) + (output || 0));
  return budgetFor(user);
}
const hasFriendKey = () => serverHasKey() || Boolean(process.env.SWU_API_KEY);

/** Tag "out of tokens" errors so a job stops cleanly and the counter shows หมด. */
function watchQuota(llm) {
  const call = llm.call.bind(llm);
  llm.call = async (opts) => {
    try {
      return await call(opts);
    } catch (err) {
      if (usage.isQuotaError(err)) {
        usage.markExhausted();
        throw Object.assign(err, { quota: true, transient: false });
      }
      throw err;
    }
  };
  return llm;
}

async function canAccessProject(user, slug) {
  if (user.role === "owner") return true;
  return canAccess(user, await readMeta(slug));
}

app.get("/api/config", async (req, res) => {
  const local = await localClaudeInfo();
  const user = req.user;
  res.json({
    role: user.role,
    onThisMachine: access.isLoopback(req),
    userId: user.id || "",
    userName: user.name || "",
    serverHasKey: serverHasKey() || Boolean(process.env.SWU_API_KEY),
    swu: { serverKey: user.role === "owner" && Boolean(process.env.SWU_API_KEY), model: process.env.SWU_MODEL || "anthropic/claude-sonnet-5.5" },
    localClaude: user.role === "owner" ? { available: local.available, version: local.version } : { available: false },
    models: MODELS.map(({ id, label, effort }) => ({ id, label, effort })),
    efforts: EFFORTS,
    defaultModel: DEFAULT_MODEL,
    projectsDir: user.role === "owner" ? PROJECTS_DIR : "",
    shareBases: shareBases(),
    usage: user.role === "none" ? null : budgetFor(user),
  });
});

app.get("/api/usage", (req, res) => res.json(budgetFor(req.user)));
app.post("/api/usage/reset", ownerOnly, (req, res) => { usage.resetCount("manual"); res.json(budgetFor(req.user)); });

app.get("/api/invites", ownerOnly, (_req, res) => res.json({ invites: access.listInvites(), shareBases: shareBases(), serverHasKey: hasFriendKey() }));
app.post("/api/invites", ownerOnly, async (req, res) => {
  const inv = access.createInvite(req.body || {});
  // Invited from inside a project: the friend lands in that project and can work on it.
  const slug = typeof req.body?.project === "string" && isSlug(req.body.project) && projectExists(req.body.project) ? req.body.project : null;
  if (slug) await setMember(slug, `guest:${inv.code}`, true);
  res.json({ ...inv, project: slug });
});
app.delete("/api/invites/:code", ownerOnly, (req, res) => { access.revokeInvite(req.params.code); res.json({ ok: true }); });
app.post("/api/swu/models", ownerOnly, async (req, res) => {
  try {
    res.json({ base: SWU_BASE_URL, models: await swuModels(String(req.body?.swuKey || "").trim() || process.env.SWU_API_KEY || "") });
  } catch (err) {
    res.status(502).json({ error: `ดึงรายชื่อโมเดลจาก SWU AI ไม่ได้: ${err.message}` });
  }
});
app.post("/api/server-key", ownerOnly, (req, res) => { access.setServerKey(req.body?.apiKey); res.json({ serverHasKey: serverHasKey() }); });

// ---------- outside link (Cloudflare quick tunnel) ----------
/** True when the request came in through a tunnel or proxy rather than straight to this machine. */
const viaTunnel = (req) => Boolean(req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["forwarded"]);
const tunnelInfo = () => ({ main: tunnel.tunnelStatus("main"), available: Boolean(tunnel.findCloudflared()), hint: tunnel.INSTALL_HINT, fixed: PUBLIC_URL || null, shareBases: shareBases() });
app.get("/api/tunnel", ownerOnly, (_req, res) => res.json(tunnelInfo()));
app.post("/api/tunnel", ownerOnly, async (req, res) => {
  if (req.body?.on === false) {
    tunnel.stopTunnel("main");
    return res.json(tunnelInfo());
  }
  const r = await tunnel.startTunnel("main", PORT);
  res.status(r.url ? 200 : 502).json({ ...tunnelInfo(), error: r.url ? null : r.error });
});

/** The app's own public https link (its own tunnel), started on demand. */
async function appPublicUrl(slug, state, start) {
  if (!state?.running) return null;
  const t = tunnel.tunnelStatus(slug);
  if (t.url && t.port === state.port && !t.error) return t.url;
  if (!start) return null;
  const r = await tunnel.startTunnel(slug, state.port);
  return r.url || null;
}

/**
 * How to reach Claude. The owner may use the Claude Code login on this machine
 * ("local") or an API key. Friends go through the owner's server key (a personal
 * Claude login is for its owner only and must not be shared), and may add their
 * own key, which takes over when the owner's tokens or their share run out.
 * Returns an LLM whose quota errors are already flagged.
 */
async function makeLLM(body, user) {
  const s = body.settings || {};
  if (user.role === "guest") {
    const own = ownLLM(body);
    const ownFirst = Boolean(own && body.ownFirst);
    // The owner's team API on the server: SWU AI first, else the Anthropic key.
    const server = ownFirst ? null
      : process.env.SWU_API_KEY ? new SwuLLM({ token: process.env.SWU_API_KEY })
      : serverHasKey() ? new ClaudeLLM({ model: s.model, effort: s.effort }) : null;
    if (!server && !own) throw httpError(400, "เจ้าของเครื่องยังไม่ได้ตั้ง API key สำหรับเพื่อน ใส่ API key ของคุณเองในหน้าตั้งค่าแทนได้");
    if (!own && isOut(user)) throw httpError(402, "โควตาโทเค็นที่เจ้าของให้หมดแล้ว ใส่ API key ของคุณเองในหน้าตั้งค่า แล้วทำต่อได้เลย");
    return new FallbackLLM({
      primary: server && !isOut(user) ? watchQuota(server) : null,
      fallback: own,
      primaryOut: () => isOut(user),
      isQuota: (err) => Boolean(err?.quota) || usage.isQuotaError(err),
    });
  }
  return watchQuota(await ownerLLM(body, s));
}

/** A friend's own key from their settings: { kind: "swu" | "api", key, model }. */
function ownLLM(body) {
  const o = body.ownKey && typeof body.ownKey === "object" ? body.ownKey : null;
  const key = typeof o?.key === "string" ? o.key.trim() : "";
  if (!key || key.length > 500) return null;
  const s = body.settings || {};
  if (o.kind === "swu") return new SwuLLM({ token: key, model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : process.env.SWU_MODEL || undefined });
  if (o.kind === "api") return new ClaudeLLM({ apiKey: key, model: s.model, effort: s.effort });
  return null;
}

async function ownerLLM(body, s) {
  if (s.provider === "swu") {
    const token = (typeof body.swuKey === "string" && body.swuKey.trim()) || process.env.SWU_API_KEY || "";
    if (!token) throw httpError(400, "ยังไม่ได้ใส่ SWU API key ในหน้าตั้งค่า");
    return new SwuLLM({ token, model: s.swuModel });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const local = await localClaudeInfo();
  const provider = s.provider === "api" || (!local.available && s.provider !== "local") ? "api" : "local";
  if (provider === "local") {
    if (!local.available) throw httpError(400, "ไม่พบ Claude Code ในเครื่องนี้ ติดตั้งด้วย npm i -g @anthropic-ai/claude-code แล้วล็อกอิน หรือเปลี่ยนไปใช้ API key ในหน้าตั้งค่า");
    return new LocalClaudeLLM({ model: s.model || DEFAULT_MODEL, effort: s.effort });
  }
  if (!apiKey && !serverHasKey()) throw httpError(400, "ยังไม่ได้เชื่อม Claude: ใส่ API key ในหน้าตั้งค่า หรือเลือกใช้ Claude ในเครื่องนี้");
  return new ClaudeLLM({ apiKey: apiKey || undefined, model: s.model, effort: s.effort });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- brief assistant: one interview step per call ----------
app.post("/api/brief", async (req, res) => {
  const body = req.body || {};
  const idea = String(body.idea || "").slice(0, 2000);
  const answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 10).map((a) => ({ question: String(a?.question || "").slice(0, 500), answer: String(a?.answer || "").slice(0, 2000) }));
  const finish = Boolean(body.finish);
  // Inside a project the interview is about changing that project, not starting over.
  const project = body.projectSlug && projectExists(body.projectSlug) && (await canAccessProject(req.user, body.projectSlug))
    ? await projectContext(body.projectSlug) : null;
  if (isOut(req.user) && !ownLLM(body)) return res.json({ ...offlineStep(idea, answers, finish, project), mode: "offline", warning: "โควตาโทเค็นของคุณหมดแล้ว" });
  try {
    const llm = await makeLLM(body, req.user);
    const { data, usage: u } = await llm.json({ system: BRIEF_SYSTEM, prompt: briefPrompt(idea, answers, finish, project), schema: BRIEF_SCHEMA });
    res.json({ ...data, options: (data.options || []).slice(0, 8), mode: "claude", followUp: Boolean(project), usage: u.own ? budgetFor(req.user) : charge(req.user, u.input, u.output) });
  } catch (err) {
    console.error("[brief]", err.message);
    res.json({ ...offlineStep(idea, answers, finish, project), mode: "offline", followUp: Boolean(project), warning: describeError(err) });
  }
});

/** What a project is so far: the latest summary/spec the team wrote and its file list. */
async function projectContext(slug) {
  const meta = (await readMeta(slug)) || {};
  let summary = "", spec = "";
  for (const j of [...(meta.jobs || [])].reverse()) {
    const events = (await readJobEvents(slug, j.id).catch(() => null)) || [];
    const last = (name) => [...events].reverse().find((e) => e.type === "doc" && e.name === name)?.content || "";
    summary ||= last("summary");
    spec ||= last("spec");
    if (summary && spec) break;
  }
  const files = await loadProjectFiles(slug);
  return { slug, name: meta.name || slug, summary: summary.slice(0, 4000), spec: spec.slice(0, 4000), tree: Object.keys(files).sort().join("\n").slice(0, 3000) };
}

// ---------- jobs ----------
const runningJobFor = (slug) => [...jobs.entries()].find(([, j]) => j.slug === slug && !j.done)?.[0] || null;

app.post("/api/jobs", async (req, res) => {
  const body = req.body || {};
  const user = req.user;
  let task = String(body.task || "").trim();
  const existingSlug = body.projectSlug && projectExists(body.projectSlug) ? body.projectSlug : null;
  if (existingSlug && !(await canAccessProject(user, existingSlug))) return res.status(403).json({ error: "ไม่มีสิทธิ์ในโปรเจกต์นี้" });

  // "Continue where it stopped": rebuild the spec, design and task list from the old job's log.
  let resume;
  if (body.resumeJobId && existingSlug) {
    const old = await readJobEvents(existingSlug, String(body.resumeJobId)).catch(() => null);
    if (!old) return res.status(404).json({ error: "ไม่พบประวัติงานที่จะทำต่อ" });
    task = old.find((e) => e.type === "project")?.task || task;
    const tasksEvt = [...old].reverse().find((e) => e.type === "tasks");
    if (tasksEvt) {
      const lastState = {};
      for (const e of old) if (e.type === "task") lastState[e.id] = e.state;
      const lastDoc = (name) => [...old].reverse().find((e) => e.type === "doc" && e.name === name)?.content || "";
      resume = { spec: lastDoc("spec"), design: lastDoc("design"), tasks: tasksEvt.tasks, done: tasksEvt.tasks.filter((t) => lastState[t.id] === "done").map((t) => t.id) };
    }
  }
  if (!task) return res.status(400).json({ error: "กรุณาใส่รายละเอียดงาน" });
  if (running() >= MAX_RUNNING) return res.status(429).json({ error: "มีงานกำลังทำอยู่เต็มแล้ว ลองใหม่อีกครั้งเมื่องานเดิมเสร็จ" });
  if (existingSlug && runningJobFor(existingSlug)) return res.status(409).json({ error: "โปรเจกต์นี้มีงานกำลังทำอยู่ รอให้เสร็จก่อน" });
  let llm;
  try {
    llm = await makeLLM(body, user);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  // Follow-up work on an existing project starts from the files in its folder.
  const files = existingSlug ? await loadProjectFiles(existingSlug) : {};
  if (Array.isArray(body.files)) {
    for (const f of body.files.slice(0, 300)) {
      const p = safePath(f?.path);
      if (p && typeof f.content === "string") files[p] = f.content;
    }
  }

  const id = randomUUID();
  let project;
  try {
    if (existingSlug) {
      project = { slug: existingSlug, dir: path.join(PROJECTS_DIR, existingSlug) };
    } else {
      const name = String(body.projectName || "").trim() || guessName(task);
      project = await createProject(name, { task, owner: user.id, ownerName: user.name });
    }
    await recordJob(project.slug, { id, task, status: "running", createdAt: new Date().toISOString(), model: llm.model, by: user.name, resumeOf: resume ? String(body.resumeJobId) : undefined });
  } catch (err) {
    return res.status(500).json({ error: `สร้างโฟลเดอร์โปรเจกต์ไม่ได้: ${err.message}` });
  }

  const job = { id, events: [], clients: new Set(), done: false, abort: new AbortController(), slug: project.slug, owner: user.id, writes: Promise.resolve(), pending: [], seq: 0 };
  jobs.set(id, job);

  // Persist events (minus streaming deltas) so the conversation can be reopened later.
  const flush = () => {
    if (!job.pending.length) return;
    const batch = job.pending.splice(0);
    job.writes = job.writes.then(() => appendJobEvents(job.slug, id, batch)).catch((err) => console.error("[history]", err.message));
  };
  const flushTimer = setInterval(flush, 1000);

  job.flush = flush;
  const emit = (evt) => {
    // seq lets the browser skip events it already has when a stream is replayed.
    const e = { ...evt, t: Date.now(), seq: job.seq++ };
    if (e.type === "file") {
      // Serialize writes so a newer version of a file never lands before an older one.
      job.writes = job.writes.then(() => writeProjectFile(job.slug, e.path, e.content)).catch((err) => console.error("[write]", err.message));
    }
    if (e.type !== "delta") job.pending.push(e);
    job.events.push(e);
    const chunk = `id: ${job.events.length - 1}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of job.clients) c.write(chunk);
    // Count tokens. Tokens on a friend's own key are theirs: not taken from the owner's
    // counter or their share. Without their own key, a friend's job stops when their share is gone.
    if (e.type === "usage") {
      if (e.own) job.ownUsed = (job.ownUsed || 0) + (e.input || 0) + (e.output || 0);
      const b = e.own ? budgetFor(user) : charge(user, e.input, e.output);
      emit({ type: "budget", ...b, ...(user.role === "guest" ? { ownUsed: job.ownUsed || 0, onOwnKey: Boolean(llm.onOwnKey) } : {}) });
      if (isOut(user) && !llm.hasFallback && !job.abort.signal.aborted) { job.outOfBudget = true; job.abort.abort(); }
    }
  };
  job.emit = emit;

  const settings = body.settings || {};
  if (llm instanceof FallbackLLM) {
    llm.onSwitch = (why) => {
      emit({ type: "notice", message: why === "share" ? `โควตาที่เจ้าของให้ ${user.name} หมดแล้ว สลับไปใช้ API key ของ ${user.name} ทำงานต่อ` : `โทเค็นของเจ้าของเครื่องหมดแล้ว สลับไปใช้ API key ของ ${user.name} ทำงานต่อ` });
      emit({ type: "budget", ...budgetFor(user), ownUsed: job.ownUsed || 0, onOwnKey: true });
    };
  }
  const base = llm instanceof FallbackLLM ? llm.current : llm;
  emit({ type: "mode", model: llm.model, effort: llm.effort, via: base instanceof LocalClaudeLLM ? "local" : base instanceof SwuLLM ? "swu" : "api", ownKey: Boolean(llm.onOwnKey) });
  const meta = await readMeta(project.slug);
  emit({ type: "project", slug: project.slug, name: meta?.name || project.slug, jobId: id, followUp: Boolean(existingSlug), resume: Boolean(resume), task, demoPath: `/p/${encodeURIComponent(project.slug)}/` });
  let outcome = { status: "failed" };
  runJob({
    input: { task, files, resume },
    llm,
    emit,
    signal: job.abort.signal,
    settings: { maxFixRounds: settings.maxFixRounds, maxReviewRounds: settings.maxReviewRounds },
  })
    .then((r) => { outcome = { status: r.success ? "passed" : "needs-work" }; })
    .catch((err) => {
      if (!job.abort.signal.aborted) console.error("[job]", id, err);
      const quota = err?.quota || job.outOfBudget;
      outcome = { status: quota ? "out-of-tokens" : job.shuttingDown ? "interrupted" : job.abort.signal.aborted ? "cancelled" : "failed", error: describeError(err) };
      const message = err?.ownKey
        ? "API key ของคุณเองก็หมดแล้ว ทีมหยุดทำงาน เติมโควตาหรือเปลี่ยน key ในหน้าตั้งค่า แล้วกด ทำงานต่อ"
        : quota && user.role === "guest"
        ? "โทเค็นที่เจ้าของให้หมดแล้ว ทีมหยุดทำงาน ใส่ API key ของคุณเองในหน้าตั้งค่า (ไอคอนเฟือง) แล้วกด ทำงานต่อ ทีมจะทำต่อจากเดิม"
        : quota
        ? "โทเค็นหมด ทีมหยุดทำงาน เมื่อโทเค็นกลับมาแล้วกด ทำงานต่อ ได้"
        : job.shuttingDown ? "เซิร์ฟเวอร์ถูกปิดระหว่างทำงาน กด ทำงานต่อ เพื่อทำต่อจากที่ค้าง"
        : job.abort.signal.aborted ? "หยุดงานแล้ว กด ทำงานต่อ ได้" : `${describeError(err)} กด ทำงานต่อ เพื่อลองต่อจากที่ค้าง`;
      emit({ type: "error", message, resumable: true });
      if (quota) emit({ type: "budget", ...budgetFor(user) });
    })
    .finally(async () => {
      job.done = true;
      emit({ type: "end" });
      clearInterval(flushTimer);
      flush();
      await job.writes;
      await recordJob(job.slug, { id, ...outcome, finishedAt: new Date().toISOString() }).catch(() => {});
      // Reload the live demo so it runs the files the team just wrote.
      if (!shuttingDown) restartApp(job.slug, { onlyIfRunning: true }).catch(() => {});
      for (const c of job.clients) c.end();
      job.clients.clear();
      setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref();
    });

  res.json({ id, slug: project.slug });
});

// Server-Sent Events. Resumes from Last-Event-ID so long jobs survive reconnects.
// A finished job that is no longer in memory is replayed from the project's history (?project=slug).
app.get("/api/jobs/:id/events", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    const slug = String(req.query.project || "");
    if (!isSlug(slug) || !(await canAccessProject(req.user, slug))) return res.status(404).end();
    const saved = await readJobEvents(slug, req.params.id).catch(() => null);
    if (!saved) return res.status(404).end();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    saved.forEach((e, i) => res.write(`id: ${i}\ndata: ${JSON.stringify(e)}\n\n`));
    if (saved.at(-1)?.type !== "end") {
      // The log stops without an end: the server went down while this job was running.
      const t = (saved.at(-1)?.t || Date.now()) + 1;
      res.write(`data: ${JSON.stringify({ type: "error", message: "งานนี้ถูกขัดจังหวะ (เซิร์ฟเวอร์ปิดไประหว่างทำงาน) กด ทำงานต่อ เพื่อทำต่อจากที่ค้าง", resumable: true, t })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "end", t })}\n\n`);
    }
    return res.end();
  }
  if (!(await canAccessProject(req.user, job.slug))) return res.status(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const last = Number(req.get("Last-Event-ID"));
  const from = Number.isInteger(last) ? last + 1 : 0;
  for (let i = from; i < job.events.length; i++) res.write(`id: ${i}\ndata: ${JSON.stringify(job.events[i])}\n\n`);
  if (job.done) return res.end();
  job.clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => { clearInterval(ping); job.clients.delete(res); });
});

app.post("/api/jobs/:id/cancel", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job && (await canAccessProject(req.user, job.slug))) job.abort.abort();
  res.json({ ok: true });
});

// ---------- saved projects ----------
app.get("/api/projects", async (req, res) => {
  const items = (await listProjects()).filter((m) => canAccess(req.user, m));
  res.json({ dir: req.user.role === "owner" ? PROJECTS_DIR : "", projects: items.map((m) => ({ ...m, demoPath: `/p/${encodeURIComponent(m.slug)}/` })) });
});

app.get("/api/projects/:slug", async (req, res) => {
  const meta = isSlug(req.params.slug) ? await readMeta(req.params.slug) : null;
  if (!meta || !(await canAccessProject(req.user, req.params.slug))) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  const live = runningJobFor(req.params.slug);
  const jobsList = (meta.jobs || []).map((j) => (j.status === "running" && j.id !== live ? { ...j, status: "interrupted" } : j));
  res.json({ ...meta, jobs: jobsList, runningJob: live, dir: req.user.role === "owner" ? path.join(PROJECTS_DIR, req.params.slug) : req.params.slug, demoPath: `/p/${encodeURIComponent(req.params.slug)}/` });
});

// Delete a project (its creator or the machine owner), never while the team is working on it.
app.delete("/api/projects/:slug", async (req, res) => {
  const slug = req.params.slug;
  const meta = isSlug(slug) ? await readMeta(slug) : null;
  if (!meta || !canAccess(req.user, meta)) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  if (!isProjectOwner(req.user, meta)) return res.status(403).json({ error: "ลบได้เฉพาะเจ้าของโปรเจกต์" });
  if (runningJobFor(slug)) return res.status(409).json({ error: "ทีมกำลังทำงานในโปรเจกต์นี้อยู่ หยุดงานก่อนแล้วค่อยลบ" });
  tunnel.stopTunnel(slug);
  await stopApp(slug);
  await deleteProject(slug);
  res.json({ ok: true });
});

// Who is in a project. Invite codes are only shown to the owner or to whoever created that invite.
app.get("/api/projects/:slug/members", async (req, res) => {
  const meta = isSlug(req.params.slug) ? await readMeta(req.params.slug) : null;
  if (!meta || !canAccess(req.user, meta)) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  const mine = req.user.invite?.code;
  const members = (meta.members || []).map((id) => {
    const inv = access.inviteByCode(id.replace(/^guest:/, ""));
    if (!inv || inv.revoked) return null;
    const canSeeLink = req.user.role === "owner" || (mine && inv.invitedBy === mine);
    return { name: inv.name, used: inv.used, limit: inv.limit, invitedBy: inv.invitedBy ? access.inviteByCode(inv.invitedBy)?.name : "เจ้าของเครื่อง", code: canSeeLink ? inv.code : undefined, you: inv.code === mine };
  }).filter(Boolean);
  res.json({ members, owner: meta.ownerName || "เจ้าของเครื่อง", yourRemaining: req.user.role === "guest" ? access.inviteRemaining(req.user.invite) : null });
});

// Invite one or many people into a project at once. Anyone in the project may invite;
// a friend's invites take their quota out of the friend's own remaining quota.
app.post("/api/projects/:slug/invite", async (req, res) => {
  const slug = req.params.slug;
  const meta = isSlug(slug) ? await readMeta(slug) : null;
  if (!meta || !canAccess(req.user, meta)) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  const raw = Array.isArray(req.body?.names) ? req.body.names : String(req.body?.names || "").split(/[,\n]/);
  const names = raw.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  if (!names.length) return res.status(400).json({ error: "ใส่ชื่อเพื่อนอย่างน้อย 1 คน" });
  const created = [];
  try {
    for (const name of names) {
      const inv = access.createInviteFrom(req.user, { name, limit: req.body?.limit });
      await setMember(slug, `guest:${inv.code}`, true);
      created.push({ name: inv.name, code: inv.code, limit: inv.limit });
    }
  } catch (err) {
    return res.status(created.length ? 207 : 400).json({ created, error: err.message });
  }
  res.json({ created });
});

// Owner: add or remove an existing friend from a project.
app.post("/api/projects/:slug/members", ownerOnly, async (req, res) => {
  const slug = req.params.slug;
  const code = String(req.body?.code || "");
  if (!projectExists(slug) || !access.findInvite(code)) return res.status(404).json({ error: "ไม่พบโปรเจกต์หรือลิงก์เชิญ" });
  const meta = await setMember(slug, `guest:${code}`, req.body?.add !== false);
  res.json({ members: meta.members });
});

// The project's live app (its own port). Starts it when needed.
app.get("/api/projects/:slug/app", async (req, res) => {
  if (!isSlug(req.params.slug) || !(await canAccessProject(req.user, req.params.slug))) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  const state = await ensureApp(req.params.slug);
  // Someone outside (through the tunnel) can't reach the app's port, so give the app its own link.
  const publicUrl = await appPublicUrl(req.params.slug, state, viaTunnel(req));
  res.json({ ...state, publicUrl, tunnel: tunnel.tunnelStatus(req.params.slug), canTunnel: Boolean(tunnel.findCloudflared()) });
});
app.post("/api/projects/:slug/app/tunnel", ownerOnly, async (req, res) => {
  const slug = req.params.slug;
  if (!isSlug(slug) || !projectExists(slug)) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  if (req.body?.on === false) {
    tunnel.stopTunnel(slug);
    return res.json({ ...(await ensureApp(slug)), publicUrl: null, tunnel: tunnel.tunnelStatus(slug) });
  }
  const state = await ensureApp(slug);
  if (!state.running) return res.status(409).json({ ...state, error: state.error || state.reason || "แอปยังเปิดไม่ขึ้น" });
  const r = await tunnel.startTunnel(slug, state.port);
  res.status(r.url ? 200 : 502).json({ ...state, publicUrl: r.url || null, tunnel: tunnel.tunnelStatus(slug), error: r.url ? null : r.error });
});
app.post("/api/projects/:slug/app/restart", async (req, res) => {
  if (!isSlug(req.params.slug) || !(await canAccessProject(req.user, req.params.slug))) return res.status(404).json({ error: "ไม่พบโปรเจกต์" });
  res.json(await restartApp(req.params.slug));
});

app.get("/api/projects/:slug/files", async (req, res) => {
  if (!isSlug(req.params.slug) || !(await canAccessProject(req.user, req.params.slug))) return res.status(404).end();
  res.json({ files: await loadProjectFiles(req.params.slug) });
});

app.get("/api/projects/:slug/project.zip", async (req, res) => {
  if (!isSlug(req.params.slug) || !(await canAccessProject(req.user, req.params.slug))) return res.status(404).end();
  const files = await loadProjectFiles(req.params.slug);
  if (!Object.keys(files).length) return res.status(404).end();
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(req.params.slug)}.zip` });
  res.send(zip(files, req.params.slug));
});

// ---------- demo links (public, so anyone with the link can try the result) ----------
// Served from the project folder as a sandboxed document (opaque origin), so a
// generated site can never read or act on this app.
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", svg: "image/svg+xml", txt: "text/plain", md: "text/plain" };
const STORAGE_SHIM = `<script>(function(){function m(){var s=new Map();return{getItem:function(k){return s.has(k)?s.get(k):null},setItem:function(k,v){s.set(k,String(v))},removeItem:function(k){s.delete(k)},clear:function(){s.clear()},key:function(i){return Array.from(s.keys())[i]||null},get length(){return s.size}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("x")}catch(e){Object.defineProperty(window,n,{value:m(),configurable:true})}})})();</script>`;

app.get(/^\/p\/([^/]+)(?:\/(.*))?$/, async (req, res) => {
  let slug, requested = "";
  try {
    slug = decodeURIComponent(req.params[0]);
    requested = safePath(decodeURIComponent(req.params[1] || ""));
  } catch {
    return res.status(400).end();
  }
  if (!isSlug(slug)) return res.status(404).send("ไม่พบโปรเจกต์");
  // Opened directly (this machine or the same Wi-Fi): send visitors to the live app on its own port.
  // Through the outside link: send visitors to the app's own https link (started on demand),
  // so logins and data work there too. Falls back to the read-only view below.
  if (projectExists(slug)) {
    const s = await ensureApp(slug).catch(() => null);
    if (s?.running && !viaTunnel(req)) return res.redirect(`${req.protocol}://${req.hostname}:${s.port}/${req.params[1] || ""}`);
    const url = s?.running && (await appPublicUrl(slug, s, true).catch(() => null));
    if (url) return res.redirect(`${url}/${req.params[1] || ""}`);
  }
  if (req.params[1] === undefined) return res.redirect(`/p/${encodeURIComponent(slug)}/`);
  const files = await loadProjectFiles(slug);
  const candidates = requested ? [requested, path.posix.join(requested, "index.html")] : ["index.html"];
  let p = candidates.find((c) => files[c] != null);
  if (!p && !requested) p = Object.keys(files).sort().find((f) => f.endsWith(".html"));
  if (!p) {
    res.set("Content-Security-Policy", "sandbox");
    return res.status(404).type("text/plain").send(Object.keys(files).length ? "ไม่พบไฟล์นี้ในโปรเจกต์" : "ทีมยังสร้างไฟล์ไม่เสร็จ ลองรีเฟรชอีกครั้ง");
  }
  let body = files[p];
  const ext = p.split(".").pop().toLowerCase();
  if (ext === "html") {
    body = inlineAssets(body, p, files);
    body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + STORAGE_SHIM) : STORAGE_SHIM + body;
  }
  res.set({
    "Content-Type": `${TYPES[ext] || "application/octet-stream"}; charset=utf-8`,
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals allow-popups",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(body);
});

/**
 * Inline local stylesheets and scripts into the page. A sandboxed (opaque-origin)
 * document may be refused sub-resource loads, so the demo page carries its own CSS/JS.
 */
function inlineAssets(html, pagePath, files) {
  const dir = path.posix.dirname(pagePath);
  const resolveRef = (ref) => {
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return null;
    const clean = ref.split(/[?#]/)[0];
    const target = clean.startsWith("/") ? clean.slice(1) : path.posix.normalize(path.posix.join(dir, clean));
    return files[target] != null ? files[target] : null;
  };
  return html
    .replace(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (tagText, href) => {
      if (!/rel=["']?stylesheet/i.test(tagText)) return tagText;
      const css = resolveRef(href);
      return css == null ? tagText : `<style data-src="${href}">\n${css.replace(/<\/style/gi, "<\\/style")}\n</style>`;
    })
    .replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tagText, pre, src, post) => {
      const js = resolveRef(src);
      return js == null ? tagText : `<script${pre}${post} data-src="${src}">\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>`;
    });
}

/** Folder name from the request: first few latin/Thai words. */
function guessName(task) {
  const words = task.replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ").trim().split(/\s+/).slice(0, 4).join(" ");
  return words.slice(0, 40) || "project";
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API key ไม่ถูกต้อง ตรวจสอบในหน้าตั้งค่า";
  if (err instanceof Anthropic.PermissionDeniedError) return "API key นี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก";
  if (err instanceof Anthropic.RateLimitError) return "โดนจำกัดอัตราการเรียก (rate limit) ลองใหม่ภายหลัง";
  if (err instanceof Anthropic.BadRequestError) return `Claude API ปฏิเสธคำขอ: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}

// ---------- robustness: interrupted jobs, safe shutdown, quota reset ----------

/** Jobs still marked "running" from a previous run of the server were interrupted. */
async function markStaleJobs() {
  for (const m of await listProjects()) {
    for (const j of m.jobs || []) {
      if (j.status === "running" && !jobs.has(j.id)) await recordJob(m.slug, { id: j.id, status: "interrupted" }).catch(() => {});
    }
  }
}

/** Stop cleanly: tell watchers, save the logs, mark jobs resumable, then exit. */
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  const live = [...jobs.values()].filter((j) => !j.done);
  if (live.length) console.log(`\n  ${sig}: saving ${live.length} running job(s) so they can be continued...`);
  for (const j of live) {
    j.shuttingDown = true;
    j.abort.abort();
  }
  // Give the job handlers a moment to write their final events and status.
  const deadline = Date.now() + 4000;
  while (live.some((j) => !j.done) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await Promise.all(live.map((j) => { j.flush?.(); return j.writes; })).catch(() => {});
  for (const j of live) await recordJob(j.slug, { id: j.id, status: "interrupted" }).catch(() => {});
  tunnel.stopAllTunnels();
  await stopAll().catch(() => {});
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => shutdown(sig));
process.on("exit", () => tunnel.stopAllTunnels());

/**
 * When the provider said "out of tokens", check every 15 minutes with a tiny request.
 * The first success means the quota was reset upstream, and the counter resets too.
 */
setInterval(async () => {
  if (!usage.snapshot().exhausted || !process.env.SWU_API_KEY) return;
  try {
    const r = await new SwuLLM({ token: process.env.SWU_API_KEY }).call({ system: "Reply with OK.", prompt: "OK" });
    usage.addUsage(r.usage.input, r.usage.output);
    console.log("  Token quota is back: usage counter reset");
  } catch (err) {
    if (!usage.isQuotaError(err)) console.error("[quota probe]", err.message);
  }
}, 15 * 60 * 1000).unref();

app.listen(PORT, async () => {
  await markStaleJobs().catch(() => {});
  console.log(`\n  Agent Office is running at http://localhost:${PORT}`);
  console.log(`  Owner sign-in (keep private): http://localhost:${PORT}/owner?token=${access.ownerToken}`);
  for (const b of shareBases()) console.log(`  Friends on your network:   ${b} (send them an invite link)`);
  console.log(`  Projects are saved in:     ${PROJECTS_DIR}`);
  const local = await localClaudeInfo();
  console.log(local.available ? `  Claude on this machine:    ${local.version}` : "  Claude Code CLI not found on this machine");
  const friendKey = process.env.SWU_API_KEY ? "SWU AI key" : serverHasKey() ? "Anthropic API key" : "";
  console.log(friendKey ? `  Key for friends:           ${friendKey}` : "  Key for friends:           not set (set it in .env or the Share dialog)");
  if (/^(1|on|true|yes)$/i.test(process.env.PUBLIC_TUNNEL || "") && !PUBLIC_URL) {
    const t = await tunnel.startTunnel("main", PORT);
    console.log(t.url ? `  Outside link for friends:  ${t.url}` : `  Outside link failed:       ${t.error}`);
  } else if (!PUBLIC_URL) {
    console.log(tunnel.findCloudflared() ? "  Outside link:              off (turn it on in the Share dialog)" : "  Outside link:              cloudflared not installed (see docs/SHARING.md)");
  }
  console.log("");
});
