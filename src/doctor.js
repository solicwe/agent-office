// Readiness checks: run at startup (fatal problems stop the server with a clear
// message) and in full with `npm run doctor` on any new machine.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nodeSandboxArgs } from "./sandbox.js";

const MIN = [22, 13]; // --permission without warnings and --no-experimental-sqlite

export function nodeVersionOk(version = process.versions.node) {
  const [maj, min] = version.split(".").map(Number);
  return maj > MIN[0] || (maj === MIN[0] && min >= MIN[1]);
}

/** Can this Node run agent code in the locked-down sandbox? */
export function sandboxWorks() {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-office-doctor-"));
  try {
    mkdirSync(path.join(dir, "data"));
    writeFileSync(path.join(dir, "probe.js"), `
      const fs = require("node:fs");
      let wroteOutside = true, spawned = true, sqlite = true;
      try { fs.writeFileSync(__dirname + "/x.txt", "x"); } catch { wroteOutside = false; }
      try { require("node:child_process").execSync("echo hi"); } catch { spawned = false; }
      try { require("node:sqlite"); } catch { sqlite = false; }
      fs.writeFileSync(__dirname + "/data/ok.txt", "ok");
      console.log(JSON.stringify({ wroteOutside, spawned, sqlite }));`);
    const r = spawnSync(process.execPath, [...nodeSandboxArgs(dir), "probe.js"], { cwd: dir, encoding: "utf8", timeout: 15_000, windowsHide: true });
    const line = String(r.stdout || "").trim().split("\n").pop();
    let out;
    try { out = JSON.parse(line); } catch { return { ok: false, detail: (r.stderr || r.error?.message || "sandbox did not start").trim().split("\n")[0] }; }
    const ok = !out.wroteOutside && !out.spawned && !out.sqlite;
    return { ok, detail: ok ? "แยกโค้ดของ AI ได้ (เขียนนอก data/ ไม่ได้, เปิดโปรแกรมอื่นไม่ได้, ไม่มี sqlite)" : `ข้อจำกัดไม่ทำงาน: ${JSON.stringify(out)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function canWrite(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.write-test-${process.pid}`);
    writeFileSync(f, "x");
    rmSync(f);
    return true;
  } catch {
    return false;
  }
}

/** Problems that make the server useless: print them and stop. */
export function startupProblems({ dataDir, projectsDir }) {
  const problems = [];
  if (!nodeVersionOk()) problems.push(`ต้องใช้ Node.js ${MIN.join(".")} ขึ้นไป (เครื่องนี้ ${process.version}) ดาวน์โหลดที่ https://nodejs.org/`);
  else {
    const sb = sandboxWorks();
    if (!sb.ok) problems.push(`sandbox สำหรับรันโค้ดของ AI ใช้ไม่ได้: ${sb.detail}`);
  }
  for (const [name, dir] of [["data", dataDir], ["projects", projectsDir]]) {
    if (!canWrite(dir)) problems.push(`เขียนโฟลเดอร์ ${name} ไม่ได้: ${dir} (ตรวจสิทธิ์ของโฟลเดอร์ หรือ volume ใน Docker)`);
  }
  return problems;
}
