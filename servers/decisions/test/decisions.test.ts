import { afterEach, describe, expect, it } from "vitest";
import { createServer as http, type Server } from "node:http";
import { BackendError, DecisionsClient, configFromEnv, DEFAULT_MODEL } from "../src/client.js";
import { fromSystemOneResponse, toSystemOneRequest } from "../src/translate.js";
import type { DecisionRequest } from "../src/types.js";

const req: DecisionRequest = {
  model: "m",
  input: "I was charged twice.",
  questions: [
    { type: "predicate", name: "angry", instructions: "Angry?" },
    { type: "choice", name: "route", instructions: "Team?", choices: [{ value: "billing", description: "payments" }, { value: "other" }] },
    { type: "score", name: "urgency", instructions: "Urgent?", levels: [{ label: "low", description: "no rush" }, { label: "high" }] },
  ],
};

const s1Answers = {
  angry: { type: "noul", noul: 0.6 },
  // backend order deliberately differs from the request's choice order
  route: { type: "choice", choice: "billing", probabilities: { other: 0.1, billing: 0.9 }, confidence: 0.8 },
  urgency: { type: "score", score: 0.7, legend: {}, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.4 },
};

describe("translate", () => {
  it("maps OpenAI questions to systemone", () => {
    const out = toSystemOneRequest(req);
    expect(out.state).toBe("I was charged twice.");
    expect(out.questions.angry).toEqual({ type: "noul", instructions: "Angry?" });
    expect(out.questions.route.criteria).toEqual({ billing: "payments", other: null });
    expect(out.questions.urgency.criteria).toEqual(["low: no rush", "high"]);
  });

  it("converts message input incl. images", () => {
    const out = toSystemOneRequest({
      ...req,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] }],
    });
    expect(out.state[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
    ]);
  });

  it("maps systemone answers back to OpenAI shape, in request order", () => {
    const r = fromSystemOneResponse({ answers: s1Answers, usage: { input_tokens: 5, output_tokens: 0 } }, req);
    expect(r.answers.map((a) => a.name)).toEqual(["angry", "route", "urgency"]);
    expect(r.answers[0]).toEqual({ type: "predicate", name: "angry", probability: 0.6 });
    expect((r.answers[1] as any).probabilities).toEqual([
      { value: "billing", probability: 0.9 },
      { value: "other", probability: 0.1 },
    ]);
    expect((r.answers[2] as any).probabilities).toEqual([
      { value: 0, label: "low", probability: 0.3 },
      { value: 1, label: "high", probability: 0.7 },
    ]);
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 0 });
  });

  it("reports a missing answer as a refusal", () => {
    const r = fromSystemOneResponse({ answers: { angry: s1Answers.angry } }, req);
    expect(r.answers[1]).toEqual({ type: "refusal", name: "route" });
  });
});

describe("client", () => {
  let srv: Server | undefined;
  afterEach(() => srv?.close());

  async function backend(routes: Record<string, (body: any, auth?: string) => [number, unknown]>) {
    const hits: string[] = [];
    srv = http((rq, rs) => {
      let b = "";
      rq.on("data", (c) => (b += c));
      rq.on("end", () => {
        hits.push(`${rq.method} ${rq.url}`);
        const h = routes[rq.url!];
        const [code, body] = h ? h(b ? JSON.parse(b) : undefined, rq.headers.authorization) : [404, { error: { message: "no route" } }];
        rs.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    return { host: `http://127.0.0.1:${(srv.address() as any).port}`, hits };
  }
  const cfg = (host: string, over = {}) => ({ host, format: "auto" as const, model: "m", timeoutMs: 5000, ...over });
  const openaiOk = { model: "m", answers: [{ type: "predicate", name: "angry", probability: 0.5 }], usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 } };

  it("uses the OpenAI endpoint when available, with bearer auth", async () => {
    let auth: string | undefined;
    const { host, hits } = await backend({ "/v1/decisions": (_b, a) => ((auth = a), [200, openaiOk]) });
    const c = new DecisionsClient(cfg(host, { apiKey: "k" }));
    const { response, format } = await c.decide(req);
    expect(format).toBe("openai");
    expect(auth).toBe("Bearer k");
    expect(response.usage).toEqual({ input_tokens: 3, output_tokens: 0 });
    await c.decide(req);
    expect(hits).toEqual(["POST /v1/decisions", "POST /v1/decisions"]);
  });

  it("falls back to systemone on 404 and remembers it", async () => {
    let sent: any;
    const { host, hits } = await backend({ "/v1/systemone": (b) => ((sent = b), [200, { answers: s1Answers, usage: { input_tokens: 9 } }]) });
    const c = new DecisionsClient(cfg(host));
    const { response, format } = await c.decide(req);
    expect(format).toBe("systemone");
    expect(sent.questions.angry.type).toBe("noul");
    expect(response.answers).toHaveLength(3);
    await c.decide(req);
    expect(hits).toEqual(["POST /v1/decisions", "POST /v1/systemone", "POST /v1/systemone"]);
  });

  it("does not fall back on real errors, and surfaces the backend message", async () => {
    const { host, hits } = await backend({ "/v1/decisions": () => [400, { error: { message: "bad question" } }] });
    await expect(new DecisionsClient(cfg(host)).decide(req)).rejects.toThrow(/400.*bad question/);
    expect(hits).toEqual(["POST /v1/decisions"]);
  });

  it("honours a forced format", async () => {
    const { host, hits } = await backend({ "/v1/systemone": () => [200, { answers: s1Answers }] });
    await new DecisionsClient(cfg(host, { format: "systemone" })).decide(req);
    expect(hits).toEqual(["POST /v1/systemone"]);
  });

  it("reports an unreachable host clearly", async () => {
    await expect(new DecisionsClient(cfg("http://127.0.0.1:1")).decide(req)).rejects.toBeInstanceOf(BackendError);
  });

  it("lists models, preferring LM Studio's typed list", async () => {
    const { host } = await backend({ "/api/v0/models": () => [200, { data: [{ id: "x", type: "decision", state: "loaded" }] }] });
    expect(await new DecisionsClient(cfg(host)).listModels()).toEqual([{ id: "x", type: "decision", state: "loaded" }]);
  });
});

describe("config", () => {
  it("defaults", () => {
    const c = configFromEnv({});
    expect(c).toMatchObject({ host: "http://localhost:1234", model: DEFAULT_MODEL, format: "auto" });
  });
  it("overrides and trims trailing slash", () => {
    const c = configFromEnv({ DECISIONS_API_HOST: "http://h:9/", DECISIONS_MODEL: "x", DECISIONS_API_FORMAT: "SystemOne", DECISIONS_API_KEY: "k" });
    expect(c).toMatchObject({ host: "http://h:9", model: "x", format: "systemone", apiKey: "k" });
  });
  it("rejects a bad format", () => {
    expect(() => configFromEnv({ DECISIONS_API_FORMAT: "nope" })).toThrow(/DECISIONS_API_FORMAT/);
  });
});

describe("tool schema", () => {
  it("documents each question type so agents can use it", async () => {
    const { createServer } = await import("../src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(new DecisionsClient({ host: "http://x", format: "auto", model: "m", timeoutMs: 1000 }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const decide = (await client.listTools()).tools.find((t) => t.name === "decide")!;
    for (const w of ["predicate", "choice", "score", "yes/no", "probability", "confidence", "refusal"]) {
      expect(decide.description).toContain(w);
    }
    expect(JSON.stringify(decide.inputSchema)).toContain("Unique id for this question");
    expect(JSON.stringify(decide.inputSchema)).not.toContain("noul");
    await client.close();
  });
});
