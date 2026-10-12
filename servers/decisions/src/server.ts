import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionsClient } from "./client.js";

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, _ and - only");

const question = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("predicate"),
    name,
    instructions: z.string().min(1).describe("A yes/no condition, e.g. 'Is the customer angry?'"),
  }),
  z.object({
    type: z.literal("choice"),
    name,
    instructions: z.string().min(1),
    choices: z
      .array(z.object({ value: z.string().min(1), description: z.string().optional() }))
      .min(2)
      .max(255)
      .describe("Distinct options. Include a fallback such as 'other'."),
  }),
  z.object({
    type: z.literal("score"),
    name,
    instructions: z.string().min(1),
    levels: z
      .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
      .min(2)
      .max(10)
      .describe("Ordered lowest to highest. Index 0 is the lowest."),
  }),
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
      description:
        "Ask a fast decision model typed questions about some text (or images) and get calibrated probabilities back, not prose. " +
        "Question types: predicate (probability a condition is true), choice (pick one of 2-255 options, with a probability for each), " +
        "score (rate on 2-10 ordered levels; result is an expected level index that can fall between levels). " +
        "Good for routing, triage, classification and gating. All questions are about the same `input`. " +
        "Answers come back in question order as `answers`.",
      inputSchema: {
        input: input.describe("Text to evaluate, or OpenAI-style user messages with input_text / input_image parts"),
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
