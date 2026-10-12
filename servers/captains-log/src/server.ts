import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Db } from "./db.js";
import { buildReportData } from "./report.js";
import { Repo } from "./repo.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const issue = z.object({
  key: z.string().min(1).describe("The tracker's own identifier, as written there: PROJ-123, #456, INC0012345, ENG-7, ..."),
  tracker: z.string().optional().describe("Free-form system name: jira, linear, github, gitlab, servicenow, asana, ... Omit if unknown."),
  url: z.string().optional(),
  title: z.string().optional().describe("The issue's title, if known"),
  role: z.string().optional().describe("e.g. primary, related, blocked-by"),
});
const source = z.object({
  type: z.string().describe("Free-form kind of input: pr, chat, doc, email, meeting, file, commit, ticket, ..."),
  ref: z.string().optional().describe("Identifier within that system (ticket key, PR number, message id)"),
  url: z.string().optional(),
  title: z.string().optional(),
  notes: z.string().optional().describe("What this source contributed to the work"),
});
const usage = z.object({
  model: z.string().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  source: z.enum(["reported", "estimated"]).optional().describe("'reported' only if the platform gave real numbers"),
});
const outcome = z.enum(["shipped", "in_progress", "blocked", "abandoned", "research"]);

const entryShape = {
  title: z.string().min(1),
  summary: z.string().min(1).describe("Detailed summary of the work: what, why, how, decisions, results"),
  occurred_on: date.optional().describe("Defaults to today"),
  effort: z.string().optional().describe("Initiative/epic/theme this work belongs to"),
  outcome: outcome.optional(),
  time_spent_min: z.number().int().nonnegative().optional(),
  time_saved_min: z.number().int().nonnegative().optional(),
  platform: z.string().optional().describe("Agent platform, e.g. claude-code, cursor, codex"),
  model: z.string().optional(),
  session_ref: z.string().optional().describe("Thread/session identifier if available"),
  project: z.string().optional().describe("Repo or project name"),
  metadata: z.record(z.unknown()).optional().describe("Anything else worth keeping"),
  issues: z.array(issue).optional().describe("Work items (tickets, issues, stories) this work relates to, from any tracker"),
  tags: z.array(z.string()).optional(),
  sources: z.array(source).optional(),
  usage: z.array(usage).optional(),
};

const filterShape = {
  from: date.optional(),
  to: date.optional(),
  effort: z.string().optional(),
  issue: z.string().optional().describe("Only entries linked to this issue key"),
  tracker: z.string().optional().describe("Narrow `issue` (or all issues) to one tracker, e.g. jira"),
  tag: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().int().positive().max(5000).optional(),
};

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: "text" as const, text: m }] });

function skillBody(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "skills", name, "SKILL.md"), "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function createServer(db: Db): McpServer {
  const repo = new Repo(db);
  const server = new McpServer({ name: "captains-log", version: "0.1.0" });

  server.registerTool(
    "log_entry",
    { description: "Create a captain's log entry for a finished unit of work (usually one agent thread).", inputSchema: entryShape },
    async (a) => json({ id: repo.create(a) }),
  );

  server.registerTool(
    "update_entry",
    {
      description: "Patch an entry. Scalar fields are patched; issues/tags/sources/usage, when provided, REPLACE the existing set.",
      inputSchema: { id: z.string(), ...Object.fromEntries(Object.entries(entryShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) },
    },
    async ({ id, ...patch }) => (repo.update(id, patch as any) ? json({ id, updated: true }) : fail(`No entry ${id}`)),
  );

  server.registerTool(
    "get_entry",
    { description: "Fetch one entry with its issue links, tags, sources and usage.", inputSchema: { id: z.string() } },
    async ({ id }) => { const e = repo.get(id); return e ? json(e) : fail(`No entry ${id}`); },
  );

  server.registerTool(
    "list_entries",
    { description: "List entries in chronological order, optionally filtered by date range, effort, issue key, tag or project.", inputSchema: filterShape },
    async (f) => json(repo.list(f)),
  );

  server.registerTool(
    "search_entries",
    { description: "Full-text search over title, summary and effort.", inputSchema: { query: z.string().min(1), ...filterShape } },
    async ({ query, ...f }) => json(repo.search(query, f)),
  );

  server.registerTool(
    "delete_entry",
    { description: "Permanently delete an entry.", inputSchema: { id: z.string() } },
    async ({ id }) => (repo.delete(id) ? json({ id, deleted: true }) : fail(`No entry ${id}`)),
  );

  server.registerTool(
    "get_last_report",
    { description: "The most recently recorded report (its range_to is the natural start for the next report).", inputSchema: {} },
    async () => json(repo.lastReport() ?? null),
  );

  server.registerTool(
    "get_report_data",
    {
      description:
        "Aggregated data for a report. If `from` is omitted it starts the day after the last recorded report (or all-time if none); `to` defaults to today. Returns range, totals, outcome counts, distinct issues, grouped totals and the full entries.",
      inputSchema: {
        from: date.optional(),
        to: date.optional(),
        group_by: z.enum(["effort", "issue", "tag", "month", "project"]).optional(),
        effort: z.string().optional(),
        issue: z.string().optional(),
        tracker: z.string().optional(),
        tag: z.string().optional(),
        project: z.string().optional(),
      },
    },
    async ({ from, to, group_by, ...filters }) => json(buildReportData(repo, { from, to, group_by, filters })),
  );

  server.registerTool(
    "mark_report_generated",
    { description: "Record that a report covering from..to was produced, so the next default range starts after it.", inputSchema: { from: date, to: date, label: z.string().optional() } },
    async ({ from, to, label }) => json({ id: repo.markReport(from, to, label) }),
  );

  server.registerPrompt(
    "write-captains-log",
    { description: "Workflow for writing a captain's log entry at the end of a thread" },
    () => ({ messages: [{ role: "user", content: { type: "text", text: skillBody("write-captains-log") } }] }),
  );
  server.registerPrompt(
    "generate-captains-report",
    {
      description: "Workflow for generating a captain's log report over a date range",
      argsSchema: { range: z.string().optional().describe("e.g. 'last month' or '2026-09-01..2026-09-30'; default: since last report") },
    },
    ({ range }) => ({
      messages: [{ role: "user", content: { type: "text", text: skillBody("generate-captains-report") + (range ? `\n\nRequested range: ${range}` : "") } }],
    }),
  );

  return server;
}
