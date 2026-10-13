import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { V1_SCHEMA, V2_STEP } from "../src/db.js";
import { openDb } from "../src/db.js";
import { buildReportData } from "../src/report.js";
import { Repo } from "../src/repo.js";

const mk = () => new Repo(openDb(":memory:"));

describe("migrations", () => {
  it("upgrades a v1 database, carrying jira links into issues", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-mig-")), "v1.db");
    // Build a real v1 DB: run only the first migration, then add a jira row.
    const db = new Database(path);
    db.exec(V1_SCHEMA);
    db.pragma("user_version = 1");
    db.prepare("INSERT INTO entries(id,created_at,updated_at,occurred_on,title,summary) VALUES ('e1','x','x','2026-01-01','t','s')").run();
    db.prepare("INSERT INTO entry_jira(entry_id,key,role) VALUES ('e1','OLD-1','primary')").run();
    db.close();

    const upgraded = openDb(path);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(3);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='entry_jira'").get()).toBeUndefined();
    expect((new Repo(upgraded).get("e1") as any).issues).toEqual([
      { tracker: "jira", key: "OLD-1", url: null, title: null, role: "primary" },
    ]);
  });
});

describe("migration v3", () => {
  it("dedupes existing session_refs before adding the unique index", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-v3-")), "v2.db");
    const db = new Database(path);
    db.exec(V1_SCHEMA);
    db.exec(V2_STEP);
    db.pragma("user_version = 2");
    const ins = db.prepare("INSERT INTO entries(id,created_at,updated_at,occurred_on,title,summary,platform,session_ref) VALUES (?,?,?,?,?,?,?,?)");
    ins.run("a", "x", "x", "2026-01-01", "t", "s", "claude-code", "S1");
    ins.run("b", "x", "x", "2026-01-01", "t", "s", "claude-code", "S1"); // duplicate thread
    ins.run("c", "x", "x", "2026-01-01", "t", "s", "cursor", "S1"); // different platform: fine
    db.close();

    const repo = new Repo(openDb(path));
    expect((repo.get("a") as any).session_ref).toBe("S1");
    expect((repo.get("b") as any).session_ref).toBeNull();
    expect((repo.get("b") as any).metadata).toEqual({ former_session_ref: "S1" });
    expect((repo.get("c") as any).session_ref).toBe("S1");
  });
});

