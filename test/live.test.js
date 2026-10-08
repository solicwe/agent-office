import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProject } from "../src/runner.js";

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "starter-kit");

function kitFiles() {
  const files = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = path.join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else files[path.relative(KIT, f).split(path.sep).join("/")] = readFileSync(f, "utf8");
    }
  };
  walk(KIT);
  return files;
}

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/style.css"></head><body>${body}<script src="/js/api.js"></script></body></html>`;

test("starter-kit app: server starts, every page opens, real login works", { timeout: 120_000 }, async () => {
  const files = {
    ...kitFiles(),
    "public/index.html": page('<a href="/login.html">เข้าสู่ระบบ</a> <a href="shop/list.html">สินค้า</a>'),
    "public/login.html": page('<a href="/">หน้าแรก</a>'),
    "public/shop/list.html": page('<a href="../index.html">กลับ</a>'),
    "public/css/style.css": "body { margin: 0 }",
  };
  const r = await runProject(files);
  const failed = r.results.filter((x) => !x.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 2) + "\n" + r.logs);
  assert.ok(r.results.some((x) => x.name.startsWith("web: เปิดได้ทุกหน้า (3 หน้า")), "crawled all 3 pages");
  assert.ok(r.results.filter((x) => x.kind === "test" && /auth\.test/.test(x.name)).length >= 4, "auth tests ran against the live server");
});

test("a broken link and a crashing server are reported", { timeout: 120_000 }, async () => {
  const broken = await runProject({ ...kitFiles(), "public/index.html": page('<a href="/nope.html">x</a>'), "public/css/style.css": "" });
  assert.ok(broken.results.some((x) => !x.ok && x.name === "web: /nope.html" && /404/.test(x.error)));

  const crash = await runProject({ "server.js": 'throw new Error("boom at startup")', "public/index.html": page("") });
  const s = crash.results.find((x) => x.name.startsWith("server:"));
  assert.equal(s.ok, false);
  assert.match(s.error, /boom at startup/);
});

test("an app server cannot write outside data/ or use sqlite", { timeout: 120_000 }, async () => {
  const r = await runProject({
    "server.js": `
      const http = require("node:http"); const fs = require("node:fs");
      let wrote = "blocked";
      try { fs.writeFileSync(__dirname + "/escape.txt", "x"); wrote = "allowed"; } catch {}
      let sqlite = "blocked";
      try { require("node:" + "sqlite"); sqlite = "allowed"; } catch {}
      http.createServer((q, s) => s.end(JSON.stringify({ wrote, sqlite }))).listen(process.env.PORT);`,
    "tests/sandbox.test.js": `test("limits", async () => { const r = await (await fetch(BASE_URL + "/x")).json(); assert.deepEqual(r, { wrote: "blocked", sqlite: "blocked" }); });`,
  });
  const t = r.results.find((x) => x.name.includes("limits"));
  assert.equal(t.ok, true, t.error);
});
