---
name: write-captains-log
description: Write a captain's log entry at the end of a thread. Records a detailed summary of the work, the efforts and JIRA items it ties to, token usage, and every source of information used, so the user can later show what their AI usage contributed. Use when the user says "write the captain's log", "log this", or at the end of a work session.
---

# Write a captain's log entry

Record this thread as one entry using the `log_entry` tool from the `captains-log` MCP server. The log is an audit trail: write it so someone who wasn't here can understand what was done, why, and what it connected to.

## 1. Gather the facts

From the conversation, collect:

- **title**: one line, outcome-oriented.
- **summary**: detailed. What problem was addressed, why it mattered, what was done, key decisions and trade-offs, what changed, and the result. Several paragraphs or bullets are fine. Prefer specifics (files, systems, numbers) over generalities.
- **effort**: the initiative, epic or theme this belongs to. Reuse an existing name where possible. Check with `list_entries` or `search_entries` for recent entries so naming stays consistent.
- **outcome**: shipped, in_progress, blocked, abandoned, or research.
- **jira**: every JIRA key mentioned or worked on, with a role (primary, related, blocked-by).
- **tags**: a few short labels (bugfix, feature, research, review, incident, ...).
- **project**, **platform** (the agent app you're running in), **model**, **session_ref** if known.
- **time_spent_min / time_saved_min**: rough estimates only. If unsure, ask the user or omit. Don't invent them.
- **usage**: token counts and cost. Use real numbers only if the platform exposes them (`source: "reported"`). Otherwise give a rough estimate with `source: "estimated"`, or omit it. Never present a guess as reported.

## 2. Pull in sources using whatever you have

The log should reflect every input that fed the work, not just this conversation. **Use any connected tools, MCP servers or skills available to you to enrich the entry**, whatever they happen to be. For example:

- an issue tracker (Jira, Linear, ...) to confirm ticket titles, status and epic links
- source control (git history, GitHub/GitLab PRs, commits, review threads)
- chat, email, calendar or meeting-notes tools for the discussions and decisions behind the work
- document or wiki tools for specs and design docs
- local files and command output touched in the thread

Don't assume any particular tool exists. Look at what is available, use what is relevant, and skip what isn't. Record each useful input in `sources` with a free-form `type` (jira, github_pr, slack, doc, email, meeting, file, commit, ...), plus `ref`, `url`, `title`, and `notes` on what it contributed. Anything that doesn't fit a field can go in `metadata`.

Only record what you actually saw. If a lookup fails or a tool isn't available, leave that out rather than guessing.

## 3. Confirm, then save

Show the user a short preview (title, effort, JIRA keys, outcome, source list). Ask only about things you can't determine yourself, such as the effort name, time estimates, or a missing JIRA key. Then call `log_entry` and report the returned id.

If the thread continues a piece of work already logged, use `update_entry` instead of creating a duplicate. Note that `jira`, `tags`, `sources` and `usage` replace the existing set, so send the full list.
