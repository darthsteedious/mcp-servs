---
name: write-captains-log
description: Write or update a captain's log entry for the current thread. Records a detailed summary of the work, the efforts and issues/tickets it ties to, token usage, and every source of information used, so the user can later show what their AI usage contributed. Safe to run more than once in a thread; it only changes the entry when the work has changed. Use when the user says "write the captain's log", "log this", or at the end of a work session.
---

# Write a captain's log entry

Record this thread as **one** entry using the `captains-log` MCP server. The log is an audit trail: write it so someone who wasn't here can understand what was done, why, and what it connected to.

A thread has one entry. Running this skill again in the same thread must never create a second one, and must not touch the entry if nothing meaningful has changed.

## 0. Is this thread already logged?

Work out the thread's identity first:

- `platform`: the agent app you're running in (claude-code, cursor, codex, ...).
- `session_ref`: the platform's real thread/session id, **only if you can actually see one**. Never invent or guess an id.

Then look for an existing entry:

1. **With a `session_ref`:** call `list_entries` with `session_ref` and `platform`. At most one entry comes back.
2. **Without one:** call `list_entries` for today's date and the current `project`, and look for an entry whose title and summary describe this same thread's work. If one plausibly matches, show it to the user and ask whether it is the same thread. Don't update on a guess. If none matches, treat it as new, and tell the user it can't be matched automatically if they run this again.

Then:

- **No entry found:** go to steps 1–3 and create it.
- **Entry found:** read it in full, then do steps 1–2 to work out what the entry *should* say now, and compare. Go to step 4.

## 1. Gather the facts

From the conversation, collect:

- **title**: one line, outcome-oriented.
- **summary**: detailed. What problem was addressed, why it mattered, what was done, key decisions and trade-offs, what changed, and the result. Several paragraphs or bullets are fine. Prefer specifics (files, systems, numbers) over generalities.
- **effort**: the initiative, epic or theme this belongs to. Reuse an existing name where possible. Check recent entries with `list_entries` or `search_entries` so naming stays consistent.
- **outcome**: shipped, in_progress, blocked, abandoned, or research.
- **issues**: every work item (ticket, issue, story, incident) mentioned or worked on, from whatever tracker the user uses. Each has the tracker's own `key` as written there (PROJ-123, #456, INC0012345), plus `tracker` (jira, linear, github, servicenow, ... or omit if unclear), `url`, `title` when known, and a `role` (primary, related, blocked-by). Don't force a format; record the identifier exactly as the tracker shows it.
- **tags**: a few short labels (bugfix, feature, research, review, incident, ...).
- **project**, **platform**, **model**, and **session_ref** (only if real, see step 0).
- **time_spent_min / time_saved_min**: rough estimates only. If unsure, ask the user or omit. Don't invent them.
- **usage**: token counts and cost for the **whole thread so far**. Use real numbers only if the platform exposes them (`source: "reported"`). Otherwise give a rough estimate with `source: "estimated"`, or omit it. Never present a guess as reported.

## 2. Pull in sources using whatever you have

The log should reflect every input that fed the work, not just this conversation. **Use any connected tools, MCP servers or skills available to you to enrich the entry**, whatever they happen to be. For example:

- an issue tracker (Jira, Linear, GitHub Issues, ServiceNow, Asana, ...) to confirm ticket titles, status and epic links
- source control (git history, GitHub/GitLab PRs, commits, review threads)
- chat, email, calendar or meeting-notes tools for the discussions and decisions behind the work
- document or wiki tools for specs and design docs
- local files and command output touched in the thread

Don't assume any particular tool exists. Look at what is available, use what is relevant, and skip what isn't. Record each useful input in `sources` with a free-form `type` (pr, chat, doc, email, meeting, file, commit, ticket, ...), plus `ref`, `url`, `title`, and `notes` on what it contributed. Anything that doesn't fit a field can go in `metadata`.

Only record what you actually saw. If a lookup fails or a tool isn't available, leave that out rather than guessing.

## 3. New entry: confirm, then save

Show the user a short preview (title, effort, issues, outcome, source list). Ask only about things you can't determine yourself, such as the effort name, time estimates, or a missing issue key. Then call `log_entry` and report the returned id.

`log_entry` is idempotent per (`platform`, `session_ref`). If it answers `status: "exists"` instead of `"created"`, nothing was written: someone logged this thread in the meantime. Continue at step 4 with the entry it returned.

## 4. Existing entry: update only if the work changed

Compare what the entry says with what you now know. Count a change only if it is **material**:

- new work done, new decisions or results, or a changed outcome (e.g. in_progress -> shipped)
- issues, sources, tags, or effort added, corrected, or no longer accurate
- usage that has grown because the thread continued
- a correction to something the entry got wrong

Don't count rewording, reordering, or a differently phrased summary of the same facts.

- **Nothing material changed:** do **not** call `update_entry`. Tell the user: "Already logged (id ...), nothing new to add." Stop.
- **Something changed:** build the *revised whole entry*, not a diff.
  - `summary`: rewrite it as one coherent summary of the thread as it now stands. Fold the new work in. Don't append a "Update:" section and don't repeat what's already there.
  - `issues`, `tags`, `sources`, `usage`: these **replace** the stored lists, so send the complete list including everything already on the entry. Dropping an item deletes it. For `usage`, send cumulative totals for the whole thread, not just the new part, or it will be undercounted.
  - Only send the fields that changed. Leave the rest out.
  - Show the user a short before/after of what is changing, then call `update_entry`.
  - The server also checks: if the result turns out identical to what is stored, it writes nothing and returns `changed: false`. Report that as "no changes".

Never delete and re-create an entry to update it, and never create a second entry for a thread that already has one.
