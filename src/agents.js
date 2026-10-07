// Team roster + role prompts. The roles follow the MetaGPT / ChatDev "software
// company" pattern, split into frontend/backend engineers so large jobs (for
// example a whole e-commerce site) can be built in parallel tasks.
import { digest, tree } from "./workspace.js";

export const AGENTS = {
  pm: { name: "Nina", role: "Product Manager", th: "ผู้จัดการผลิตภัณฑ์" },
  architect: { name: "Archie", role: "Tech Lead / Architect", th: "สถาปนิกระบบ" },
  frontend: { name: "Mia", role: "Frontend Engineer", th: "นักพัฒนาหน้าเว็บ" },
  backend: { name: "Ben", role: "Backend Engineer", th: "นักพัฒนาระบบหลังบ้าน" },
  qa: { name: "Tessa", role: "QA Engineer", th: "ผู้ทดสอบระบบ" },
  debugger: { name: "Max", role: "Debugger", th: "นักแก้บั๊ก" },
  reviewer: { name: "Rex", role: "Code Reviewer", th: "ผู้ตรวจโค้ด" },
};

const TEAM_CONTEXT = `You work in "Agent Office", a software team made of AI agents:
- Nina (Product Manager): turns the client's request into a spec with user stories and acceptance criteria; signs off at the end.
- Archie (Tech Lead / Architect): designs the file structure and splits the work into tasks for Mia and Ben.
- Mia (Frontend Engineer): HTML, CSS and UI scripts.
- Ben (Backend Engineer): data, business logic, storage/API layer, and a Node server when one is truly needed.
- Tessa (QA Engineer): writes automated tests and runs them in the QA lab.
- Max (Debugger): reads failing results, finds root causes, tells the right person what to change.
- Rex (Code Reviewer): reviews the finished project for bugs, security and spec gaps.

Project rules (the QA lab and the live preview depend on them):
- The deliverable is a folder of files. Paths are relative, forward slashes, no leading slash.
- Web projects are static and need no build step: index.html at the root, CSS in css/, scripts in js/. Use plain <script src="..."> tags (no ES modules, no bundlers, no frameworks, no CDN scripts). Relative links only.
- Business logic (cart, pricing, validation, filtering, state) lives in its own files that touch no DOM, written as dual-export modules so the same file works in the browser and in Node tests:
  (function (root, factory) { var api = factory(); if (typeof module === "object" && module.exports) { module.exports = api; } else { root.NAME = api; } })(typeof self !== "undefined" ? self : this, function () { /* ... */ return { /* public API */ }; });
- Persistence in the browser uses localStorage behind a small storage/API module that returns Promises, so a real backend can replace it later.
- Only if the client explicitly needs a server, put it in server/ using node:http with no npm packages (it is not run in the preview).
- Non-web programs and libraries: CommonJS files in src/ (module.exports).
- Tests: tests/*.test.js, CommonJS, e.g. const Cart = require("../js/cart.js"); the globals test(name, fn) and assert (node:assert/strict) already exist. Tests must not touch the DOM or the network.
- Write complete, working files. No placeholders like "TODO" or "rest of code here".
- UI text in Thai unless the client asks otherwise. Clean, simple visual design; no emoji in the UI.

Reply format (strict):
1. Start with <say>...</say>: 1-3 short sentences IN THAI, spoken to teammates like a real office chat. Be specific.
2. Then only the output tags your task asks for. Files are written as <file path="relative/path">full file content</file>. No markdown code fences inside tags.`;

const ROLE_PROMPTS = {
  pm: `You are Nina, the Product Manager. Think about what the client actually needs, the edge cases they forgot, and how the team will know the job is done. Keep scope realistic for one delivery. Write documents in Thai.`,
  architect: `You are Archie, the Tech Lead. Keep designs small, testable and consistent. Name exact module names, global names, function signatures, data shapes and DOM ids so Mia, Ben and Tessa build against one contract. Write documents in Thai, identifiers in English.`,
  frontend: `You are Mia, the Frontend Engineer. You build clean, responsive, accessible pages in plain HTML/CSS/JS that use the logic modules exactly as the design describes. Simple and tidy visual design.`,
  backend: `You are Ben, the Backend Engineer. You write correct, dependency-free logic, data and storage modules that follow the design contract exactly, validate input, and are easy to test.`,
  qa: `You are Tessa, the QA Engineer. You test against the spec and the design contract, not the implementation's quirks. Cover normal cases, edge cases and invalid input. One behaviour per test, descriptive names (Thai is fine).`,
  debugger: `You are Max, the Debugger. Reproduce each failure mentally, find the root cause, and decide who must fix it: frontend (Mia), backend (Ben) or qa (Tessa, when a test contradicts the spec). Write the analysis in Thai with precise instructions.`,
  reviewer: `You are Rex, the Code Reviewer. Only block for real problems: bugs, spec violations, broken pages, security issues (e.g. unescaped user input in innerHTML), missing required behaviour. Style nits never block. Write the review in Thai.`,
};

