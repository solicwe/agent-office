// Projects on disk: every job writes its files to PROJECTS_DIR/<slug>/ so the
// result is a real folder and the demo link keeps working after a restart.
import { mkdir, writeFile, readFile, readdir, stat, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { safePath } from "./workspace.js";

export const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR || "projects");
const META = ".agent-office.json";
const HISTORY = ".agent-office"; // per-job event logs: .agent-office/jobs/<jobId>.jsonl
const MAX_FILES = 500;

export function slugify(name) {
  const s = String(name || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "project";
}

export const isSlug = (s) => typeof s === "string" && /^[\p{L}\p{M}\p{N}-]{1,64}$/u.test(s);

/** Reserve a new folder name: "shop", "shop-2", "shop-3", … */
export async function createProject(name, meta) {
  await mkdir(PROJECTS_DIR, { recursive: true });
  const base = slugify(name);
  let slug = base;
  for (let i = 2; existsSync(path.join(PROJECTS_DIR, slug)); i++) slug = `${base}-${i}`;
  await mkdir(path.join(PROJECTS_DIR, slug), { recursive: true });
  await saveMeta(slug, { name: name || slug, createdAt: new Date().toISOString(), status: "running", ...meta });
  return { slug, dir: path.join(PROJECTS_DIR, slug) };
}

function projectPath(slug, rel = "") {
  if (!isSlug(slug)) throw new Error("bad project name");
  const clean = rel ? safePath(rel) : "";
  if (rel && !clean) throw new Error("bad path");
  return path.join(PROJECTS_DIR, slug, ...clean.split("/").filter(Boolean));
}

export async function writeProjectFile(slug, rel, content) {
  if (/^\.agent-office(\.json)?(\/|$)/.test(safePath(rel))) throw new Error("reserved path");
  const abs = projectPath(slug, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

export async function saveMeta(slug, patch) {
  const file = projectPath(slug, META);
  let meta = {};
  try { meta = JSON.parse(await readFile(file, "utf8")); } catch { /* new */ }
  meta = { ...meta, ...patch, slug, updatedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export async function readMeta(slug) {
  try { return JSON.parse(await readFile(projectPath(slug, META), "utf8")); } catch { return null; }
}

/** All files of a project as { relPath: content } (text only, skips the meta file). */
export async function loadProjectFiles(slug) {
  const root = projectPath(slug);
  const out = {};
  async function walk(dir, prefix) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (Object.keys(out).length >= MAX_FILES) return;
      if (ent.name === META || ent.name === HISTORY || ent.name === "node_modules" || ent.name.startsWith(".git")) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs, rel);
      else if ((await stat(abs)).size < 2_000_000) out[rel] = await readFile(abs, "utf8");
    }
  }
  if (existsSync(root)) await walk(root, "");
  return out;
}

export const projectExists = (slug) => isSlug(slug) && existsSync(path.join(PROJECTS_DIR, slug));

/** Remove a project folder with all its files and history. */
export async function deleteProject(slug) {
  await rm(projectPath(slug), { recursive: true, force: true });
}

/** Add or remove a friend (user id like "guest:<code>") who may view and edit the project. */
export async function setMember(slug, userId, add) {
  const meta = (await readMeta(slug)) || {};
  const members = new Set(Array.isArray(meta.members) ? meta.members : []);
  if (add) members.add(userId); else members.delete(userId);
  return saveMeta(slug, { members: [...members] });
}

/** Who may open a project: the machine owner, its creator, or an invited member. */
export function canAccess(user, meta) {
  if (user.role === "owner") return true;
  if (!meta || user.role !== "guest") return false;
  return meta.owner === user.id || (Array.isArray(meta.members) && meta.members.includes(user.id));
}

export const isProjectOwner = (user, meta) => user.role === "owner" || (meta && meta.owner === user.id);

// ---------- job history (so every project keeps all its conversations) ----------
const jobLog = (slug, jobId) => {
  if (!isSlug(slug) || !/^[\w-]{8,64}$/.test(jobId)) throw new Error("bad job");
  return path.join(PROJECTS_DIR, slug, HISTORY, "jobs", `${jobId}.jsonl`);
};

export async function appendJobEvents(slug, jobId, events) {
  const file = jobLog(slug, jobId);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

export async function readJobEvents(slug, jobId) {
  try {
    const raw = await readFile(jobLog(slug, jobId), "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

/** Add or update one job entry in the project's meta (newest last). */
export async function recordJob(slug, entry) {
  const meta = (await readMeta(slug)) || {};
  const jobs = Array.isArray(meta.jobs) ? meta.jobs : [];
  const i = jobs.findIndex((j) => j.id === entry.id);
  if (i >= 0) jobs[i] = { ...jobs[i], ...entry };
  else jobs.push(entry);
  return saveMeta(slug, { jobs, ...(entry.status ? { status: entry.status } : {}) });
}

export async function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const items = [];
  for (const ent of await readdir(PROJECTS_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory() || !isSlug(ent.name)) continue;
    const meta = (await readMeta(ent.name)) || { slug: ent.name, name: ent.name };
    items.push(meta);
  }
  return items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}
