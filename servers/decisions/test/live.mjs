// Manual live check: node test/live.mjs  (uses DECISIONS_* env; defaults to local LM Studio)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const c = new Client({ name: "live", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: [entry], env: process.env }));
const out = (r) => {
  if (r.isError) { console.log("tool error:", r.content[0].text); process.exit(1); }
  return JSON.parse(r.content[0].text);
};
console.log("models:", out(await c.callTool({ name: "list_decision_models", arguments: {} })).models.filter((m) => m.type === "decision").map((m) => m.id));
const r = await c.callTool({
  name: "decide",
  arguments: {
    input: "I was charged twice for my order last week and nobody has replied.",
    questions: [
      { type: "predicate", name: "angry", instructions: "Is the customer angry?" },
      { type: "choice", name: "route", instructions: "Which team?", choices: [{ value: "billing" }, { value: "shipping" }, { value: "other" }] },
      { type: "score", name: "urgency", instructions: "How urgent?", levels: [{ label: "can wait" }, { label: "today" }, { label: "right now" }] },
    ],
  },
});
console.log(r.isError ? "ERROR" : "", JSON.stringify(out(r).answers.map((a) => [a.name, a.probability ?? a.choice ?? a.score])), JSON.stringify(out(r).usage));
const bad = await c.callTool({ name: "decide", arguments: { input: "x", model: "qwen/qwen3.8-27b", questions: [{ type: "predicate", name: "a", instructions: "?" }] } });
console.log("bad model ->", bad.isError, bad.content[0].text.slice(0, 120));
await c.close();
