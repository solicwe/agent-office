// Use the team and the office in any other repository (a friend's, a class project...)
// without changing what that repository commits:
//   npm run attach -- <repo folder> [--port 3000]
//   npm run detach -- <repo folder>
// attach copies the roles into <repo>/.claude/agents/ (never over the repo's own),
// adds the hooks to <repo>/.claude/settings.local.json (personal, not shared), and lists
// everything it added in <repo>/.git/info/exclude so none of it can be committed.
// detach removes exactly what attach added (a role you have edited since is kept).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"];
const MANIFEST = ".claude/.agent-office.json";
const EXCLUDE_START = "# agent-office: local only (npm run detach removes this block)";
const EXCLUDE_END = "# /agent-office";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
const isOurs = (h, url) => h?.type === "http" && h.url === url;

function excludeFile(repo) {
  const git = path.join(repo, ".git");
  if (!existsSync(git) || !statSync(git).isDirectory()) return null; // not a repo, or a worktree/submodule
  return path.join(git, "info", "exclude");
}

function setExclude(repo, lines) {
  const f = excludeFile(repo);
  if (!f) return false;
  mkdirSync(path.dirname(f), { recursive: true });
  const old = existsSync(f) ? readFileSync(f, "utf8") : "";
  const lit = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const kept = old.replace(new RegExp(`\\n?${lit(EXCLUDE_START)}[\\s\\S]*?${lit(EXCLUDE_END)}\\n?`, "g"), "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const block = lines.length ? `\n${EXCLUDE_START}\n${lines.join("\n")}\n${EXCLUDE_END}\n` : "\n";
  writeFileSync(f, (kept ? kept + "\n" : "") + block);
  return true;
}

export function attach(repo, { port = 3000, agentsDir = path.join(root, ".claude", "agents") } = {}) {
  repo = path.resolve(repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`ไม่พบโฟลเดอร์ ${repo}`);
  if (path.resolve(repo) === root) throw new Error("โฟลเดอร์นี้คือ Agent Office เอง มี role และ hooks อยู่แล้ว");
  const url = `http://127.0.0.1:${port}/hooks`;
  const prev = readJson(path.join(repo, MANIFEST), { copied: {} });

  // 1. roles: copy ours where the repo has none of that name
  const target = path.join(repo, ".claude", "agents");
  mkdirSync(target, { recursive: true });
  const copied = { ...prev.copied };
  const skipped = [];
  for (const n of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
    const dest = path.join(target, n);
    const text = readFileSync(path.join(agentsDir, n), "utf8");
    if (existsSync(dest) && !copied[n]) { skipped.push(n); continue; } // the repo's own role wins
    if (existsSync(dest) && copied[n] && sha(readFileSync(dest, "utf8")) !== copied[n]) { skipped.push(n); continue; } // edited by you: keep
    writeFileSync(dest, text);
    copied[n] = sha(text);
  }

  // 2. hooks, in the personal settings file
  const settingsFile = path.join(repo, ".claude", "settings.local.json");
  const settings = readJson(settingsFile, {});
  const createdSettings = prev.createdSettings ?? !existsSync(settingsFile);
  settings.hooks ??= {};
  for (const ev of EVENTS) {
    const list = (settings.hooks[ev] ??= []);
    if (list.some((g) => (g.hooks || []).some((h) => isOurs(h, url)))) continue;
    list.push({ ...(ev.endsWith("ToolUse") ? { matcher: "*" } : {}), hooks: [{ type: "http", url, timeout: 3 }] });
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");

  // 3. keep it all out of the repo's commits
  writeFileSync(path.join(repo, MANIFEST), JSON.stringify({ attachedAt: new Date().toISOString(), url, copied, createdSettings }, null, 2) + "\n");
  const excluded = setExclude(repo, [".claude/settings.local.json", MANIFEST, ...Object.keys(copied).map((n) => `.claude/agents/${n}`)]);
  return { repo, url, copied: Object.keys(copied), skipped, excluded };
}

export function detach(repo) {
  repo = path.resolve(repo);
  const man = readJson(path.join(repo, MANIFEST), null);
  if (!man) throw new Error(`โฟลเดอร์นี้ยังไม่ได้ attach (${repo})`);
  const removed = [], kept = [];
  for (const [n, hash] of Object.entries(man.copied || {})) {
    const f = path.join(repo, ".claude", "agents", n);
    if (!existsSync(f)) continue;
    if (sha(readFileSync(f, "utf8")) === hash) { rmSync(f); removed.push(n); } else kept.push(n);
  }
  const agentsDir = path.join(repo, ".claude", "agents");
  if (existsSync(agentsDir) && !readdirSync(agentsDir).length) rmSync(agentsDir, { recursive: true });

  const settingsFile = path.join(repo, ".claude", "settings.local.json");
  const settings = readJson(settingsFile, null);
  if (settings?.hooks) {
    for (const ev of Object.keys(settings.hooks)) {
      settings.hooks[ev] = settings.hooks[ev]
        .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h, man.url)) }))
        .filter((g) => g.hooks.length);
      if (!settings.hooks[ev].length) delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    if (man.createdSettings && !Object.keys(settings).length) rmSync(settingsFile);
    else writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  }
  rmSync(path.join(repo, MANIFEST), { force: true });
  setExclude(repo, kept.map((n) => `.claude/agents/${n}`));
  const claudeDir = path.join(repo, ".claude");
  if (existsSync(claudeDir) && !readdirSync(claudeDir).length) rmSync(claudeDir, { recursive: true });
  return { repo, removed, kept };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const off = args.includes("--detach");
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : Number(process.env.PORT || 3000);
  const repo = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
  if (!repo) {
    console.log("ใช้:  npm run attach -- <โฟลเดอร์ repo>      ติดตั้งทีมและ hooks ให้ repo นั้น (เฉพาะเครื่องนี้)\n      npm run detach -- <โฟลเดอร์ repo>      เอาออก");
    process.exit(2);
  }
  try {
    if (off) {
      const r = detach(repo);
      console.log(`\n  เอาออกจาก ${r.repo} แล้ว: ลบ role ${r.removed.length} ไฟล์${r.kept.length ? `, เก็บไว้ ${r.kept.join(", ")} เพราะมีการแก้` : ""}, เอา hooks ออก\n`);
    } else {
      const r = attach(repo, { port });
      console.log(`\n  ติดตั้งให้ ${r.repo} แล้ว`);
      console.log(`  - role: ${r.copied.length} ไฟล์ใน .claude/agents/${r.skipped.length ? ` (ไม่ทับ role ที่ repo มีอยู่แล้ว: ${r.skipped.join(", ")})` : ""}`);
      console.log(`  - hooks: .claude/settings.local.json → ${r.url}`);
      console.log(r.excluded ? "  - ไม่มีอะไรถูก commit เข้า repo นี้ (อยู่ใน .git/info/exclude)" : "  - ไม่ใช่ git repo ปกติ: ระวังอย่า commit .claude/settings.local.json และ role ที่คัดลอกมา");
      console.log("\n  ต่อไป: เปิด Agent Office (start.bat / start.command) แล้วเปิด Claude Code ในโฟลเดอร์นั้น\n  เลิกใช้: npm run detach -- " + repo + "\n");
    }
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}
