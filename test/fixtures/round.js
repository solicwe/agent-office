// One realistic Claude Code round as hook payloads: the user asks, Claude hands a
// page fix to the frontend role, Mia edits a file, then Claude answers.
import { writeFileSync } from "node:fs";
import path from "node:path";

export function makeRound(dir, sid = "sess-1") {
  const main = path.join(dir, "main.jsonl");
  const sub = path.join(dir, "sub.jsonl");
  writeFileSync(main, [
    { type: "user", message: { role: "user", content: "ปุ่มสั่งซื้อกดไม่ได้" } },
    { type: "assistant", message: { id: "m1", model: "claude-test", content: [{ type: "text", text: "เป็นปัญหาหน้าเว็บ ให้ Mia (frontend) แก้ ไม่ต้องใช้ backend" }], usage: { input_tokens: 1200, output_tokens: 80 } } },
    { type: "assistant", message: { id: "m1", model: "claude-test", content: [{ type: "tool_use", id: "tu1", name: "Agent", input: {} }], usage: { input_tokens: 1200, output_tokens: 80 } } },
    { type: "assistant", message: { id: "m2", model: "claude-test", content: [{ type: "text", text: "แก้เรียบร้อย" }], usage: { input_tokens: 1500, output_tokens: 40, cache_read_input_tokens: 900 } } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(sub, JSON.stringify({ type: "assistant", message: { id: "s1", content: [{ type: "text", text: "done" }], usage: { input_tokens: 700, output_tokens: 300 } } }) + "\n");

  const base = { session_id: sid, transcript_path: main, cwd: dir };
  return [
    { ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-test" },
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "ปุ่มสั่งซื้อกดไม่ได้" },
    { ...base, hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tu1", tool_input: { subagent_type: "frontend", description: "แก้ปุ่มสั่งซื้อ", prompt: "ปุ่มใน cart.html ไม่ทำงาน แก้ให้กดได้" } },
    { ...base, hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "frontend" },
    { ...base, hook_event_name: "PreToolUse", agent_id: "a1", agent_type: "frontend", tool_name: "Edit", tool_use_id: "tu2", tool_input: { file_path: "/x/public/cart.html", old_string: "a", new_string: "b" } },
    { ...base, hook_event_name: "PostToolUse", agent_id: "a1", agent_type: "frontend", tool_name: "Edit", tool_use_id: "tu2", tool_input: {}, tool_response: { success: true } },
    { ...base, hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "frontend", agent_transcript_path: sub, last_assistant_message: "แก้ onclick ใน cart.html แล้ว" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "tu1", tool_input: { subagent_type: "frontend" }, tool_response: { content: [{ type: "text", text: "แก้ onclick ใน cart.html แล้ว" }] } },
    { ...base, hook_event_name: "Stop", last_assistant_message: "แก้เรียบร้อย ปุ่มสั่งซื้อกดได้แล้ว" },
  ];
}
