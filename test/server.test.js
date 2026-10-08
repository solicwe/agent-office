import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3000 + Math.floor(Math.random() * 2000) + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
let dir, server;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-office-server-"));
  // One project owned by the machine owner.
  await mkdir(path.join(dir, "projects", "owner-shop"), { recursive: true });
  await writeFile(path.join(dir, "projects", "owner-shop", ".agent-office.json"), JSON.stringify({ slug: "owner-shop", name: "owner-shop", owner: "owner" }));
  await writeFile(path.join(dir, "projects", "owner-shop", "index.html"), "<h1>hi</h1>");
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), PROJECTS_DIR: path.join(dir, "projects"), DATA_DIR: path.join(dir, "data"), USAGE_FILE: path.join(dir, "data", "usage.json"), ANTHROPIC_API_KEY: "", SWU_API_KEY: "", APP_PORT_BASE: "5100", CLAUDE_CODE_BIN: path.join(dir, "missing"), CLOUDFLARED_BIN: path.join(dir, "missing-cloudflared"), PUBLIC_URL: "", PUBLIC_TUNNEL: "" },
    stdio: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/api/config"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  OWNER = "ao_owner=" + readFileSync(path.join(dir, "data", "owner-token.txt"), "utf8").trim();
  return;
  throw new Error("server did not start");
});

after(async () => {
  server?.kill();
  await rm(dir, { recursive: true, force: true });
});

let OWNER = "";
const f = (url, opts = {}) => {
  const h = opts.headers || {};
  const asSomeoneElse = h.Cookie || h["X-Forwarded-For"] || h.noOwner;
  const { noOwner, ...headers } = h;
  return fetch(url, { ...opts, headers: { ...(asSomeoneElse ? {} : { Cookie: OWNER }), ...headers } });
};
const asStranger = { "X-Forwarded-For": "203.0.113.9" }; // looks like a request through a tunnel

test("owner on this machine has full access", async () => {
  const cfg = await (await f(BASE + "/api/config")).json();
  assert.equal(cfg.role, "owner");
  const list = await (await f(BASE + "/api/projects")).json();
  assert.deepEqual(list.projects.map((p) => p.slug), ["owner-shop"]);
});

test("strangers without an invite are locked out of the API", async () => {
  const cfg = await (await f(BASE + "/api/config", { headers: asStranger })).json();
  assert.equal(cfg.role, "none");
  assert.equal((await f(BASE + "/api/projects", { headers: asStranger })).status, 401);
  assert.equal((await f(BASE + "/api/invites", { headers: asStranger })).status, 401);
});

test("invite link makes a guest who sees only their own projects and quota", async () => {
  const inv = await (await f(BASE + "/api/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ton", limit: 5000 }) })).json();
  const open = await f(`${BASE}/i/${inv.code}`, { headers: asStranger, redirect: "manual" });
  assert.equal(open.status, 302);
  const cookie = open.headers.get("set-cookie").split(";")[0];
  const guest = { ...asStranger, Cookie: cookie };

  const cfg = await (await f(BASE + "/api/config", { headers: guest })).json();
  assert.equal(cfg.role, "guest");
  assert.equal(cfg.userName, "Ton");
  assert.equal(cfg.usage.limit, 5000);
  assert.equal(cfg.usage.used, 0);
  assert.equal(cfg.localClaude.available, false, "guests never get the owner's Claude login");

  const list = await (await f(BASE + "/api/projects", { headers: guest })).json();
  assert.deepEqual(list.projects, []);
  assert.equal((await f(BASE + "/api/projects/owner-shop", { headers: guest })).status, 404);
  assert.equal((await f(BASE + "/api/invites", { headers: guest })).status, 403);
  assert.equal((await f(BASE + "/api/usage/reset", { method: "POST", headers: { ...guest, "Content-Type": "application/json" }, body: "{}" })).status, 403);

  // No API key set for friends yet: starting a job is refused with a clear message.
  const job = await f(BASE + "/api/jobs", { method: "POST", headers: { ...guest, "Content-Type": "application/json" }, body: JSON.stringify({ task: "x" }) });
  assert.equal(job.status, 400);

  // Revoked links stop working.
  await f(`${BASE}/api/invites/${inv.code}`, { method: "DELETE" });
  const after = await (await f(BASE + "/api/config", { headers: guest })).json();
  assert.equal(after.role, "none");
});

