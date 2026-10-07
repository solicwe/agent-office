import Anthropic from "@anthropic-ai/sdk";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", price: [4, 20], effort: true, fallbacks: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: [2, 10], effort: true, fallbacks: true },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", price: [10, 50], effort: true, fallbacks: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", price: [1, 5], effort: false, fallbacks: false },
];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const USE_FALLBACKS = process.env.CLAUDE_FALLBACKS !== "off";

export function serverHasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Real agents: every call is one streamed Claude request. */
export class ClaudeLLM {
  constructor({ apiKey, model, effort } = {}) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.spec = MODELS.find((m) => m.id === model) || MODELS.find((m) => m.id === DEFAULT_MODEL) || MODELS[0];
    this.model = this.spec.id;
    this.effort = EFFORTS.includes(effort) ? effort : "medium";
  }

  async call({ system, prompt, onText, signal }) {
    const params = {
      model: this.model,
      max_tokens: 64000,
      system,
      messages: [{ role: "user", content: prompt }],
    };
    if (this.spec.effort) params.output_config = { effort: this.effort };
    if (USE_FALLBACKS && this.spec.fallbacks) {
      // If a safety classifier declines, the API continues on a fallback model.
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const stream = this.client.beta.messages.stream(params, { signal });
    stream.on("text", (delta) => onText?.(delta));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      const why = msg.stop_details?.explanation || msg.stop_details?.category || "no details";
      throw new Error(`Claude ปฏิเสธคำขอนี้ (${why})`);
    }
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (msg.stop_reason === "max_tokens") throw new Error("คำตอบยาวเกิน max_tokens ลองแบ่งงานให้เล็กลง");
    return { text, usage: { input: msg.usage.input_tokens || 0, output: msg.usage.output_tokens || 0 } };
  }

  /** One short structured-output request (used by the brief interview). */
  async json({ system, prompt, schema }) {
    const params = {
      model: this.model,
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema }, ...(this.spec.effort ? { effort: "low" } : {}) },
    };
    if (USE_FALLBACKS && this.spec.fallbacks) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const msg = await this.client.beta.messages.create(params);
    if (msg.stop_reason === "refusal") throw new Error("Claude ปฏิเสธคำขอนี้");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { data: JSON.parse(text), usage: { input: msg.usage.input_tokens || 0, output: msg.usage.output_tokens || 0 } };
  }
}

// ---------- SWU AI (Srinakharinwirot University) gateway ----------
// It speaks the Claude Messages API at <base>/v1/messages with a Bearer token,
// and serves models such as "anthropic/claude-sonnet-5" or "google/gemini-2.5-flash".
export const SWU_BASE_URL = (process.env.SWU_BASE_URL || "https://swuai.swu.ac.th/swu/api/service").replace(/\/+$/, "");

function swuClient(token) {
  // apiKey: null so the owner's ANTHROPIC_API_KEY is never sent to the gateway.
  return new Anthropic({ baseURL: SWU_BASE_URL, authToken: token, apiKey: null, maxRetries: 2 });
}

export class SwuLLM {
  constructor({ token, model }) {
    if (!token) throw new Error("ยังไม่ได้ใส่ SWU API key ในหน้าตั้งค่า");
    this.client = swuClient(token);
    this.model = model || process.env.SWU_MODEL || "anthropic/claude-sonnet-5.5";
    this.effort = null;
  }

  // Gateway-compatible request: no beta features, effort or structured outputs.
  async call({ system, prompt, onText, signal }) {
    const stream = this.client.messages.stream({ model: this.model, max_tokens: 32000, system, messages: [{ role: "user", content: prompt }] }, { signal });
    stream.on("text", (delta) => onText?.(delta));
    const msg = await stream.finalMessage();
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (msg.stop_reason === "max_tokens") throw new Error("คำตอบยาวเกิน max_tokens ลองแบ่งงานให้เล็กลง");
    if (!text) throw new Error(`SWU AI ไม่ได้ตอบข้อความกลับมา (stop_reason: ${msg.stop_reason})`);
    return { text, usage: { input: msg.usage?.input_tokens || 0, output: msg.usage?.output_tokens || 0 } };
  }

  async json({ system, prompt, schema }) {
    const res = await this.call({
      system: `${system}\n\nReply with a single JSON object only, no prose, no code fences. It must match this JSON Schema:\n${JSON.stringify(schema)}`,
      prompt,
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("SWU AI ตอบกลับไม่ใช่ JSON");
    return { data: JSON.parse(m[0]), usage: res.usage };
  }
}

/** Models this SWU key may use (the gateway's model-discovery endpoint). */
export async function swuModels(token) {
  const res = await fetch(`${SWU_BASE_URL}/v1/models`, { headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" } });
  if (!res.ok) throw new Error(`SWU AI ตอบกลับ ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.data || body.models || [];
  return list.map((m) => (typeof m === "string" ? { id: m, label: m } : { id: m.id || m.model || m.name, label: m.display_name || m.name || m.id })).filter((m) => m.id);
}
