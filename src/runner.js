// QA lab: static checks + automated tests for an agent-written project.
// Tests run in a separate Node process under the permission model: the child can
// only read its own temp folder and cannot write files, spawn processes or start workers.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

const TIMEOUT_MS = 15_000;
const RESULT_MARK = "__AGENT_TEST_RESULT__";

export const isTestFile = (p) => /(^|\/)(tests?|__tests__)\/.+\.(c?js|mjs)$|\.test\.(c?js|mjs)$/.test(p);

const wrapper = (testPath) => `
const assert = require("node:assert/strict");
const __tests = [];
global.assert = assert;
global.test = (name, fn) => __tests.push({ name, fn });
global.it = global.test;
global.describe = (_n, fn) => fn();
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
  for (const [p, src] of Object.entries(files)) {
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
    } else if (p.endsWith(".html")) {
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
  const logs = [];
  if (testPaths.length) {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-office-"));
    try {
      for (const [p, content] of Object.entries(files)) {
        const abs = path.join(dir, ...p.split("/"));
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
      }
      for (const [i, tp] of testPaths.entries()) {
        const runnerName = `__agent_runner_${i}.cjs`;
        await writeFile(path.join(dir, runnerName), wrapper(tp), "utf8");
        const out = await spawnNode(dir, runnerName);
        const line = out.stdout.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARK));
        if (line) {
          for (const r of JSON.parse(line.slice(RESULT_MARK.length))) results.push({ ...r, name: `${tp} › ${r.name}`, kind: "test" });
        } else {
          results.push({ name: `${tp}`, ok: false, kind: "test", error: out.timedOut ? `หมดเวลา ${TIMEOUT_MS / 1000} วินาที (อาจมี infinite loop)` : (out.stderr || "process crashed").slice(0, 1500) });
        }
        const extra = out.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith(RESULT_MARK)).join("\n");
        if (extra) logs.push(`[${tp}]\n${extra.slice(0, 1500)}`);
        if (out.stderr && line) logs.push(`[${tp} stderr]\n${out.stderr.slice(0, 1500)}`);
      }
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const tests = results.filter((r) => r.kind === "test");
  return {
    ok: results.length > 0 && passed === results.length,
    passed,
    failed: results.length - passed,
    total: results.length,
    testCount: tests.length,
    results,
    logs: logs.join("\n\n"),
  };
}

function spawnNode(dir, file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, file], {
      cwd: dir,
      env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot || "" },
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
  const lines = [`ผลรวม: ผ่าน ${r.passed}/${r.total} (เทสต์อัตโนมัติ ${r.testCount} เคส + ตรวจไฟล์ ${r.total - r.testCount} รายการ)`];
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