test("a friend invited into a project can open it but not delete it; the owner can delete", async () => {
  const json = { "Content-Type": "application/json" };
  await mkdir(path.join(dir, "projects", "team-shop"), { recursive: true });
  await writeFile(path.join(dir, "projects", "team-shop", ".agent-office.json"), JSON.stringify({ slug: "team-shop", name: "team-shop", owner: "owner", jobs: [] }));
  const inv = await (await f(BASE + "/api/invites", { method: "POST", headers: json, body: JSON.stringify({ name: "Ploy", limit: 5000 }) })).json();
  const open = await f(`${BASE}/i/${inv.code}?p=team-shop`, { headers: asStranger, redirect: "manual" });
  assert.equal(open.headers.get("location"), "/#p=team-shop");
  const guest = { ...asStranger, Cookie: open.headers.get("set-cookie").split(";")[0] };

  assert.equal((await f(BASE + "/api/projects/team-shop", { headers: guest })).status, 404, "not shared yet");
  const add = await f(BASE + "/api/projects/team-shop/members", { method: "POST", headers: json, body: JSON.stringify({ code: inv.code, add: true }) });
  assert.deepEqual((await add.json()).members, [`guest:${inv.code}`]);

  assert.equal((await f(BASE + "/api/projects/team-shop", { headers: guest })).status, 200);
  const list = await (await f(BASE + "/api/projects", { headers: guest })).json();
  assert.deepEqual(list.projects.map((p) => p.slug), ["team-shop"]);
  assert.equal((await f(BASE + "/api/projects/team-shop/members", { method: "POST", headers: { ...guest, ...json }, body: JSON.stringify({ code: inv.code }) })).status, 403, "friends cannot invite others");
  assert.equal((await f(BASE + "/api/projects/team-shop", { method: "DELETE", headers: guest })).status, 403);

  assert.equal((await f(BASE + "/api/projects/team-shop", { method: "DELETE" })).status, 200);
  assert.equal((await f(BASE + "/api/projects/team-shop")).status, 404);
});

test("friends in a project can invite several more people out of their own quota", async () => {
  const json = { "Content-Type": "application/json" };
  await mkdir(path.join(dir, "projects", "club-site"), { recursive: true });
  await writeFile(path.join(dir, "projects", "club-site", ".agent-office.json"), JSON.stringify({ slug: "club-site", name: "club-site", owner: "owner", jobs: [] }));
  const first = await (await f(BASE + "/api/projects/club-site/invite", { method: "POST", headers: json, body: JSON.stringify({ names: "Ton", limit: 30000 }) })).json();
  const tonCode = first.created[0].code;
  const login = async (code) => {
    const r = await f(`${BASE}/i/${code}?p=club-site`, { headers: asStranger, redirect: "manual" });
    return { ...asStranger, Cookie: r.headers.get("set-cookie").split(";")[0] };
  };
  const ton = await login(tonCode);

  const res = await (await f(BASE + "/api/projects/club-site/invite", { method: "POST", headers: { ...ton, ...json }, body: JSON.stringify({ names: "Ploy, Mint", limit: 10000 }) })).json();
  assert.deepEqual(res.created.map((c) => c.name), ["Ploy", "Mint"]);
  const tonCfg = await (await f(BASE + "/api/config", { headers: ton })).json();
  assert.equal(tonCfg.usage.limit, 10000, "30k minus 2 x 10k given away");

  // Asking for more than is left gives only what remains, then stops.
  const greedy = await f(BASE + "/api/projects/club-site/invite", { method: "POST", headers: { ...ton, ...json }, body: JSON.stringify({ names: "A, B", limit: 10000 }) });
  assert.equal(greedy.status, 207);
  assert.deepEqual((await greedy.json()).created.map((c) => c.name), ["A"]);

  const mint = await login(res.created[1].code);
  assert.equal((await f(BASE + "/api/projects/club-site", { headers: mint })).status, 200);
  const seenByMint = await (await f(BASE + "/api/projects/club-site/members", { headers: mint })).json();
  assert.ok(seenByMint.members.some((m) => m.name === "Ton"));
  assert.ok(seenByMint.members.every((m) => m.code === undefined), "Mint cannot see anyone's invite code");
  const seenByTon = await (await f(BASE + "/api/projects/club-site/members", { headers: ton })).json();
  assert.ok(seenByTon.members.find((m) => m.name === "Ploy").code, "Ton sees the links Ton created");
});

test("demo links stay public", async () => {
  const res = await f(BASE + "/p/owner-shop/", { headers: asStranger });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
});

test("this machine alone is not the owner: the owner token is required", async () => {
  const cfg = await (await f(BASE + "/api/config", { headers: { noOwner: "1" } })).json();
  assert.equal(cfg.role, "none");
  assert.equal(cfg.onThisMachine, true);
  assert.equal((await f(BASE + "/api/projects", { headers: { noOwner: "1" } })).status, 401);
  assert.equal((await f(BASE + "/owner?token=wrong", { headers: { noOwner: "1" }, redirect: "manual" })).status, 403);
  const ok = await f(BASE + "/owner?token=" + OWNER.split("=")[1], { headers: { noOwner: "1" }, redirect: "manual" });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("set-cookie"), /ao_owner=/);
});

test("pages from another origin cannot make Agent Office do things", async () => {
  const r = await f(BASE + "/api/usage/reset", { method: "POST", headers: { Origin: "http://localhost:4100", "Content-Type": "text/plain" } });
  assert.equal(r.status, 403);
  const r2 = await f(BASE + "/api/usage/reset", { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } });
  assert.equal(r2.status, 403);
  const same = await f(BASE + "/api/usage/reset", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(same.status, 200);
});

test("a project runs as its own website on its own port", { timeout: 30_000 }, async () => {
  const st = await (await f(BASE + "/api/projects/owner-shop/app")).json();
  assert.equal(st.running, true, JSON.stringify(st));
  assert.notEqual(st.port, PORT);
  const page = await fetch(`http://127.0.0.1:${st.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /hi/);
  const hidden = await fetch(`http://127.0.0.1:${st.port}/.agent-office.json`);
  assert.equal(hidden.status, 404, "project metadata is not served");
  const redirect = await f(BASE + "/p/owner-shop/", { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get("location"), new RegExp(":" + st.port + "/$"));
});
