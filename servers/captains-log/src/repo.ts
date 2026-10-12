import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export interface SourceInput {
  type: string;
  ref?: string;
  url?: string;
  title?: string;
  notes?: string;
}
export interface UsageInput {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  cost_usd?: number;
  source?: "reported" | "estimated";
}
export interface JiraInput {
  key: string;
  role?: string;
}
export interface EntryInput {
  occurred_on?: string;
  title: string;
  summary: string;
  effort?: string;
  outcome?: string;
  time_spent_min?: number;
  time_saved_min?: number;
  platform?: string;
  model?: string;
  session_ref?: string;
  project?: string;
  metadata?: Record<string, unknown>;
  jira?: JiraInput[];
  tags?: string[];
  sources?: SourceInput[];
  usage?: UsageInput[];
}
export type EntryPatch = Partial<EntryInput>;

export interface Filters {
  from?: string;
  to?: string;
  effort?: string;
  jira?: string;
  tag?: string;
  project?: string;
  limit?: number;
}

export const today = () => new Date().toISOString().slice(0, 10);
const newId = () => Date.now().toString(36).padStart(9, "0") + randomBytes(5).toString("hex");

export class Repo {
  constructor(private db: Db) {}

  private writeChildren(id: string, e: EntryPatch, replace: boolean): void {
    const db = this.db;
    const del = (t: string) => db.prepare(`DELETE FROM ${t} WHERE entry_id = ?`).run(id);
    if (e.jira) {
      if (replace) del("entry_jira");
      const ins = db.prepare("INSERT OR REPLACE INTO entry_jira(entry_id, key, role) VALUES (?,?,?)");
      for (const j of e.jira) ins.run(id, j.key.toUpperCase(), j.role ?? null);
    }
    if (e.tags) {
      if (replace) del("entry_tags");
      const ins = db.prepare("INSERT OR IGNORE INTO entry_tags(entry_id, tag) VALUES (?,?)");
      for (const t of e.tags) ins.run(id, t.toLowerCase());
    }
    if (e.sources) {
      if (replace) del("entry_sources");
      const ins = db.prepare(
        "INSERT INTO entry_sources(entry_id, type, ref, url, title, notes) VALUES (?,?,?,?,?,?)",
      );
      for (const s of e.sources) ins.run(id, s.type, s.ref ?? null, s.url ?? null, s.title ?? null, s.notes ?? null);
    }
    if (e.usage) {
      if (replace) del("usage");
      const ins = db.prepare(
        "INSERT INTO usage(entry_id, model, input_tokens, output_tokens, cache_tokens, cost_usd, source) VALUES (?,?,?,?,?,?,?)",
      );
      for (const u of e.usage)
        ins.run(
          id,
          u.model ?? null,
          u.input_tokens ?? null,
          u.output_tokens ?? null,
          u.cache_tokens ?? null,
          u.cost_usd ?? null,
          u.source ?? "estimated",
        );
    }
  }

  private syncFts(id: string): void {
    this.db.prepare("DELETE FROM entries_fts WHERE entry_id = ?").run(id);
    this.db
      .prepare("INSERT INTO entries_fts(entry_id, title, summary, effort) SELECT id, title, summary, COALESCE(effort,'') FROM entries WHERE id = ?")
      .run(id);
  }

