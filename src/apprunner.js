// Live demos: every project runs on its own port, so it is its own website
// (own cookies and storage, real logins, data that survives page changes) and
// is a different origin from Agent Office itself.
import { existsSync } from "node:fs";
import path from "node:path";
import { startSite, portIsFree } from "./sandbox.js";
import { PROJECTS_DIR, readMeta, saveMeta, isSlug } from "./projects.js";

const BASE_PORT = Number(process.env.APP_PORT_BASE || 4100);
const MAX_APPS = Number(process.env.APP_PORT_COUNT || 400);
const apps = new Map(); // slug -> { site, port, kind, starting }

const projectDir = (slug) => path.join(PROJECTS_DIR, slug);

async function pickPort(slug) {
  const meta = await readMeta(slug);
  const taken = new Set([...apps.values()].map((a) => a.port));
  if (meta?.port && !taken.has(meta.port) && (await portIsFree(meta.port))) return meta.port;
  for (let p = BASE_PORT; p < BASE_PORT + MAX_APPS; p++) {
    if (!taken.has(p) && (await portIsFree(p))) {
      await saveMeta(slug, { port: p });
      return p;
    }
  }
  throw new Error("ไม่มีพอร์ตว่างสำหรับเปิดแอป");
}

/** Start the project's site if it is not running. Resolves to its status. */
export async function ensureApp(slug) {
  if (!isSlug(slug)) throw new Error("bad project");
  const current = apps.get(slug);
  if (current?.starting) return current.starting;
  if (current?.site && (current.kind === "static" || current.site.child?.exitCode === null)) return status(slug);
  const dir = projectDir(slug);
  const hasServerJs = existsSync(path.join(dir, "server.js"));
  const hasPage = hasServerJs || existsSync(path.join(dir, "index.html")) || existsSync(path.join(dir, "public", "index.html"));
  if (!hasPage) return { running: false, reason: "ยังไม่มีหน้าเว็บในโปรเจกต์นี้" };
  const entry = { port: null, kind: hasServerJs ? "app" : "static", site: null };
  entry.starting = (async () => {
    try {
      entry.port = await pickPort(slug);
      entry.site = await startSite(dir, { port: entry.port, hasServerJs, timeoutMs: 20_000 });
    } catch (err) {
      entry.error = err.message;
    } finally {
      entry.starting = null;
    }
    return status(slug);
  })();
  apps.set(slug, entry);
  return entry.starting;
}

export function status(slug) {
  const a = apps.get(slug);
  if (!a) return { running: false };
  const alive = a.site && (a.kind === "static" || a.site.child?.exitCode === null) && a.site.ok;
  return {
    running: Boolean(alive),
    port: a.port,
    kind: a.kind,
    error: a.error || (a.site && !alive ? "เซิร์ฟเวอร์ของแอปหยุดทำงาน" : undefined),
    logs: a.site?.logs().split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).slice(-30).join("\n"),
  };
}

export async function stopApp(slug) {
  const a = apps.get(slug);
  apps.delete(slug);
  if (a?.starting) await a.starting.catch(() => {});
  await a?.site?.stop().catch(() => {});
}

/** Restart after the team changed files (only if it was already running). */
export async function restartApp(slug, { onlyIfRunning = false } = {}) {
  if (onlyIfRunning && !apps.has(slug)) return status(slug);
  await stopApp(slug);
  return ensureApp(slug);
}

export async function stopAll() {
  await Promise.all([...apps.keys()].map((s) => stopApp(s)));
}
