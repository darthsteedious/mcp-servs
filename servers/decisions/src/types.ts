/**
 * The common question/answer format is the OpenAI Decisions API shape.
 * Backends that speak a different dialect (TypeSafe/Jev `/v1/systemone`) are
 * translated to and from it in translate.ts, so MCP clients only ever see this.
 */
export type Question =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string; description?: string }[] };

/** OpenAI input: a string, or user messages made of input_text / input_image parts. */
export type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
export type Input = string | { role: "user"; content: string | InputPart[] }[];

export interface DecisionRequest {
  model: string;
  input: Input;
  questions: Question[];
}

export type Answer =
  | { type: "predicate"; name: string; probability: number }
  | {
      type: "choice";
      name: string;
      choice: string;
      probabilities: { value: string; probability: number }[];
      confidence: number;
    }
  | {
      type: "score";
      name: string;
      score: number;
      probabilities: { value: number; label: string; probability: number }[];
      confidence: number;
    }
  | { type: "refusal"; name: string };

export interface DecisionResponse {
  model: string;
  answers: Answer[];
  usage: { input_tokens: number; output_tokens: number };
}

export type Format = "openai" | "systemone";