describe("one entry per thread", () => {
  it("createOrGet returns the existing entry for the same platform + session_ref", () => {
    const r = mk();
    const first = r.createOrGet({ title: "T", summary: "s", platform: "Claude-Code", session_ref: "abc" });
    expect(first.created).toBe(true);
    const again = r.createOrGet({ title: "Different", summary: "other", platform: " claude-code ", session_ref: "abc" });
    expect(again).toEqual({ id: first.id, created: false });
    expect((r.get(first.id) as any).title).toBe("T"); // untouched
    expect(r.list()).toHaveLength(1);
  });

  it("treats other platforms, and entries without a session_ref, as distinct", () => {
    const r = mk();
    r.createOrGet({ title: "A", summary: "s", platform: "cursor", session_ref: "abc" });
    expect(r.createOrGet({ title: "B", summary: "s", platform: "claude-code", session_ref: "abc" }).created).toBe(true);
    expect(r.createOrGet({ title: "C", summary: "s" }).created).toBe(true);
    expect(r.createOrGet({ title: "D", summary: "s" }).created).toBe(true);
    expect(r.list()).toHaveLength(4);
  });

  it("matches a session_ref logged without a platform only when platform is also omitted", () => {
    const r = mk();
    r.createOrGet({ title: "A", summary: "s", session_ref: "x" });
    expect(r.createOrGet({ title: "B", summary: "s", session_ref: "x" }).created).toBe(false);
    expect(r.createOrGet({ title: "C", summary: "s", session_ref: "x", platform: "cursor" }).created).toBe(true);
  });

  it("filters by session_ref and platform", () => {
    const r = mk();
    r.create({ title: "A", summary: "s", platform: "cursor", session_ref: "abc" });
    r.create({ title: "B", summary: "s", platform: "claude-code", session_ref: "abc" });
    expect(r.list({ session_ref: "abc" })).toHaveLength(2);
    expect(r.list({ session_ref: "abc", platform: "Cursor" }).map((e: any) => e.title)).toEqual(["A"]);
    expect(r.list({ session_ref: "nope" })).toHaveLength(0);
  });

  it("recovers when another connection inserts between the lookup and the insert", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-race2-")), "r.db");
    openDb(path).close();
    const winner = new Repo(openDb(path));
    const loser = new Repo(openDb(path)) as any;
    const real = loser.findBySession.bind(loser);
    let calls = 0;
    // First lookup misses (the other writer hasn't committed yet); the insert then hits the unique index.
    loser.findBySession = (...a: unknown[]) => (calls++ === 0 ? undefined : real(...a));
    const w = winner.createOrGet({ title: "W", summary: "s", platform: "p", session_ref: "same" });
    const l = loser.createOrGet({ title: "L", summary: "s", platform: "p", session_ref: "same" });
    expect(l).toEqual({ id: w.id, created: false });
    expect(calls).toBe(2);
  });

  it("sequential connections converge on one entry", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-race-")), "r.db");
    openDb(path).close();
    const a = new Repo(openDb(path));
    const b = new Repo(openDb(path));
    const results = [a, b, a, b].map((r) => r.createOrGet({ title: "T", summary: "s", platform: "p", session_ref: "same" }));
    expect(results.filter((x) => x.created)).toHaveLength(1);
    expect(new Set(results.map((x) => x.id)).size).toBe(1);
    expect(a.list()).toHaveLength(1);
  });

  it("rejects moving an entry onto another thread's session_ref", () => {
    const r = mk();
    r.create({ title: "A", summary: "s", platform: "p", session_ref: "one" });
    const b = r.create({ title: "B", summary: "s", platform: "p", session_ref: "two" });
    expect(() => r.update(b, { session_ref: "one" })).toThrow(/UNIQUE/);
    expect((r.get(b) as any).session_ref).toBe("two");
  });
});

describe("no-op updates", () => {
  const base = {
    title: "T", summary: "s", effort: "E", tags: ["a", "b"], metadata: { x: 1, y: 2 },
    issues: [{ key: "A-1", tracker: "jira" }], sources: [{ type: "pr", ref: "1" }], usage: [{ input_tokens: 5, source: "reported" as const }],
  };

  it("leaves updated_at and content alone when nothing differs", async () => {
    const r = mk();
    const id = r.create(base);
    const before = r.get(id) as any;
    await new Promise((res) => setTimeout(res, 5));
    // same values, different tag order and metadata key order
    expect(r.update(id, { ...base, tags: ["b", "a"], metadata: { y: 2, x: 1 } })).toEqual({ found: true, changed: false });
    expect(r.update(id, { summary: "s" })).toEqual({ found: true, changed: false });
    expect((r.get(id) as any).updated_at).toBe(before.updated_at);
    expect(r.search("s")).toHaveLength(1); // FTS intact after the rollback
  });

  it("writes and bumps updated_at when something differs", async () => {
    const r = mk();
    const id = r.create(base);
    const before = (r.get(id) as any).updated_at;
    await new Promise((res) => setTimeout(res, 5));
    expect(r.update(id, { usage: [{ input_tokens: 9, source: "reported" }] })).toEqual({ found: true, changed: true });
    const after = r.get(id) as any;
    expect(after.updated_at).not.toBe(before);
    expect(after.usage[0].input_tokens).toBe(9);
    expect(r.update(id, { tags: ["a"] }).changed).toBe(true);
    expect((r.get(id) as any).tags).toEqual(["a"]);
  });
});