  create(e: EntryInput): string {
    const id = newId();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries(id, created_at, updated_at, occurred_on, title, summary, effort, outcome,
             time_spent_min, time_saved_min, platform, model, session_ref, project, metadata)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id, now, now, e.occurred_on ?? today(), e.title, e.summary, e.effort ?? null, e.outcome ?? null,
          e.time_spent_min ?? null, e.time_saved_min ?? null, e.platform ?? null, e.model ?? null,
          e.session_ref ?? null, e.project ?? null, e.metadata ? JSON.stringify(e.metadata) : null,
        );
      this.writeChildren(id, e, false);
      this.syncFts(id);
    }).immediate();
    return id;
  }

  /** Scalar fields are patched; child collections (jira/tags/sources/usage), when provided, replace the existing set. */
  update(id: string, p: EntryPatch): boolean {
    const scalar = [
      "occurred_on", "title", "summary", "effort", "outcome", "time_spent_min", "time_saved_min",
      "platform", "model", "session_ref", "project",
    ] as const;
    return this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM entries WHERE id = ?").get(id)) return false;
      const sets: string[] = ["updated_at = ?"];
      const vals: unknown[] = [new Date().toISOString()];
      for (const k of scalar) if (p[k] !== undefined) { sets.push(`${k} = ?`); vals.push(p[k]); }
      if (p.metadata !== undefined) { sets.push("metadata = ?"); vals.push(JSON.stringify(p.metadata)); }
      this.db.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      this.writeChildren(id, p, true);
      this.syncFts(id);
      return true;
    }).immediate();
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM entries_fts WHERE entry_id = ?").run(id);
      return this.db.prepare("DELETE FROM entries WHERE id = ?").run(id).changes > 0;
    }).immediate();
  }

  get(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.hydrate([row])[0] : undefined;
  }

  private hydrate(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const marks = ids.map(() => "?").join(",");
    const group = <T extends { entry_id: string }>(sql: string) => {
      const m = new Map<string, T[]>();
      for (const r of this.db.prepare(sql.replace("%IDS%", marks)).all(...ids) as T[]) {
        const a = m.get(r.entry_id) ?? [];
        a.push(r);
        m.set(r.entry_id, a);
      }
      return m;
    };
    const strip = <T extends Record<string, unknown>>(r: T) => {
      const { entry_id: _e, id: _i, ...rest } = r;
      return rest;
    };
    const jira = group<any>("SELECT entry_id, key, role FROM entry_jira WHERE entry_id IN (%IDS%) ORDER BY key");
    const tags = group<any>("SELECT entry_id, tag FROM entry_tags WHERE entry_id IN (%IDS%) ORDER BY tag");
    const sources = group<any>("SELECT * FROM entry_sources WHERE entry_id IN (%IDS%) ORDER BY id");
    const usage = group<any>("SELECT * FROM usage WHERE entry_id IN (%IDS%) ORDER BY id");
    return rows.map((r) => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata as string) : null,
      jira: (jira.get(r.id as string) ?? []).map(strip),
      tags: (tags.get(r.id as string) ?? []).map((t: any) => t.tag),
      sources: (sources.get(r.id as string) ?? []).map(strip),
      usage: (usage.get(r.id as string) ?? []).map(strip),
    }));
  }

  private where(f: Filters, alias = "e"): { sql: string; params: unknown[] } {
    const c: string[] = [];
    const p: unknown[] = [];
    if (f.from) { c.push(`${alias}.occurred_on >= ?`); p.push(f.from); }
    if (f.to) { c.push(`${alias}.occurred_on <= ?`); p.push(f.to); }
    if (f.effort) { c.push(`${alias}.effort = ? COLLATE NOCASE`); p.push(f.effort); }
    if (f.project) { c.push(`${alias}.project = ? COLLATE NOCASE`); p.push(f.project); }
    if (f.jira) { c.push(`EXISTS (SELECT 1 FROM entry_jira j WHERE j.entry_id = ${alias}.id AND j.key = ?)`); p.push(f.jira.toUpperCase()); }
    if (f.tag) { c.push(`EXISTS (SELECT 1 FROM entry_tags t WHERE t.entry_id = ${alias}.id AND t.tag = ?)`); p.push(f.tag.toLowerCase()); }
    return { sql: c.length ? " AND " + c.join(" AND ") : "", params: p };
  }

  list(f: Filters = {}): Record<string, unknown>[] {
    const w = this.where(f);
    const rows = this.db
      .prepare(`SELECT e.* FROM entries e WHERE 1=1${w.sql} ORDER BY e.occurred_on ASC, e.created_at ASC LIMIT ?`)
      .all(...w.params, f.limit ?? 500) as Record<string, unknown>[];
    return this.hydrate(rows);
  }

  search(query: string, f: Filters = {}): Record<string, unknown>[] {
    const w = this.where(f);
    // Quote each term so user input can't be parsed as FTS5 operators.
    const q = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.entry_id
         WHERE entries_fts MATCH ?${w.sql} ORDER BY rank LIMIT ?`,
      )
      .all(q, ...w.params, f.limit ?? 50) as Record<string, unknown>[];
    return this.hydrate(rows);
  }

  lastReport(): { id: number; generated_at: string; range_from: string; range_to: string; label: string | null } | undefined {
    return this.db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 1").get() as any;
  }

  markReport(range_from: string, range_to: string, label?: string): number {
    return Number(
      this.db
        .prepare("INSERT INTO reports(generated_at, range_from, range_to, label) VALUES (?,?,?,?)")
        .run(new Date().toISOString(), range_from, range_to, label ?? null).lastInsertRowid,
    );
  }
}
