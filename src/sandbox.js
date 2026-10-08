// Runs an agent-written project as a real website: its own server.js in a locked-down
// Node process, or a plain static file server when the project has no server.
//
// The child process may read only its own folder and write only <folder>/data. It
// cannot spawn processes, start workers, or use node:sqlite (which ignores these limits).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { readFile, stat, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";

// --permission checks the real path, so a folder reached through a symlink (macOS
// tmpdir is /var/folders -> /private/var/folders) must be allowed by its real path.
export const nodeSandboxArgs = (folder) => {
  const dir = realpathSync(folder);
  return [
    "--no-experimental-sqlite",
    "--permission",
    `--allow-fs-read=${dir}`,
    `--allow-fs-write=${path.join(dir, "data")}`,
  ];
};

export const hasServer = (files) => typeof files["server.js"] === "string";

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const s = netServer();
    s.once("error", () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", txt: "text/plain", md: "text/plain" };

/** Static site server for projects without server.js. Hides history and data folders. */
function staticServer(dir, port) {
  const root = path.resolve(dir);
  const server = createServer(async (req, res) => {
    let rel = "/";
    try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { /* keep "/" */ }
    if (/(^|\/)(\.agent-office|\.agent-office\.json|data|node_modules)(\/|$)/.test(rel)) { res.statusCode = 404; return res.end("Not found"); }
    let file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root)) { res.statusCode = 403; return res.end("Forbidden"); }
    try { if ((await stat(file)).isDirectory()) file = path.join(file, "index.html"); } catch { /* 404 below */ }
    try {
      const body = await readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      res.setHeader("Content-Type", `${TYPES[ext] || "application/octet-stream"}${/html|css|javascript|json|plain/.test(TYPES[ext] || "") ? "; charset=utf-8" : ""}`);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><meta charset=utf-8><p>ไม่พบหน้านี้ <a href="/">กลับหน้าแรก</a></p>');
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

async function waitUntilUp(port, child, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) return false;
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
}

/**
 * Start a project folder as a website on `port`.
 * Returns { port, kind: "app" | "static", ok, logs(), stop(), child? }.
 */
export async function startSite(dir, { port, hasServerJs, timeoutMs = 15_000, onExit } = {}) {
  port = port || (await freePort());
  const lines = [];
  const log = (s) => { for (const l of String(s).split(/\r?\n/)) if (l.trim()) { lines.push(l); if (lines.length > 200) lines.shift(); } };
  const logs = () => lines.join("\n");

  if (!hasServerJs) {
    const server = await staticServer(dir, port);
    return { port, kind: "static", ok: true, logs, stop: () => new Promise((r) => server.close(() => r())) };
  }

  await mkdir(path.join(dir, "data"), { recursive: true });
  dir = realpathSync(dir); // DATA_DIR must match the path the sandbox allows
  const child = spawn(process.execPath, [...nodeSandboxArgs(dir), "server.js"], {
    cwd: dir,
    env: { PORT: String(port), DATA_DIR: path.join(dir, "data"), NODE_ENV: "production", SystemRoot: process.env.SystemRoot || "" },
    windowsHide: true,
  });
  child.stdout.on("data", log);
  child.stderr.on("data", (d) => log(String(d).replace(/^.*ExperimentalWarning.*$/gm, "")));
  child.on("exit", (code) => { log(`[server exited with code ${code}]`); onExit?.(code); });
  const ok = await waitUntilUp(port, child, timeoutMs);
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 3000).unref();
  });
  if (!ok) await stop();
  return { port, kind: "app", ok, logs, stop, child };
}

/**
 * Visit every page reachable from "/" and every local file those pages load.
 * Returns [{ url, from, status, ok }] (at most `limit` URLs).
 */
export async function crawl(base, { limit = 80 } = {}) {
  const seen = new Map();
  const queue = [{ url: new URL("/", base).href, from: "" }];
  const results = [];
  // "/shop/" and "/shop/index.html" are the same page.
  const key = (u) => u.replace(/\/index\.html(?=$|\?)/, "/");
  while (queue.length && results.length < limit) {
    const { url, from } = queue.shift();
    if (seen.has(key(url))) continue;
    seen.set(key(url), true);
    let status = 0, type = "", body = "";
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
      status = res.status;
      type = res.headers.get("content-type") || "";
      if (type.includes("html")) body = await res.text();
      else await res.arrayBuffer();
    } catch (err) {
      status = 0;
    }
    results.push({ url: url.replace(base, "") || "/", from: from.replace(base, ""), status, ok: status >= 200 && status < 400 });
    if (!type.includes("html")) continue;
    for (const m of body.matchAll(/\b(?:href|src)\s*=\s*["']([^"'#]+)["']/gi)) {
      const ref = m[1].trim();
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\{|\$)/i.test(ref)) continue; // external, mailto:, javascript:, templates
      let next;
      try { next = new URL(ref, url); } catch { continue; }
      if (next.origin !== new URL(base).origin) continue;
      next.hash = "";
      if (!seen.has(key(next.href))) queue.push({ url: next.href, from: url });
    }
  }
  return results;
}