describe("repo", () => {
  it("creates and hydrates an entry", () => {
    const r = mk();
    const id = r.create({
      title: "Fix login", summary: "Fixed the login redirect loop", occurred_on: "2026-09-01", effort: "Auth",
      issues: [{ key: "PROJ-1", tracker: "Jira", url: "https://j/PROJ-1", role: "primary" }, { key: "#42" }], tags: ["Bugfix"],
      sources: [{ type: "github_pr", ref: "42", url: "https://x/42" }],
      usage: [{ input_tokens: 10, output_tokens: 5, cost_usd: 0.5, source: "reported" }],
    });
    const e = r.get(id) as any;
    expect(e.issues).toEqual([
      { tracker: null, key: "#42", url: null, title: null, role: null },
      { tracker: "jira", key: "PROJ-1", url: "https://j/PROJ-1", title: null, role: "primary" },
    ]);
    expect(e.tags).toEqual(["bugfix"]);
    expect(e.sources[0]).toMatchObject({ type: "github_pr", ref: "42" });
    expect(e.usage[0].cost_usd).toBe(0.5);
  });

  it("filters by range, issue and tag; searches via FTS safely", () => {
    const r = mk();
    r.create({ title: "A", summary: "database migration work", occurred_on: "2026-09-01", issues: [{ key: "X-1", tracker: "linear" }], tags: ["db"] });
    r.create({ title: "B", summary: "frontend polish", occurred_on: "2026-09-10" });
    expect(r.list({ from: "2026-09-05" }).map((e: any) => e.title)).toEqual(["B"]);
    expect(r.list({ issue: "x-1" })).toHaveLength(1);
    expect(r.list({ issue: "x-1", tracker: "linear" })).toHaveLength(1);
    expect(r.list({ issue: "x-1", tracker: "jira" })).toHaveLength(0);
    expect(r.list({ tracker: "linear" })).toHaveLength(1);
    expect(r.list({ tag: "DB" })).toHaveLength(1);
    expect(r.search("migration")).toHaveLength(1);
    expect(r.search('"weird AND (query')).toEqual([]); // operators are quoted, no throw
  });

  it("update replaces children and refreshes FTS; delete cascades", () => {
    const r = mk();
    const id = r.create({ title: "T", summary: "alpha", tags: ["a", "b"] });
    r.update(id, { summary: "beta", tags: ["c"] });
    expect((r.get(id) as any).tags).toEqual(["c"]);
    expect(r.search("alpha")).toHaveLength(0);
    expect(r.search("beta")).toHaveLength(1);
    expect(r.delete(id)).toBe(true);
    expect(r.search("beta")).toHaveLength(0);
    expect(r.update("nope", { title: "x" })).toEqual({ found: false, changed: false });
  });

  it("report range defaults to the day after the last report", () => {
    const r = mk();
    r.create({ title: "old", summary: "s", occurred_on: "2026-08-01", effort: "E1", time_spent_min: 30 });
    r.create({ title: "new", summary: "s", occurred_on: "2026-09-02", effort: "E2", usage: [{ cost_usd: 1, source: "estimated" }] });
    expect(buildReportData(r, { to: "2026-09-30" }).entries).toHaveLength(2);
    r.markReport("2026-08-01", "2026-08-31");
    const d = buildReportData(r, { to: "2026-09-30" });
    expect(d.range.from).toBe("2026-09-01");
    expect(d.entries).toHaveLength(1);
    expect(d.totals.cost_usd).toBe(1);
    expect(d.totals.estimated_usage_rows).toBe(1);
    expect(buildReportData(r, { from: "2026-08-01", to: "2026-09-30", group_by: "effort" }).groups).toHaveLength(2);
  });

  it("supports concurrent writers on one file DB without SQLITE_BUSY", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-")), "t.db");
    openDb(path).close();
    const code = `
      const { parentPort, workerData } = require("node:worker_threads");
      const D = require("better-sqlite3");
      const db = new D(workerData.path);
      db.pragma("busy_timeout = 10000"); db.pragma("journal_mode = WAL");
      for (let i = 0; i < 50; i++) {
        db.transaction(() => db.prepare("INSERT INTO entries(id,created_at,updated_at,occurred_on,title,summary) VALUES (?,?,?,?,?,?)")
          .run(workerData.n + "-" + i, "x", "x", "2026-01-01", "t", "s")).immediate();
      }
      parentPort.postMessage("ok");`;
    const run = (n: number) =>
      new Promise((res, rej) => {
        const w = new Worker(code, { eval: true, workerData: { path, n } });
        w.on("message", res); w.on("error", rej);
      });
    await Promise.all([run(1), run(2), run(3), run(4)]);
    const count = openDb(path).prepare("SELECT COUNT(*) c FROM entries").get() as { c: number };
    expect(count.c).toBe(200);
  });
});
