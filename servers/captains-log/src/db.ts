import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Db = Database.Database;

export function defaultDbPath(): string {
  return process.env.CAPTAINS_LOG_DB ?? join(homedir(), ".captains-log", "captains-log.db");
}

/** Exported so tests can build a genuine v1 database. */
export const V1_SCHEMA = `
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    occurred_on TEXT NOT NULL,           -- YYYY-MM-DD
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    effort TEXT,                         -- initiative / epic / theme used for grouping
    outcome TEXT,                        -- shipped|in_progress|blocked|abandoned|research
    time_spent_min INTEGER,
    time_saved_min INTEGER,
    platform TEXT,                       -- agent platform (claude-code, cursor, codex, ...)
    model TEXT,
    session_ref TEXT,
    project TEXT,
    metadata TEXT                        -- free-form JSON
  );
  CREATE INDEX idx_entries_occurred ON entries(occurred_on);
  CREATE INDEX idx_entries_effort ON entries(effort);

  CREATE TABLE entry_jira (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    role TEXT,
    PRIMARY KEY (entry_id, key)
  );
  CREATE INDEX idx_entry_jira_key ON entry_jira(key);

  CREATE TABLE entry_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                  -- free-form: pr, chat, doc, email, meeting, file, commit, ticket, ...
    ref TEXT,
    url TEXT,
    title TEXT,
    notes TEXT
  );
  CREATE INDEX idx_entry_sources_entry ON entry_sources(entry_id);

  CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
  );
  CREATE INDEX idx_entry_tags_tag ON entry_tags(tag);

  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_tokens INTEGER,
    cost_usd REAL,
    source TEXT NOT NULL DEFAULT 'estimated'   -- reported|estimated
  );
  CREATE INDEX idx_usage_entry ON usage(entry_id);

  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at TEXT NOT NULL,
    range_from TEXT NOT NULL,
    range_to TEXT NOT NULL,
    label TEXT
  );

  CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id UNINDEXED, title, summary, effort);
  `;

const MIGRATIONS: string[] = [
  V1_SCHEMA,
  // v2: tracker-agnostic issue links replace the Jira-only table.
  `
  CREATE TABLE entry_issues (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tracker TEXT NOT NULL DEFAULT '',    -- free-form: jira, linear, github, gitlab, servicenow, asana, ... ('' = unspecified)
    key TEXT NOT NULL,                   -- the tracker's own identifier: PROJ-123, #456, INC0012345, ...
    url TEXT,
    title TEXT,
    role TEXT,                           -- e.g. primary, related, blocked-by
    PRIMARY KEY (entry_id, tracker, key)
  );
  CREATE INDEX idx_entry_issues_key ON entry_issues(key);
  INSERT INTO entry_issues(entry_id, tracker, key, role) SELECT entry_id, 'jira', key, role FROM entry_jira;
  DROP TABLE entry_jira;
  `,
];

export function openDb(path: string = defaultDbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // busy_timeout first so the remaining pragmas wait instead of failing under contention.
  db.pragma("busy_timeout = 10000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = () => db.pragma("user_version", { simple: true }) as number;
  if (current() >= MIGRATIONS.length) return;
  // BEGIN IMMEDIATE takes the write lock up front, so concurrent processes serialize here
  // and the version is re-checked after the lock is held.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let v = current(); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
