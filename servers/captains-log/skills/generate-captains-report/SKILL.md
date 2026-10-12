---
name: generate-captains-report
description: Generate a report from the captain's log covering a date range. By default covers everything since the last report; the user can give any range. Aggregates entries into a summary of efforts, JIRA items, outcomes, token usage and time. Use when the user asks for a captain's log report, a work summary, or an audit/status write-up of their AI-assisted work.
---

# Generate a captain's log report

Build a report from the `captains-log` MCP server's entries.

## 1. Resolve the range

- If the user gave a range ("last month", "Q3", "2026-09-01 to 2026-09-30", "this week"), convert it to explicit `from`/`to` dates (YYYY-MM-DD, inclusive) and say what you resolved it to.
- If they gave none, call `get_report_data` without `from`. The server starts the day after the last recorded report (or all-time if there has been none) and ends today. Tell the user the range it used, and offer to change it.
- Optional filters: `effort`, `jira`, `tag`, `project`. Optional `group_by`: effort (default), jira, tag, month, project.

## 2. Fetch the data

Call `get_report_data`. It returns `range`, `totals`, `outcomes`, `jira_keys`, `groups` and the full `entries`. If there are zero entries, say so and stop. Don't record a report for an empty range.

## 3. Optionally enrich

If you have tools for the systems in the entries' `sources` (issue tracker, source control, etc.), you may refresh ticket titles and statuses so the report shows current state. Never overwrite what the log recorded. Mark anything added as "current status".

## 4. Write the report (markdown)

1. **Header**: date range, number of entries.
2. **Executive summary**: 1–2 paragraphs on what was accomplished overall, written for a non-technical reader asking "what did this AI usage contribute to?".
3. **By effort** (or the chosen grouping): per group, a short narrative, outcome, the JIRA items involved, and entry count.
4. **JIRA items**: table of key, title (if known), status/outcome, and which entries touched it.
5. **Usage**: totals for tokens, estimated cost, time spent and time saved. State how many usage rows are `reported` versus `estimated`, and don't present estimates as exact. Say so plainly if time or usage data is missing.
6. **Chronological log**: each entry in date order with its title, date, effort, outcome and a condensed summary, plus its sources and links.

Be faithful to the log. Summarise, but don't invent accomplishments, numbers or ticket details. A group total can exceed the overall total when grouping by jira or tag, because an entry appears in each of its groups. Note this if you show both.

## 5. Record it

After delivering the report, call `mark_report_generated` with the `from`/`to` actually used, plus a short label. Skip this if the user says it was a draft or exploratory, or if they ask for a one-off view that shouldn't move the "since last report" marker.
