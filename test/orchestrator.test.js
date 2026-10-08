import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob, tag, parsePlan } from "../src/orchestrator.js";
import { runProject, staticChecks } from "../src/runner.js";
import { parseFiles, safePath, zip } from "../src/workspace.js";
import { ScriptedLLM } from "./fixtures/scripted-llm.js";
import { DEMO_TASK } from "./fixtures/demo-script.js";

test("demo e-commerce job: finds the cart bug, fixes it and passes", { timeout: 120_000 }, async () => {
  const events = [];
  const { files } = await runJob({
    input: { task: DEMO_TASK, files: {} },
    llm: new ScriptedLLM(),
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
  });
  const runs = events.filter((e) => e.type === "test");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].ok, false, "buggy first version must fail");
  assert.equal(runs[0].failed, 3);
  assert.equal(runs[1].ok, true, "fixed version must pass");
  assert.equal(runs[1].testCount, 19);
  const done = events.find((e) => e.type === "done");
  assert.equal(done.success, true);
  assert.equal(done.preview, true);
  assert.ok(files["index.html"] && files["js/cart.js"] && files["tests/cart.test.js"]);
  // T1 (backend) and T2 (frontend) ran in parallel: both started before either finished
  const taskEvents = events.filter((e) => e.type === "task").map((e) => `${e.id}:${e.state}`);
  assert.deepEqual(taskEvents.slice(0, 2).sort(), ["T1:active", "T2:active"]);
});

test("runner blocks child processes inside tests", async () => {
  const r = await runProject({
    "src/x.js": 'const cp = require("child_process"); module.exports = () => cp.execSync("echo hi").toString();',
    "tests/x.test.js": 'const run = require("../src/x.js"); test("spawn", () => { run(); });',
  });
  assert.equal(r.ok, false);
  assert.match(r.results.find((x) => x.kind === "test").error, /ERR_ACCESS_DENIED|permission/i);
});

test("runner times out infinite loops", { timeout: 90_000 }, async () => {
  const r = await runProject({ "tests/loop.test.js": "while (true) {}" });
  assert.equal(r.ok, false);
  assert.match(r.results[r.results.length - 1].error, /หมดเวลา/);
});

test("static checks catch syntax errors and broken links", () => {
  const r = staticChecks({
    "index.html": '<link href="css/a.css"><script src="js/missing.js"></script><a href="https://x.y">x</a>',
    "css/a.css": "",
    "js/bad.js": "function (",
  });
  assert.equal(r.find((x) => x.name === "links: index.html").ok, false);
  assert.match(r.find((x) => x.name === "links: index.html").error, /js\/missing\.js/);
  assert.equal(r.find((x) => x.name === "syntax: js/bad.js").ok, false);
});

test("parsers: files, plan, tags, paths, zip", () => {
  const f = parseFiles('<say>x</say><file path="./js/a.js">\n```js\nlet a = 1;\n```\n</file><file path="../../etc/passwd">x</file>');
  assert.deepEqual(f.map((x) => x.path), ["js/a.js", "etc/passwd"]);
  assert.equal(f[0].content, "let a = 1;\n");
  assert.equal(safePath("..\\..\\a/b.js"), "a/b.js");
  assert.equal(parsePlan("not json")[0].id, "T1");
  assert.equal(parsePlan('{"tasks":[{"id":"A","owner":"backend","files":["x.js"]}]}')[0].owner, "backend");
  assert.equal(tag("<say>hi</say><review>unterminated", "review"), "unterminated");
  assert.equal(zip({ "a.txt": "hello" }).readUInt32LE(0), 0x04034b50);
});
