import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionsClient } from "./client.js";

const name = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, _ and - only")
  .describe("Unique id for this question; the answer carries the same name");

const question = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("predicate").describe("Yes/no (true/false) question"),
      name,
      instructions: z
        .string()
        .min(1)
        .describe("A statement or yes/no question about the input, e.g. 'Is the customer angry?'. Answer is the probability it is true."),
    })
    .describe("Yes/no question. Answer: `probability` 0-1 that the answer is yes/true."),
  z
    .object({
      type: z.literal("choice").describe("Pick exactly one option"),
      name,
      instructions: z.string().min(1).describe("What to decide, e.g. 'Which team should handle this?'"),
      choices: z
        .array(
          z.object({
            value: z.string().min(1).describe("The option's id, returned in the answer"),
            description: z.string().optional().describe("What this option means; helps the model pick accurately"),
          }),
        )
        .min(2)
        .max(255)
        .describe("2-255 mutually exclusive options. Add a fallback such as 'other' so nothing is forced into a bad fit."),
    })
    .describe("Pick-one question. Answer: `choice` (most likely option), `probabilities` per option (sum to 1), `confidence`."),
  z
    .object({
      type: z.literal("score").describe("Rate on an ordered scale"),
      name,
      instructions: z.string().min(1).describe("What to rate, e.g. 'How urgent is this?'"),
      levels: z
        .array(
          z.object({
            label: z.string().min(1).describe("Short name of the level"),
            description: z.string().optional().describe("What this level means"),
          }),
        )
        .min(2)
        .max(10)
        .describe("2-10 levels ordered lowest to highest. The first is index 0."),
    })
    .describe(
      "Ordered-scale question. Answer: `score` = probability-weighted level index (0-based, may fall between levels), `probabilities` per level, `confidence`.",
    ),
]);

const inputPart = z.union([
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({ type: z.literal("input_image"), image_url: z.string().startsWith("data:image/").describe("Inline base64 data URL") }),
]);
const input = z.union([
  z.string().min(1),
  z.array(z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(inputPart)]) })).min(1),
]);

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: "text" as const, text: m }] });

export function createServer(client: DecisionsClient): McpServer {
  const server = new McpServer({ name: "decisions", version: "0.1.0" });

  server.registerTool(
    "decide",
    {
      description: [
        "Ask a fast decision model typed questions about some input and get probabilities back, not prose. Good for routing, triage, classification and gating.",
        "",
        "Every question has a unique `name`, a `type` and `instructions`. Three types:",
        "- predicate: a yes/no question. Answer `probability` is the chance (0-1) it is true. Example: {type:'predicate', name:'angry', instructions:'Is the customer angry?'} -> 0.68 means about 68% likely yes. Pick your own threshold (e.g. >= 0.5).",
        "- choice: pick exactly one of 2-255 `choices` ({value, description}). Answer gives the winning `choice`, a `probability` for every option (they sum to 1) and `confidence` (0 = all options equally likely, 1 = certain). Add an 'other' option as a fallback.",
        "- score: rate on 2-10 ordered `levels` ({label, description}), lowest first. Answer `score` is the probability-weighted level index starting at 0, so 2.4 means between level 2 and level 3. Also returns `probabilities` per level and `confidence`.",
        "",
        "All questions are answered independently about the same `input`. `answers` come back in question order. A question the model declined comes back as {type:'refusal', name}.",
      ].join("\n"),
      inputSchema: {
        input: input.describe("The text to evaluate. For structured data, pass it serialized as JSON text. Images: pass user messages with input_image parts (inline base64 data URLs only)."),
        questions: z
          .array(question)
          .min(1)
          .max(200)
          .refine((qs) => new Set(qs.map((q) => q.name)).size === qs.length, "question names must be unique"),
        model: z.string().optional().describe("Override the configured decision model for this call"),
      },
    },
    async ({ input, questions, model }) => {
      try {
        const { response } = await client.decide({ model: model ?? client.cfg.model, input, questions } as any);
        return json(response);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "list_decision_models",
    {
      description: "List models available on the decisions backend, plus the server's current configuration (host, default model, API format).",
      inputSchema: {},
    },
    async () => {
      const config = { host: client.cfg.host, default_model: client.cfg.model, api_format: client.cfg.format };
      try {
        return json({ config, models: await client.listModels() });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
