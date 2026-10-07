// "Claude on this machine": runs the locally installed Claude Code CLI in print
// mode, so the team uses whatever account Claude Code is logged in with here
// (no API key needed). Each call is isolated: no tools, no MCP servers, no user
// hooks or plugins, no saved session.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";

function findBin() {
  if (process.env.CLAUDE_CODE_BIN) return process.env.CLAUDE_CODE_BIN;
  const candidates = [];
  if (IS_WIN) {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, ".local", "bin", "claude.exe"));
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, IS_WIN ? "claude.exe" : "claude"));
  }
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".local", "bin", "claude"), path.join(process.env.HOME, ".claude", "local", "claude"));
  return candidates.find((p) => existsSync(p)) || null;
}

let probe = null;
/** { available, bin, version } — checked once per server start. */
export function localClaudeInfo() {
  if (!probe) {
    probe = new Promise((resolve) => {
      const bin = findBin();
      if (!bin) return resolve({ available: false, bin: null, version: null });
      execFile(bin, ["--version"], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        resolve(err ? { available: false, bin, version: null } : { available: true, bin, version: String(stdout).trim() });
      });
    });
  }
  return probe;
}

const workDir = () => {
  const d = path.join(tmpdir(), "agent-office-claude-code");
  mkdirSync(d, { recursive: true });
  return d;
};

export class LocalClaudeLLM {
  constructor({ model, effort } = {}) {
    this.model = model || "claude-opus-5-5";
    this.effort = effort || "medium";
    this.label = "Claude ในเครื่องนี้";
  }

  async call({ system, prompt, onText, signal }) {
    const info = await localClaudeInfo();
    if (!info.available) throw new Error("ไม่พบ Claude Code ในเครื่องนี้ ติดตั้งด้วย npm i -g @anthropic-ai/claude-code หรือใช้ API key แทน");
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--tools", "", "--no-session-persistence", "--setting-sources", "local", "--strict-mcp-config",
      "--model", this.model, ...(/haiku/.test(this.model) ? [] : ["--effort", this.effort]),
      "--system-prompt", system,
    ];
    return new Promise((resolve, reject) => {
      // Drop API credentials so Claude Code uses the account logged in on this machine.
      const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "agent-office" };
      for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[k];
      const child = spawn(info.bin, args, { cwd: workDir(), windowsHide: true, env });
      let buf = "", streamed = "", result = null, stderr = "";
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
            streamed += ev.event.delta.text;
            onText?.(ev.event.delta.text);
          } else if (ev.type === "result") {
            result = ev;
          }
        }
      });
      child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
      child.on("error", (err) => reject(err));
      child.on("close", () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return reject(new Error("Cancelled"));
        if (!result) return reject(new Error(`Claude Code หยุดทำงานก่อนตอบ ${stderr.slice(0, 300)}`));
        if (result.is_error) {
          const msg = String(result.result || result.subtype || "error");
          if (result.api_error_status === 401 || /authenticat|log ?in|expired/i.test(msg)) {
            return reject(new Error("Claude Code ในเครื่องยังไม่ได้ล็อกอิน หรือล็อกอินหมดอายุ: เปิด terminal พิมพ์ claude แล้วใช้คำสั่ง /login จากนั้นลองใหม่"));
          }
          return reject(new Error(`Claude Code: ${msg.slice(0, 400)}`));
        }
        const u = result.usage || {};
        resolve({
          text: typeof result.result === "string" && result.result ? result.result : streamed,
          usage: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 },
        });
      });
      child.stdin.end(prompt);
    });
  }

  /** JSON reply for the brief interview (the CLI has no schema option, so ask and parse). */
  async json({ system, prompt, schema }) {
    const res = await this.call({
      system: `${system}\n\nReply with a single JSON object only, no prose, no code fences. It must match this JSON Schema:\n${JSON.stringify(schema)}`,
      prompt,
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Claude Code ตอบกลับไม่ใช่ JSON");
    return { data: JSON.parse(m[0]), usage: res.usage };
  }
}
