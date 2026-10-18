// Using the team in a friend's repository: attach adds roles + hooks for this machine
// only, nothing shows up in git, and detach puts the repository back exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { attach, detach } from "../scripts/attach.js";

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

function friendRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "friend-"));
  git(path.dirname(dir), "init", "-q", dir);
  git(dir, "config", "user.email", "f@example.com");
  git(dir, "config", "user.name", "Friend");
  mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), "<h1>friend</h1>\n");
  writeFileSync(path.join(dir, ".claude", "agents", "frontend.md"), "---\nname: frontend\ndescription: the friend's own frontend role\n---\nFriend's rules.\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2) + "\n");
  return dir;
}
const status = (dir) => git(dir, "status", "--porcelain", "--untracked-files=all");

test("attach: roles and hooks for this machine only, the repo's own role kept, nothing to commit", () => {
  const dir = friendRepo();
  const before = status(dir);
  const r = attach(dir, { port: 3123 });
  assert.equal(r.copied.length, 6);
  assert.deepEqual(r.skipped, ["frontend.md"], "the friend's own frontend role is not overwritten");
  assert.match(readFileSync(path.join(dir, ".claude", "agents", "frontend.md"), "utf8"), /Friend's rules/);
  assert.ok(existsSync(path.join(dir, ".claude", "agents", "reviewer.md")));
  const s = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"));
  assert.deepEqual(s.permissions, { allow: ["Bash(npm test)"] }, "existing personal settings kept");
  assert.equal(s.hooks.Stop[0].hooks[0].url, "http://127.0.0.1:3123/hooks");
  assert.equal(status(dir), before, "git sees nothing new to commit");
  attach(dir, { port: 3123 });
  const again = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"));
  assert.equal(again.hooks.Stop.length, 1, "attaching twice adds nothing twice");
});

test("detach: the repo is back to exactly how it was", () => {
  const dir = friendRepo();
  const settingsBefore = readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8");
  attach(dir);
  const r = detach(dir);
  assert.equal(r.removed.length, 6);
  assert.equal(readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"), settingsBefore);
  assert.match(readFileSync(path.join(dir, ".claude", "agents", "frontend.md"), "utf8"), /Friend's rules/);
  assert.ok(!existsSync(path.join(dir, ".claude", "agents", "reviewer.md")));
  assert.doesNotMatch(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /agent-office/);
  assert.equal(status(dir), "");
});

test("a copied role you edited after attaching is kept by detach", () => {
  const dir = friendRepo();
  attach(dir);
  const f = path.join(dir, ".claude", "agents", "qa.md");
  writeFileSync(f, readFileSync(f, "utf8") + "\nAlso check accessibility.\n");
  const r = detach(dir);
  assert.deepEqual(r.kept, ["qa.md"]);
  assert.ok(existsSync(f));
  assert.match(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /\.claude\/agents\/qa\.md/, "still never committed by accident");
});

test("a folder without any .claude settings is left with nothing after detach", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plain-"));
  attach(dir);
  detach(dir);
  assert.ok(!existsSync(path.join(dir, ".claude")));
});
