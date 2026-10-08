// QA lab: static checks, a live run of the site (start it, open every page), and
// automated tests against the running server. Everything runs in locked-down Node
// processes: they read only their temp folder, write only its data/ folder, and
// cannot spawn processes, start workers or use node:sqlite.
import { spawn } from "node:child_process";
import { startSite, crawl, hasServer } from "./sandbox.js";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

const TIMEOUT_MS = 30_000;
const RESULT_MARK = "__AGENT_TEST_RESULT__";

export const isTestFile = (p) => /(^|\/)(tests?|__tests__)\/.+\.(c?js|mjs)$|\.test\.(c?js|mjs)$/.test(p);

const wrapper = (testPath) => `
const assert = require("node:assert/strict");
const __tests = [];
global.assert = assert;
global.test = (name, fn) => __tests.push({ name, fn });
global.it = global.test;
global.describe = (_n, fn) => fn();
// Address of the running site (API tests use fetch(BASE_URL + "/api/..."))
global.BASE_URL = process.env.BASE_URL || "";
// In-memory storage so browser-style logic modules can be loaded in Node.
const __mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
if (typeof globalThis.localStorage === "undefined") globalThis.localStorage = __mem();
if (typeof globalThis.sessionStorage === "undefined") globalThis.sessionStorage = __mem();
(async () => {
  const results = [];
  try {
    require(${JSON.stringify("./" + testPath)});
  } catch (e) {
    results.push({ name: "load test file", ok: false, error: String((e && e.stack) || e).split("\\n").slice(0, 4).join("\\n") });
  }
  for (const t of __tests) {
    try { await t.fn(); results.push({ name: t.name, ok: true }); }
    catch (e) { results.push({ name: t.name, ok: false, error: String((e && e.message) || e).slice(0, 700) }); }
  }
  console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(results));
})();
`;

