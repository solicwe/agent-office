// Outside links through a stand-in cloudflared: Agent Office gets one link, and each
// app gets its own, so logins inside the app work for friends outside the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 6000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let dir, server, OWNER;
const json = { "Content-Type": "application/json" };
const viaTunnel = { "X-Forwarded-For": "203.0.113.9", "Cf-Connecting-Ip": "203.0.113.9" };
const f = (url, opts = {}) => fetch(url, { ...opts, headers: { Cookie: OWNER, ...(opts.headers || {}) } });

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-office-tunnel-"));
  await mkdir(path.join(dir, "projects", "shop"), { recursive: true });
  await writeFile(path.join(dir, "projects", "shop", ".agent-office.json"), JSON.stringify({ slug: "shop", name: "shop", owner: "owner" }));
  await writeFile(path.join(dir, "projects", "shop", "index.html"), "<h1>shop</h1>");
  server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env, PORT: String(PORT), PROJECTS_DIR: path.join(dir, "projects"), DATA_DIR: path.join(dir, "data"), USAGE_FILE: path.join(dir, "data", "usage.json"),
      ANTHROPIC_API_KEY: "", SWU_API_KEY: "", APP_PORT_BASE: "7100", CLAUDE_CODE_BIN: path.join(dir, "missing"),
      CLOUDFLARED_BIN: path.join(here, "fixtures", "fake-cloudflared.js"), PUBLIC_URL: "", PUBLIC_TUNNEL: "", TUNNEL_DNS_CHECK: "0",
    },
    stdio: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/api/config"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  OWNER = "ao_owner=" + readFileSync(path.join(dir, "data", "owner-token.txt"), "utf8").trim();
});

after(async () => {
  await f(BASE + "/api/projects/shop/app/tunnel", { method: "POST", headers: json, body: JSON.stringify({ on: false }) }).catch(() => {});
  await f(BASE + "/api/tunnel", { method: "POST", headers: json, body: JSON.stringify({ on: false }) }).catch(() => {});
  server?.kill();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("the owner turns the outside link on: invite links use it", async () => {
  const info = await (await f(BASE + "/api/tunnel")).json();
  assert.equal(info.available, true);
  assert.equal(info.main.on, false);
  const on = await (await f(BASE + "/api/tunnel", { method: "POST", headers: json, body: JSON.stringify({ on: true }) })).json();
  assert.equal(on.main.url, `https://fake-${PORT}.trycloudflare.com`);
  const cfg = await (await f(BASE + "/api/config")).json();
  assert.equal(cfg.shareBases[0], on.main.url, "invite links point at the outside link");
});

test("only the owner can open or close outside links", async () => {
  assert.equal((await fetch(BASE + "/api/tunnel", { method: "POST", headers: { ...json, ...viaTunnel }, body: "{}" })).status, 401);
});

test("someone coming through the outside link gets the app's own https link", { timeout: 30_000 }, async () => {
  const st = await (await f(BASE + "/api/projects/shop/app", { headers: viaTunnel })).json();
  assert.equal(st.running, true, JSON.stringify(st));
  assert.equal(st.publicUrl, `https://fake-${st.port}.trycloudflare.com`, "a separate link (and origin) for the app");
  // Demo links opened through the outside link go to the app's own link.
  const r = await fetch(BASE + "/p/shop/cart.html", { headers: viaTunnel, redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), `${st.publicUrl}/cart.html`);
  // On this machine the owner sees the same link and can close it.
  const local = await (await f(BASE + "/api/projects/shop/app")).json();
  assert.equal(local.publicUrl, st.publicUrl);
  // Restarting the app keeps its port, so the link friends have keeps working.
  const again = await (await f(BASE + "/api/projects/shop/app/restart", { method: "POST", headers: json, body: "{}" })).json();
  assert.equal(again.port, st.port);
  assert.equal(again.publicUrl, st.publicUrl);
  const off = await (await f(BASE + "/api/projects/shop/app/tunnel", { method: "POST", headers: json, body: JSON.stringify({ on: false }) })).json();
  assert.equal(off.publicUrl, null);
});

test("turning the outside link off goes back to the Wi-Fi address", async () => {
  const off = await (await f(BASE + "/api/tunnel", { method: "POST", headers: json, body: JSON.stringify({ on: false }) })).json();
  assert.equal(off.main.on, false);
  assert.ok(!off.shareBases.some((b) => b.includes("trycloudflare")));
});
