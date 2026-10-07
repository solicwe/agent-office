import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "agent-office-projects-"));
process.env.PROJECTS_DIR = dir;
const P = await import("../src/projects.js");

test.after(() => rm(dir, { recursive: true, force: true }));

test("slugify keeps Thai and latin, drops symbols", () => {
  assert.equal(P.slugify("My Shop!! 2026"), "my-shop-2026");
  assert.equal(P.slugify("ร้านค้า ออนไลน์"), "ร้านค้า-ออนไลน์");
  assert.equal(P.slugify("../../"), "project");
  assert.equal(P.isSlug("../x"), false);
});

test("projects get unique folders and round-trip files", async () => {
  const a = await P.createProject("shop", { task: "t" });
  const b = await P.createProject("shop", { task: "t" });
  assert.equal(a.slug, "shop");
  assert.equal(b.slug, "shop-2");
  await P.writeProjectFile("shop", "js/app.js", "x");
  await P.writeProjectFile("shop", "index.html", "<h1>hi</h1>");
  assert.deepEqual(await P.loadProjectFiles("shop"), { "index.html": "<h1>hi</h1>", "js/app.js": "x" });
  await P.saveMeta("shop", { status: "passed" });
  const list = await P.listProjects();
  assert.equal(list.find((p) => p.slug === "shop").status, "passed");
});

test("writes cannot escape the project folder", async () => {
  await P.writeProjectFile("shop", "../../evil.txt", "x");
  assert.ok(Object.keys(await P.loadProjectFiles("shop")).includes("evil.txt"), "path is clamped inside the project");
  await assert.rejects(() => P.writeProjectFile("../shop", "a.txt", "x"));
});
