// Test double for ClaudeLLM: replays the scripted team replies in demo-script.js.
import { DEMO_SCRIPT } from "./demo-script.js";

export class ScriptedLLM {
  constructor() {
    this.model = "scripted";
  }

  async call({ step, onText }) {
    const text = DEMO_SCRIPT[step] ?? DEMO_SCRIPT[step.split(":").slice(0, 2).join(":")] ?? DEMO_SCRIPT[step.split(":")[0]];
    if (!text) throw new Error(`Script has no step "${step}"`);
    await new Promise((r) => setTimeout(r, 5));
    onText?.(text);
    return { text, usage: { input: 100, output: 50 } };
  }
}
