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
import { safePath, zip } from "./src/workspace.js";
import { PROJECTS_DIR, createProject, writeProjectFile, readMeta, loadProjectFiles, listProjects, isSlug, projectExists, appendJobEvents, readJobEvents, recordJob, deleteProject, setMember, canAccess, isProjectOwner } from "./src/projects.js";
import { offlineStep, BRIEF_SCHEMA, BRIEF_SYSTEM, briefPrompt } from "./src/brief.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const MAX_RUNNING = Number(process.env.MAX_RUNNING_JOBS || 3);
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(here, "public")));

/** @type {Map<string, {events: object[], clients: Set<import('express').Response>, done: boolean, abort: AbortController, slug: string, owner: string, writes: Promise<void>}>} */
const jobs = new Map();
const running = () => [...jobs.values()].filter((j) => !j.done).length;

/** Addresses other people can open: PUBLIC_URL (e.g. a tunnel) or this machine's LAN address. */
function shareBases() {
  if (PUBLIC_URL) return [PUBLIC_URL];
  const out = [];
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

app.use("/api", (req, res, next) => {
  req.user = access.identify(req);
  if (req.user.role === "none" && req.path !== "/config") return res.status(401).json({ error: "ต้องเปิดผ่านลิงก์เชิญจากเจ้าของเครื่อง" });
  next();
});
const ownerOnly = (req, res, next) => (req.user.role === "owner" ? next() : res.status(403).json({ error: "เฉพาะเจ้าของเครื่อง" }));

/**
 * Token usage as this user sees it: the owner sees everything used since the last
 * reset; a friend sees what they used and whether their quota is gone.
 */
function budgetFor(user) {
  const g = usage.snapshot();
  if (user.role !== "guest") return { used: g.used, exhausted: g.exhausted, since: g.since, lastReset: g.lastReset };
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
app.post("/api/usage/reset", ownerOnly, (req, res) => res.json(usage.resetCount("manual")));

app.get("/api/invites", ownerOnly, (_req, res) => res.json({ invites: access.listInvites(), shareBases: shareBases(), serverHasKey: hasFriendKey() }));
app.post("/api/invites", ownerOnly, (req, res) => res.json(access.createInvite(req.body || {})));
app.delete("/api/invites/:code", ownerOnly, (req, res) => { access.revokeInvite(req.params.code); res.json({ ok: true }); });
app.post("/api/swu/models", ownerOnly, async (req, res) => {
  try {
    res.json({ base: SWU_BASE_URL, models: await swuModels(String(req.body?.swuKey || "").trim() || process.env.SWU_API_KEY || "") });
  } catch (err) {
    res.status(502).json({ error: `ดึงรายชื่อโมเดลจาก SWU AI ไม่ได้: ${err.message}` });
  }
});
app.post("/api/server-key", ownerOnly, (req, res) => { access.setServerKey(req.body?.apiKey); res.json({ serverHasKey: serverHasKey() }); });

/**
 * How to reach Claude. The owner may use the Claude Code login on this machine
 * ("local") or an API key. Friends always go through the owner's server API key:
 * a personal Claude login is for its owner only and must not be shared.
 */
async function makeLLM(body, user) {
  const s = body.settings || {};
  if (user.role === "guest") {
    // Friends use the owner's team API on the server: SWU AI first, else the Anthropic key.
    if (process.env.SWU_API_KEY) return new SwuLLM({ token: process.env.SWU_API_KEY });
    if (!serverHasKey()) throw httpError(400, "เจ้าของเครื่องยังไม่ได้ตั้ง API key สำหรับเพื่อน");
    return new ClaudeLLM({ model: s.model, effort: s.effort });
  }
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
  if (isOut(req.user)) return res.json({ ...offlineStep(idea, answers, finish), mode: "offline", warning: "โควตาโทเค็นของคุณหมดแล้ว" });
  try {
    const llm = watchQuota(await makeLLM(body, req.user));
    const { data, usage: u } = await llm.json({ system: BRIEF_SYSTEM, prompt: briefPrompt(idea, answers, finish), schema: BRIEF_SCHEMA });
    res.json({ ...data, options: (data.options || []).slice(0, 8), mode: "claude", usage: charge(req.user, u.input, u.output) });
  } catch (err) {
    console.error("[brief]", err.message);
    res.json({ ...offlineStep(idea, answers, finish), mode: "offline", warning: describeError(err) });
  }
});

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
  if (isOut(user)) return res.status(402).json({ error: "โควตาโทเค็นของคุณหมดแล้ว ขอเพิ่มจากเจ้าของเครื่อง" });
  let llm;
  try {
    llm = watchQuota(await makeLLM(body, user));
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
    // Count tokens; a friend's job stops when their quota is used up.
    if (e.type === "usage") {
      const b = charge(user, e.input, e.output);
      emit({ type: "budget", ...b });
      if (isOut(user) && !job.abort.signal.aborted) { job.outOfBudget = true; job.abort.abort(); }
    }
  };
  job.emit = emit;

  const settings = body.settings || {};
  emit({ type: "mode", model: llm.model, effort: llm.effort, via: llm instanceof LocalClaudeLLM ? "local" : llm instanceof SwuLLM ? "swu" : "api" });
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
      const message = quota
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
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => shutdown(sig));

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
  for (const b of shareBases()) console.log(`  Friends on your network:   ${b} (send them an invite link)`);
  console.log(`  Projects are saved in:     ${PROJECTS_DIR}`);
  const local = await localClaudeInfo();
  console.log(local.available ? `  Claude on this machine:    ${local.version}` : "  Claude Code CLI not found on this machine");
  const friendKey = process.env.SWU_API_KEY ? "SWU AI key" : serverHasKey() ? "Anthropic API key" : "";
  console.log(friendKey ? `  Key for friends:           ${friendKey}\n` : "  Key for friends:           not set (set it in .env or the Share dialog)\n");
});
