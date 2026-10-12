// "Edit only part": Archie picks only the people needed and they change only that part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../src/orchestrator.js";

const CALC = `(function (root, factory) { var api = factory(); if (typeof module === "object" && module.exports) { module.exports = api; } else { root.Calc = api; } })(typeof self !== "undefined" ? self : this, function () {
  return { add: function (a, b) { return a + b; } };
});
`;
const PROJECT = {
  "index.html": `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>เครื่องคิดเลข</title><link rel="stylesheet" href="css/style.css"></head><body><h1>เครื่องคิดเลข</h1><script src="js/calc.js"></script></body></html>\n`,
  "css/style.css": "body { font-family: sans-serif; }\n",
  "js/calc.js": CALC,
  "tests/calc.test.js": `const Calc = require("../js/calc.js");\ntest("บวกเลข", () => { assert.equal(Calc.add(2, 3), 5); });\n`,
};

class Script {
  constructor(replies) { this.replies = replies; this.model = "scripted"; this.steps = []; this.prompts = {}; }
  async call({ step, prompt }) {
    this.steps.push(step);
    this.prompts[step] = prompt;
    const text = this.replies[step];
    if (text == null) throw new Error(`no script for ${step}`);
    return { text, usage: { input: 5, output: 5 } };
  }
}

const run = (llm, task, extra = {}) => {
  const events = [];
  return runJob({ input: { task, files: { ...PROJECT }, ...extra }, llm, emit: (e) => events.push(e), signal: new AbortController().signal })
    .then((r) => ({ ...r, events }));
};

test("a small change: only Mia works, only the page changes, tests still run", { timeout: 60_000 }, async () => {
  const llm = new Script({
    route: `<say>แค่เปลี่ยนสีหัวข้อ Mia คนเดียวพอครับ</say><mode>quick</mode><reply>จะเปลี่ยนสีหัวข้อเป็นสีเขียว</reply><team>frontend</team><why>Mia: แก้ CSS\nคนอื่นไม่ต้อง เพราะไม่เปลี่ยนการทำงาน</why>
<work>{"tasks":[{"id":"X","title":"สีหัวข้อ","owner":"frontend","files":["css/style.css"],"details":"h1 สีเขียว"}]}</work>`,
    "edit:Q1": `<say>เปลี่ยนแล้วค่ะ</say><file path="css/style.css">body { font-family: sans-serif; }\nh1 { color: #2f7d62; }\n</file>`,
  });
  const { success, files, events } = await run(llm, "เปลี่ยนสีหัวข้อเป็นสีเขียว");
  assert.deepEqual(llm.steps, ["route", "edit:Q1"], "no spec, design, tests or review were written for a small change");
  const route = events.find((e) => e.type === "route");
  assert.equal(route.mode, "quick");
  assert.deepEqual(route.team, ["architect", "frontend"]);
  assert.match(files["css/style.css"], /#2f7d62/);
  assert.equal(files["index.html"], PROJECT["index.html"], "untouched files stay as they were");
  const done = events.find((e) => e.type === "done");
  assert.deepEqual(done.changed, ["css/style.css"]);
  assert.equal(done.quick, true);
  assert.equal(success, true);
  assert.ok(events.some((e) => e.type === "test" && e.ok), "the existing tests were run after the change");
});

test("a question is just answered, nothing is changed", async () => {
  const llm = new Script({ route: `<say>คำถามครับ</say><mode>answer</mode><reply>ฟังก์ชัน add อยู่ใน js/calc.js ครับ</reply><team></team>` });
  const { events } = await run(llm, "ฟังก์ชันบวกอยู่ไฟล์ไหน");
  assert.deepEqual(llm.steps, ["route"]);
  assert.ok(events.some((e) => e.type === "say" && /js\/calc\.js/.test(e.text)));
  assert.ok(!events.some((e) => e.type === "file" && e.by !== "client"), "no file was written");
  assert.equal(events.find((e) => e.type === "done").answer, true);
});

test("'edit only part' is never turned into a full rebuild", async () => {
  const llm = new Script({
    route: `<say>…</say><mode>full</mode><reply>แก้ปุ่ม</reply><team>frontend</team><work>{"tasks":[{"owner":"frontend","title":"ปุ่ม","files":["index.html"]}]}</work>`,
    "edit:Q1": `<say>ok</say><file path="index.html">${PROJECT["index.html"].replace("</h1>", "</h1><button>ล้าง</button>")}</file>`,
  });
  const { events } = await run(llm, "เพิ่มปุ่มล้าง", { mode: "quick", focus: ["index.html"] });
  assert.equal(events.find((e) => e.type === "route").mode, "quick");
  assert.ok(!llm.steps.includes("analyze") && !llm.steps.includes("plan"));
});

const ROUTE_CSS = `<say>…</say><mode>quick</mode><reply>เปลี่ยนสี</reply><team>frontend</team><work>{"tasks":[{"owner":"frontend","title":"สี","files":["css/style.css"]}]}</work>`;
const EDIT_CSS = `<say>ok</say><file path="css/style.css">h1 { color: navy; }\n</file>`;

test("a test that was already failing is not this change's job: no debugging, the user is told", { timeout: 60_000 }, async () => {
  const llm = new Script({ route: ROUTE_CSS, "edit:Q1": EDIT_CSS });
  const broken = { "tests/old.test.js": `test("ของเก่าที่พังอยู่แล้ว", () => { assert.equal(1, 2); });\n` };
  const events = [];
  const r = await runJob({ input: { task: "เปลี่ยนสีหัวข้อ", files: { ...PROJECT, ...broken } }, llm, emit: (e) => events.push(e), signal: new AbortController().signal });
  assert.deepEqual(llm.steps, ["route", "edit:Q1"], "Max was not called for the old failure");
  assert.equal(r.success, true);
  assert.ok(events.some((e) => e.type === "say" && /พังอยู่ก่อนแล้ว/.test(e.text)));
});

test("whoever fixes a failure is shown the module the failing test loads", { timeout: 60_000 }, async () => {
  const llm = new Script({
    route: `<say>…</say><mode>quick</mode><reply>ปรับ</reply><team>frontend</team><work>{"tasks":[{"owner":"frontend","title":"ปรับ","files":["index.html"]}]}</work>`,
    "edit:Q1": `<say>ok</say><file path="js/calc.js">${CALC.replace("a + b", "a - b")}</file>`,
    "debug:1": `<say>Ben แก้ด้วย</say><assign>backend</assign><analysis>add ผิด</analysis>`,
    "fix:backend:1": `<say>แก้แล้ว</say><file path="js/calc.js">${CALC}</file>`,
  });
  const { success } = await run(llm, "ปรับหน้าแรก");
  assert.match(llm.prompts["fix:backend:1"], /<file path="js\/calc\.js">/, "the fixer saw js/calc.js itself");
  assert.equal(success, true);
});

test("asking for the whole team skips the routing step", async () => {
  const llm = new Script({});
  await run(llm, "ทำใหม่ทั้งหมด", { mode: "full" }).catch(() => {});
  assert.equal(llm.steps[0], "analyze");
});
