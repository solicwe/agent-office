// Turns Claude Code hook events into (1) audit entries and (2) visual events for the
// office. Nothing here calls an AI model: the cost of watching is zero tokens.
//
// Visual events: SESSION_START, ORCHESTRATOR_THINKING, AGENT_ASSIGNED, AGENT_WORKING,
// AGENT_HANDOFF, AGENT_DONE, TASK_COMPLETE.
import { createHash } from "node:crypto";
import { usageSince, reasoningBefore, estimateTokens } from "./transcript.js";

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const MAX_TEXT = 20_000; // longer outputs are cut in the log; their full sha256 is kept
const sha = (s) => createHash("sha256").update(String(s ?? "")).digest("hex");
const clip = (s, n = MAX_TEXT) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + `\n…[ตัดเหลือ ${n} ตัวอักษร จาก ${t.length}]` : t; };
const short = (s, n = 90) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** What a tool call is doing, in a few words, for the badge over a character. */
export function toolSummary(tool, input = {}) {
  const file = (p) => String(p || "").split(/[\\/]/).slice(-2).join("/");
  switch (tool) {
    case "Read": return `อ่าน ${file(input.file_path)}`;
    case "Write": return `เขียน ${file(input.file_path)}`;
    case "Edit": case "MultiEdit": return `แก้ ${file(input.file_path)}`;
    case "Bash": case "PowerShell": return `รัน ${short(input.command, 50)}`;
    case "Grep": return `ค้นหา "${short(input.pattern, 30)}"`;
    case "Glob": return `หาไฟล์ ${short(input.pattern, 30)}`;
    case "WebFetch": return `เปิดเว็บ ${short(input.url, 40)}`;
    case "WebSearch": return `ค้นเว็บ "${short(input.query, 30)}"`;
    case "TodoWrite": return "อัปเดตรายการงาน";
    default: return `ใช้ ${tool}`;
  }
}

/** Text out of a PostToolUse tool_response, whatever shape it has. */
function responseText(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return r.map(responseText).join("\n");
  if (Array.isArray(r.content)) return r.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n");
  if (typeof r.content === "string") return r.content;
  if (typeof r.result === "string") return r.result;
  if (typeof r.text === "string") return r.text;
  return JSON.stringify(r);
}

const addTokens = (a, b) => ({
  input: (a.input || 0) + (b.input || 0), output: (a.output || 0) + (b.output || 0),
  cache_read: (a.cache_read || 0) + (b.cache_read || 0), cache_write: (a.cache_write || 0) + (b.cache_write || 0),
});

export class Flow {
  /**
   * @param {{ audit: import('./audit.js').AuditLog, pool: () => {agents: object[]}, emit: (e: object) => void, onRoundEnd?: (sessionId: string) => void }} o
   */
  constructor({ audit, pool, emit, onRoundEnd = () => {} }) {
    this.audit = audit;
    this.pool = pool;
    this.emit = emit;
    this.onRoundEnd = onRoundEnd;
    this.sessions = new Map();
  }

