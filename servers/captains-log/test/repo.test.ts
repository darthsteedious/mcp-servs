import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { V1_SCHEMA } from "../src/db.js";
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
    expect(upgraded.pragma("user_version", { simple: true })).toBe(2);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name='entry_jira'").get()).toBeUndefined();
    expect((new Repo(upgraded).get("e1") as any).issues).toEqual([
      { tracker: "jira", key: "OLD-1", url: null, title: null, role: "primary" },
    ]);
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
    expect(r.update("nope", { title: "x" })).toBe(false);
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
