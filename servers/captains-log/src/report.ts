import { Repo, today, type Filters } from "./repo.js";

export type GroupBy = "effort" | "issue" | "tag" | "month" | "project";

type Entry = Record<string, any>;

function addDay(d: string): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** Resolve the range: explicit from/to win; otherwise day after the last report's end (or all-time) through today. */
export function resolveRange(repo: Repo, from?: string, to?: string) {
  const last = repo.lastReport();
  const resolvedFrom = from ?? (last ? addDay(last.range_to) : undefined);
  return { from: resolvedFrom ?? null, to: to ?? today(), based_on_last_report: !from && !!last, last_report: last ?? null };
}

function sum(xs: (number | null | undefined)[]): number {
  return xs.reduce<number>((a, b) => a + (b ?? 0), 0);
}

function totals(entries: Entry[]) {
  const usage = entries.flatMap((e) => e.usage as Entry[]);
  return {
    entries: entries.length,
    time_spent_min: sum(entries.map((e) => e.time_spent_min)),
    time_saved_min: sum(entries.map((e) => e.time_saved_min)),
    input_tokens: sum(usage.map((u) => u.input_tokens)),
    output_tokens: sum(usage.map((u) => u.output_tokens)),
    cache_tokens: sum(usage.map((u) => u.cache_tokens)),
    cost_usd: Math.round(sum(usage.map((u) => u.cost_usd)) * 10000) / 10000,
    estimated_usage_rows: usage.filter((u) => u.source === "estimated").length,
    reported_usage_rows: usage.filter((u) => u.source === "reported").length,
  };
}

const issueLabel = (i: Entry) => (i.tracker ? `${i.tracker}:${i.key}` : String(i.key));

function keysFor(e: Entry, by: GroupBy): string[] {
  switch (by) {
    case "effort": return [e.effort ?? "(no effort)"];
    case "project": return [e.project ?? "(no project)"];
    case "month": return [String(e.occurred_on).slice(0, 7)];
    case "tag": return e.tags.length ? e.tags : ["(untagged)"];
    case "issue": return e.issues.length ? e.issues.map(issueLabel) : ["(no issue)"];
  }
}

export function buildReportData(repo: Repo, opts: { from?: string; to?: string; group_by?: GroupBy; filters?: Filters }) {
  const range = resolveRange(repo, opts.from, opts.to);
  const entries = repo.list({ ...opts.filters, from: range.from ?? undefined, to: range.to, limit: 5000 }) as Entry[];
  const by = opts.group_by ?? "effort";
  const groups = new Map<string, Entry[]>();
  for (const e of entries) for (const k of keysFor(e, by)) (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  // A multi-valued grouping (issue/tag) counts an entry once per group, so group totals can exceed overall totals.
  const grouped = [...groups.entries()]
    .map(([key, es]) => ({ key, totals: totals(es), entry_ids: es.map((e) => e.id) }))
    .sort((a, b) => b.totals.entries - a.totals.entries || a.key.localeCompare(b.key));
  const outcomes: Record<string, number> = {};
  for (const e of entries) outcomes[e.outcome ?? "unspecified"] = (outcomes[e.outcome ?? "unspecified"] ?? 0) + 1;
  // Distinct issues across the range; fill title/url from whichever entry has them.
  const issueMap = new Map<string, Entry>();
  for (const i of entries.flatMap((e) => e.issues as Entry[])) {
    const k = issueLabel(i);
    const cur = issueMap.get(k);
    issueMap.set(k, { tracker: i.tracker, key: i.key, title: cur?.title ?? i.title, url: cur?.url ?? i.url });
  }
  const issues = [...issueMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  return { range, group_by: by, totals: totals(entries), outcomes, issues, groups: grouped, entries };
}