  state(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { seen: new Set(), pending: new Map(), round: null });
    return this.sessions.get(id);
  }

  /** Which desk in the office an agent type sits at. */
  officeId(agentType) {
    if (!agentType) return "orchestrator";
    return this.pool().agents.some((a) => a.id === agentType) ? agentType : "helper";
  }

  handle(p) {
    const sid = String(p.session_id || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) return null;
    const s = this.state(sid);
    const ev = p.hook_event_name;
    const vis = (type, data) => this.emit({ type, session_id: sid, ...data });
    const log = (type, data) => this.audit.append(sid, type, data);

    switch (ev) {
      case "SessionStart":
        log("session_start", { source: p.source || null, model: p.model || null, cwd: p.cwd || null });
        vis("SESSION_START", {});
        return;

      case "UserPromptSubmit": {
        s.round = { started: Date.now(), agents: [], tokens: {} };
        log("user_prompt", { prompt: clip(p.prompt), prompt_sha256: sha(p.prompt) });
        vis("ORCHESTRATOR_THINKING", { text: short(p.prompt, 120) });
        return;
      }

      case "PreToolUse": {
        const input = p.tool_input || {};
        if (AGENT_TOOLS.has(p.tool_name)) {
          const type = input.subagent_type || "general-purpose";
          const desk = this.officeId(type);
          const def = this.pool().agents.find((a) => a.id === type);
          const parallel = s.pending.size > 0 || Boolean(input.run_in_background);
          s.pending.set(p.tool_use_id || `${type}:${Date.now()}`, { agent: type, desk, start: Date.now() });
          s.round?.agents.push(type);
          log("agent_assigned", {
            agent: type,
            md_file: def ? `.claude/agents/${def.file}` : null,
            md_sha256: def?.sha256 || null,
            built_in: !def,
            subtask: short(input.description, 200),
            input: clip(input.prompt),
            input_sha256: sha(input.prompt),
            execution: parallel ? "parallel" : "sequential",
            reasoning: clip(reasoningBefore(p.transcript_path, p.tool_use_id), 4000),
            tool_use_id: p.tool_use_id || null,
          });
          vis("AGENT_ASSIGNED", { from: "orchestrator", to: desk, agent: type, subtask: short(input.description, 80), parallel });
          return;
        }
        const actor = this.officeId(p.agent_type);
        const summary = toolSummary(p.tool_name, input);
        log("tool_call", { actor: p.agent_type || "orchestrator", tool: p.tool_name, summary, input_sha256: sha(JSON.stringify(input)), tool_use_id: p.tool_use_id || null });
        vis("AGENT_WORKING", { agent: actor, badge: summary, tool: p.tool_name });
        return;
      }

      case "PostToolUse": {
        if (!AGENT_TOOLS.has(p.tool_name)) return;
        const key = s.pending.has(p.tool_use_id) ? p.tool_use_id : s.pending.keys().next().value;
        const job = key !== undefined ? s.pending.get(key) : null;
        if (key !== undefined) s.pending.delete(key);
        const out = responseText(p.tool_response);
        log("agent_result", {
          agent: job?.agent || p.tool_input?.subagent_type || "general-purpose",
          output: clip(out),
          output_sha256: sha(out),
          duration_ms: job ? Date.now() - job.start : null,
          tool_use_id: p.tool_use_id || null,
        });
        vis("AGENT_HANDOFF", { from: job?.desk || "helper", to: "orchestrator", summary: short(out, 100) });
        return;
      }

      case "SubagentStart":
        log("agent_started", { agent: p.agent_type || null, agent_id: p.agent_id || null });
        vis("AGENT_WORKING", { agent: this.officeId(p.agent_type), badge: "เริ่มทำงาน" });
        return;

      case "SubagentStop": {
        const used = usageSince(p.agent_transcript_path, s.seen);
        const tokens = used.messages ? { ...used, source: "transcript" } : { output: estimateTokens(p.last_assistant_message), source: "estimate" };
        if (s.round) s.round.tokens = addTokens(s.round.tokens, tokens);
        log("agent_finished", { agent: p.agent_type || null, agent_id: p.agent_id || null, tokens, last_message: clip(p.last_assistant_message, 4000) });
        vis("AGENT_DONE", { agent: this.officeId(p.agent_type) });
        return;
      }

      case "Stop": {
        const used = usageSince(p.transcript_path, s.seen);
        const main = used.messages ? { ...used, source: "transcript" } : { output: estimateTokens(p.last_assistant_message), source: "estimate" };
        const round = s.round || { started: Date.now(), agents: [], tokens: {} };
        const total = addTokens(round.tokens, main);
        log("final_response", {
          text: clip(p.last_assistant_message),
          text_sha256: sha(p.last_assistant_message),
          agents_used: round.agents,
          agent_count: round.agents.length,
          duration_ms: Date.now() - round.started,
          tokens_orchestrator: main,
          tokens_round_total: total,
        });
        s.round = null;
        s.pending.clear();
        vis("TASK_COMPLETE", { summary: short(p.last_assistant_message, 160), agents: round.agents.length, tokens: total.input + total.output });
        this.onRoundEnd(sid);
        return;
      }

      case "SessionEnd":
        log("session_end", { reason: p.reason || null });
        return;
    }
    return null;
  }
}