/** Syntax, JSON and HTML-link checks. Parsing only; nothing is executed. */
export function staticChecks(files) {
  const results = [];
  const app = hasServer(files);
  for (const [p, src] of Object.entries(files)) {
    if (/\.(c?js|mjs)$/.test(p) && /["'](?:node:)?sqlite3?["']/.test(src)) {
      results.push({ name: `security: ${p}`, ok: false, kind: "static", error: "ห้ามใช้ node:sqlite หรือ sqlite (ข้ามข้อจำกัดความปลอดภัย) ให้ใช้ server/lib/db.js แทน" });
    }
    if (/\.(c?js)$/.test(p)) {
      try {
        new vm.Script(src, { filename: p });
        results.push({ name: `syntax: ${p}`, ok: true, kind: "static" });
      } catch (e) {
        if (/import|export|await is only valid/i.test(e.message)) {
          results.push({ name: `syntax: ${p} (ES module, ข้ามการตรวจ)`, ok: true, kind: "static" });
        } else {
          results.push({ name: `syntax: ${p}`, ok: false, kind: "static", error: `${e.name}: ${e.message}` });
        }
      }
    } else if (p.endsWith(".json")) {
      try { JSON.parse(src); results.push({ name: `json: ${p}`, ok: true, kind: "static" }); }
      catch (e) { results.push({ name: `json: ${p}`, ok: false, kind: "static", error: e.message }); }
    } else if (p.endsWith(".html") && !app) {
      // Apps are checked live by the crawler instead (their pages live under public/).
      const dir = path.posix.dirname(p);
      const missing = [];
      for (const m of src.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        const ref = m[1].trim();
        if (/^(?:[a-z]+:|\/\/|#|\{|\$)/i.test(ref) || !ref) continue;
        const clean = ref.split(/[?#]/)[0];
        if (!clean) continue;
        const target = clean.startsWith("/") ? clean.slice(1) : path.posix.normalize(path.posix.join(dir, clean));
        if (files[target] == null && files[path.posix.join(target, "index.html")] == null) missing.push(ref);
      }
      results.push(missing.length
        ? { name: `links: ${p}`, ok: false, kind: "static", error: `อ้างถึงไฟล์ที่ไม่มีอยู่: ${[...new Set(missing)].join(", ")}` }
        : { name: `links: ${p}`, ok: true, kind: "static" });
    }
  }
  return results;
}

export async function runProject(files) {
  const results = staticChecks(files);
  const testPaths = Object.keys(files).filter(isTestFile).sort();
  const hasPages = Object.keys(files).some((p) => p.endsWith(".html"));
  const logs = [];
  if (!testPaths.length && !hasPages && !hasServer(files)) return summarize(results, logs);

  const dir = await mkdtemp(path.join(tmpdir(), "agent-office-"));
  let site = null;
  try {
    for (const [p, content] of Object.entries(files)) {
      if (/^data\//.test(p)) continue; // never test against saved app data
      const abs = path.join(dir, ...p.split("/"));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    await mkdir(path.join(dir, "data"), { recursive: true });

    // 1. Start the site for real.
    if (hasServer(files) || hasPages) {
      site = await startSite(dir, { hasServerJs: hasServer(files) });
      if (site.kind === "app") {
        results.push(site.ok
          ? { name: "server: เปิดเซิร์ฟเวอร์ได้", ok: true, kind: "web" }
          : { name: "server: เปิดเซิร์ฟเวอร์ไม่ขึ้น", ok: false, kind: "web", error: tail(site.logs()) || "server.js หยุดทำงานทันทีที่เปิด" });
      }
      // 2. Open every page reachable from "/" and every file those pages load.
      if (site.ok) {
        const base = `http://127.0.0.1:${site.port}`;
        const visited = await crawl(base);
        const broken = visited.filter((v) => !v.ok);
        const pages = visited.filter((v) => /\.html$|\/$/.test(v.url.split("?")[0]));
        for (const b of broken) {
          results.push({ name: `web: ${b.url}`, ok: false, kind: "web", error: `${b.status ? `ได้สถานะ ${b.status}` : "เปิดไม่ได้"}${b.from ? ` (ลิงก์อยู่ในหน้า ${b.from})` : ""}` });
        }
        if (!pages.length) results.push({ name: "web: หน้าแรก /", ok: false, kind: "web", error: "ไม่มีหน้าเว็บที่ / (ต้องมี index.html หรือ public/index.html)" });
        else if (!broken.length) results.push({ name: `web: เปิดได้ทุกหน้า (${pages.length} หน้า, ${visited.length} ไฟล์)`, ok: true, kind: "web" });
      }
    }

    // 3. Automated tests, with BASE_URL pointing at the running site.
    for (const [i, tp] of testPaths.entries()) {
      const runnerName = `__agent_runner_${i}.cjs`;
      await writeFile(path.join(dir, runnerName), wrapper(tp), "utf8");
      const out = await spawnNode(dir, runnerName, site?.ok ? `http://127.0.0.1:${site.port}` : "");
      const line = out.stdout.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARK));
      if (line) {
        for (const r of JSON.parse(line.slice(RESULT_MARK.length))) results.push({ ...r, name: `${tp} › ${r.name}`, kind: "test" });
      } else {
        results.push({ name: `${tp}`, ok: false, kind: "test", error: out.timedOut ? `หมดเวลา ${TIMEOUT_MS / 1000} วินาที (อาจมี infinite loop)` : (out.stderr || "process crashed").slice(0, 1500) });
      }
      const extra = out.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith(RESULT_MARK)).join("\n");
      if (extra) logs.push(`[${tp}]\n${extra.slice(0, 1500)}`);
      if (out.stderr && line) logs.push(`[${tp} stderr]\n${tail(out.stderr)}`);
    }
    if (site?.kind === "app" && results.some((r) => !r.ok)) {
      const serverLog = tail(site.logs());
      if (serverLog) logs.push(`[server log]\n${serverLog}`);
    }
  } finally {
    await site?.stop().catch(() => {});
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return summarize(results, logs);
}

const tail = (s, n = 40) => String(s || "").split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).slice(-n).join("\n").trim();

function summarize(results, logs) {
  const passed = results.filter((r) => r.ok).length;
  const tests = results.filter((r) => r.kind === "test");
  return {
    ok: results.length > 0 && passed === results.length,
    passed,
    failed: results.length - passed,
    total: results.length,
    testCount: tests.length,
    webCount: results.filter((r) => r.kind === "web").length,
    results,
    logs: logs.join("\n\n"),
  };
}

function spawnNode(dir, file, baseUrl) {
  return new Promise((resolve) => {
    const args = ["--no-experimental-sqlite", "--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${path.join(dir, "data")}`, file];
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { NODE_ENV: "test", BASE_URL: baseUrl || "", DATA_DIR: path.join(dir, "data"), SystemRoot: process.env.SystemRoot || "" },
      windowsHide: true,
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { if (stdout.length < 500_000) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 200_000) stderr += d; });
    child.on("close", (exitCode) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode, timedOut }); });
  });
}

export function formatReport(r) {
  const lines = [`ผลรวม: ผ่าน ${r.passed}/${r.total} (เทสต์อัตโนมัติ ${r.testCount} เคส, ลองเปิดเว็บจริง ${r.webCount || 0} รายการ, ตรวจไฟล์ ${r.total - r.testCount - (r.webCount || 0)} รายการ)`];
  if (!r.testCount) lines.push("หมายเหตุ: ยังไม่มีไฟล์เทสต์ใน tests/");
  const fails = r.results.filter((x) => !x.ok);
  if (fails.length) {
    lines.push("", "ไม่ผ่าน:");
    for (const t of fails) lines.push(`[FAIL] ${t.name}\n       ${String(t.error).replace(/\n/g, "\n       ")}`);
  }
  lines.push("", "ผ่าน:");
  for (const t of r.results.filter((x) => x.ok)) lines.push(`[ OK ] ${t.name}`);
  if (r.logs) lines.push("", "[console]", r.logs);
  return lines.join("\n");
}
