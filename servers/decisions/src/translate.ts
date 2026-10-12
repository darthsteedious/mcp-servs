import type { Answer, DecisionRequest, DecisionResponse, Input, Question } from "./types.js";

type Json = Record<string, any>;

/** Text for a score level as sent to systemone (it only takes one string per level). */
const levelText = (l: { label: string; description?: string }) => (l.description ? `${l.label}: ${l.description}` : l.label);

/** Convert OpenAI-style input to a systemone `state` (string, or chat messages with image_url parts). */
function toState(input: Input): unknown {
  if (typeof input === "string") return input;
  return input.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) =>
            p.type === "input_text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.image_url } },
          ),
  }));
}

export function toSystemOneRequest(req: DecisionRequest): Json {
  const questions: Json = {};
  for (const q of req.questions) {
    switch (q.type) {
      case "predicate":
        questions[q.name] = { type: "noul", instructions: q.instructions };
        break;
      case "choice":
        questions[q.name] = {
          type: "choice",
          instructions: q.instructions,
          criteria: Object.fromEntries(q.choices.map((c) => [c.value, c.description ?? null])),
        };
        break;
      case "score":
        questions[q.name] = { type: "score", instructions: q.instructions, criteria: q.levels.map(levelText) };
        break;
    }
  }
  return { model: req.model, state: toState(req.input), questions };
}

const usageOf = (u: Json | undefined) => ({ input_tokens: u?.input_tokens ?? 0, output_tokens: u?.output_tokens ?? 0 });

export function fromSystemOneResponse(res: Json, req: DecisionRequest): DecisionResponse {
  const answers: Answer[] = req.questions.map((q: Question): Answer => {
    const a = res.answers?.[q.name];
    if (!a) return { type: "refusal", name: q.name };
    switch (q.type) {
      case "predicate":
        return { type: "predicate", name: q.name, probability: a.noul };
      case "choice":
        // Keep the order the caller supplied, not the backend's object order.
        return {
          type: "choice",
          name: q.name,
          choice: a.choice,
          probabilities: q.choices.map((c) => ({ value: c.value, probability: a.probabilities?.[c.value] ?? 0 })),
          confidence: a.confidence,
        };
      case "score":
        return {
          type: "score",
          name: q.name,
          score: a.score,
          probabilities: q.levels.map((l, i) => ({ value: i, label: l.label, probability: a.probabilities?.[String(i)] ?? 0 })),
          confidence: a.confidence,
        };
    }
  });
  return { model: res.model ?? req.model, answers, usage: usageOf(res.usage) };
}

export function fromOpenAIResponse(res: Json, req: DecisionRequest): DecisionResponse {
  return { model: res.model ?? req.model, answers: res.answers ?? [], usage: usageOf(res.usage) };
}
