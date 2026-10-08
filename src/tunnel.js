// Public https links through Cloudflare quick tunnels (cloudflared, no account needed).
// Agent Office and each app get their OWN tunnel, so every app stays a separate
// website (own cookies, real logins) and can never act as Agent Office.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const MAX_APP_TUNNELS = Number(process.env.MAX_APP_TUNNELS || 5);
const tunnels = new Map(); // key ("main" or a project slug) -> { port, url, child, starting, error }

export function findCloudflared() {
  if (process.env.CLOUDFLARED_BIN) return existsSync(process.env.CLOUDFLARED_BIN) ? process.env.CLOUDFLARED_BIN : null;
  const names = IS_WIN ? ["cloudflared.exe"] : ["cloudflared"];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (IS_WIN) dirs.push("C:\\Program Files (x86)\\cloudflared", "C:\\Program Files\\cloudflared", path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"));
  else dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (existsSync(p)) return p; }
  return null;
}

export const INSTALL_HINT = IS_WIN
  ? "ติดตั้ง cloudflared ก่อน: เปิด PowerShell แล้วพิมพ์ winget install --id Cloudflare.cloudflared จากนั้นเปิด Agent Office ใหม่"
  : process.platform === "darwin"
    ? "ติดตั้ง cloudflared ก่อน: brew install cloudflared จากนั้นเปิด Agent Office ใหม่"
    : "ติดตั้ง cloudflared ก่อน: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

export function tunnelStatus(key) {
  const t = tunnels.get(key);
  if (!t) return { on: false };
  return { on: true, url: t.url || null, starting: Boolean(t.starting), error: t.error || null, port: t.port };
}

/** Start (or reuse) a quick tunnel to localhost:port. Resolves when the public URL is known. */
export function startTunnel(key, port) {
  const current = tunnels.get(key);
  if (current && current.port === port && current.child?.exitCode === null && !current.error) {
    return current.starting || Promise.resolve(tunnelStatus(key));
  }
  if (current) stopTunnel(key);
  if (key !== "main" && [...tunnels.keys()].filter((k) => k !== "main").length >= MAX_APP_TUNNELS) {
    return Promise.resolve({ on: false, error: `เปิดลิงก์ออกนอกบ้านพร้อมกันได้ไม่เกิน ${MAX_APP_TUNNELS} แอป ปิดของแอปอื่นก่อน` });
  }
  const bin = findCloudflared();
  if (!bin) return Promise.resolve({ on: false, error: INSTALL_HINT, missing: true });

  const t = { port, url: null, child: null, error: null, log: "" };
  tunnels.set(key, t);
  t.starting = new Promise((resolve) => {
    const args = ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`];
    // A .js stand-in (used by the tests) runs with this Node.
    const child = /\.m?js$/.test(bin) ? spawn(process.execPath, [bin, ...args], { windowsHide: true }) : spawn(bin, args, { windowsHide: true, env: process.env });
    t.child = child;
    const done = () => { if (t.starting) { t.starting = null; resolve(tunnelStatus(key)); } };
    const onData = (d) => {
      t.log = (t.log + d).slice(-4000);
      const m = String(d).match(URL_RE);
      if (m && !t.url) { t.url = m[0]; done(); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => { t.error = `เปิด cloudflared ไม่ได้: ${err.message}`; done(); });
    child.on("exit", (code) => {
      if (!t.url) t.error = `cloudflared หยุดทำงาน (code ${code}) ${t.log.split("\n").filter(Boolean).slice(-2).join(" ")}`.trim();
      else t.error = "ลิงก์ออกนอกบ้านหยุดทำงาน กดเปิดใหม่ได้";
      done();
    });
    setTimeout(() => { if (!t.url && !t.error) { t.error = "รอลิงก์จาก Cloudflare นานเกินไป ลองใหม่อีกครั้ง"; child.kill(); } done(); }, 45_000).unref();
  });
  return t.starting;
}

export function stopTunnel(key) {
  const t = tunnels.get(key);
  tunnels.delete(key);
  try { t?.child?.kill(); } catch { /* already gone */ }
}

export function stopAllTunnels() {
  for (const key of [...tunnels.keys()]) stopTunnel(key);
}

/** The public base URL of Agent Office itself, when its tunnel is up. */
export const mainPublicUrl = () => tunnels.get("main")?.url || null;
