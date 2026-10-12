import { fromOpenAIResponse, fromSystemOneResponse, toSystemOneRequest } from "./translate.js";
import type { DecisionRequest, DecisionResponse, Format } from "./types.js";

export interface Config {
  host: string;
  format: Format | "auto";
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export const DEFAULT_MODEL = "cloudflare_clef-flash";

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const format = (env.DECISIONS_API_FORMAT ?? "auto").toLowerCase();
  if (!["auto", "openai", "systemone"].includes(format)) {
    throw new Error(`DECISIONS_API_FORMAT must be auto, openai or systemone (got "${format}")`);
  }
  const timeoutMs = Number(env.DECISIONS_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("DECISIONS_TIMEOUT_MS must be a positive number");
  return {
    host: (env.DECISIONS_API_HOST ?? "http://localhost:1234").replace(/\/+$/, ""),
    format: format as Config["format"],
    model: env.DECISIONS_MODEL ?? DEFAULT_MODEL,
    apiKey: env.DECISIONS_API_KEY || undefined,
    timeoutMs,
  };
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const PATH: Record<Format, string> = { openai: "/v1/decisions", systemone: "/v1/systemone" };

export class DecisionsClient {
  /** Format that worked last, so `auto` only probes once. */
  private detected?: Format;

  constructor(readonly cfg: Config) {}

  private async fetchJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    let res: Response;
    try {
      res = await fetch(this.cfg.host + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError" ? `timed out after ${this.cfg.timeoutMs}ms` : String((e as Error).cause ?? e);
      throw new BackendError(`Cannot reach decisions backend at ${this.cfg.host}${path}: ${why}`);
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body, reported below */
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.error ?? text.slice(0, 500) ?? res.statusText;
      throw new BackendError(`Backend returned ${res.status} for ${path}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, res.status);
    }
    if (json === undefined) throw new BackendError(`Backend returned a non-JSON response for ${path}`, res.status);
    return json;
  }

  private async call(format: Format, req: DecisionRequest): Promise<DecisionResponse> {
    if (format === "openai") {
      return fromOpenAIResponse((await this.fetchJson("POST", PATH.openai, req)) as any, req);
    }
    return fromSystemOneResponse((await this.fetchJson("POST", PATH.systemone, toSystemOneRequest(req))) as any, req);
  }

  async decide(req: DecisionRequest): Promise<{ response: DecisionResponse; format: Format }> {
    const forced = this.cfg.format === "auto" ? this.detected : this.cfg.format;
    if (forced) return { response: await this.call(forced, req), format: forced };

    // auto: prefer the OpenAI shape, fall back only when the route doesn't exist.
    try {
      const response = await this.call("openai", req);
      this.detected = "openai";
      return { response, format: "openai" };
    } catch (e) {
      if (!(e instanceof BackendError) || (e.status !== 404 && e.status !== 405)) throw e;
      const response = await this.call("systemone", req);
      this.detected = "systemone";
      return { response, format: "systemone" };
    }
  }

  /** Models the backend reports. LM Studio's /api/v0/models tags decision models; fall back to the plain list. */
  async listModels(): Promise<{ id: string; type?: string; state?: string }[]> {
    try {
      const j = (await this.fetchJson("GET", "/api/v0/models")) as any;
      if (Array.isArray(j?.data)) return j.data.map((m: any) => ({ id: m.id, type: m.type, state: m.state }));
    } catch {
      /* not LM Studio; use the OpenAI-style list */
    }
    const j = (await this.fetchJson("GET", "/v1/models")) as any;
    return (j?.data ?? []).map((m: any) => ({ id: m.id }));
  }
}