export function systemPrompt(agentId) {
  return `${TEAM_CONTEXT}\n\n${ROLE_PROMPTS[agentId]}`;
}

const block = (label, body) => `<${label}>\n${body || "(none)"}\n</${label}>`;

export const PROMPTS = {
  analyze: ({ task, files }) => `The client sent this request:
${block("request", task)}
${Object.keys(files).length ? `They attached an existing project that must be modified, not rewritten:\n${block("existing_files", digest(files, [], 80_000))}\n` : ""}
Write the requirement spec. Output:
<say>…</say>
<spec>Thai markdown: goal, users, main features as user stories, business rules, edge cases, out of scope, and 5-12 numbered acceptance criteria.</spec>`,

  plan: ({ task, spec, files }) => `${block("request", task)}
${block("spec", spec)}
${block("current_files", tree(files))}
Design the project and split the work. Output:
<say>…</say>
<design>Thai markdown: architecture, file structure, every module's public API (global name, functions, parameters, return values, errors), data shapes, page layout with DOM ids, and notes for the tester.</design>
<plan>JSON only: {"tasks":[{"id":"T1","title":"…","owner":"backend"|"frontend","files":["path", …],"depends":["T…"],"details":"what exactly to build"}]}</plan>
Rules for the plan: 2-10 tasks; each task owns 1-4 files and every file belongs to exactly one task; logic/data/storage files go to backend, pages/styles/UI scripts to frontend; use depends only when a task truly needs another task's files; do not create test files (Tessa writes those).`,

  implement: ({ spec, design, planText, files, task, focus }) => `${block("spec", spec)}
${block("design", design)}
${block("plan", planText)}
${block("project_files", digest(files, focus))}
Your task ${task.id}: ${task.title}
${task.details || ""}
Files you own in this task: ${task.files.join(", ")}
Output:
<say>…</say>
then one <file path="…">…</file> for each file you own in this task (full contents).`,

  tests: ({ spec, design, files }) => `${block("spec", spec)}
${block("design", design)}
${block("project_files", digest(files))}
Write automated tests for the logic/data modules (not the DOM), mapped to the acceptance criteria. 8-25 tests across 1-4 files in tests/. Output:
<say>…</say>
then <file path="tests/….test.js">…</file> blocks.`,

  debug: ({ spec, design, files, report, focus }) => `The QA lab reports failures.
${block("spec", spec)}
${block("design", design)}
${block("test_report", report)}
${block("project_files", digest(files, focus))}
Find the root causes. Output:
<say>…</say>
<assign>comma-separated owners who must fix something: frontend, backend, qa</assign>
<analysis>Thai markdown: each failure, root cause, which files to change, exact fix instructions per owner.</analysis>`,

  fix: ({ spec, design, files, report, analysis, owner, focus }) => `Max analysed the failures and assigned work to you (${owner}).
${block("spec", spec)}
${block("design", design)}
${block("test_report", report)}
${block("debugger_analysis", analysis)}
${block("project_files", digest(files, focus))}
Fix only what is assigned to you. Output:
<say>…</say>
then <file path="…">…</file> for every file you change (full contents). Do not output unchanged files.`,

  review: ({ spec, design, files, report }) => `All automated checks pass. Review the finished project.
${block("spec", spec)}
${block("design", design)}
${block("test_report", report)}
${block("project_files", digest(files))}
Output:
<say>…</say>
<verdict>APPROVE</verdict> or <verdict>CHANGES</verdict>
<review>Thai markdown: strengths; issues, each marked [blocking] or [minor] with file and owner.</review>
<frontend>blocking issues for Mia, or empty</frontend>
<backend>blocking issues for Ben, or empty</backend>`,

  revise: ({ spec, design, files, review, issues, owner, focus }) => `Rex requested changes in code review. You are ${owner}.
${block("spec", spec)}
${block("design", design)}
${block("review", review)}
${block("your_issues", issues)}
${block("project_files", digest(files, focus))}
Fix every blocking issue assigned to you. Output:
<say>…</say>
then <file path="…">…</file> for every file you change (full contents).`,

  final: ({ task, spec, files, report, review, success }) => `${success ? "The project passed all checks and code review." : "The team ran out of fix attempts; some checks still fail."}
${block("request", task)}
${block("spec", spec)}
${block("file_list", tree(files))}
${block("test_report", report)}
${block("review", review)}
Report to the client. Output:
<say>…</say>
<summary>Thai markdown for the client: what was built, file structure overview, how to run or open it, test results, known limitations and next steps.</summary>`,
};
