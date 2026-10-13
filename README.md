# mcp-servs

Monorepo of locally run MCP servers (stdio and Streamable HTTP). Built with TypeScript and npm workspaces.

- `packages/mcp-common`: shared transport bootstrap (`--http`, `--port`, `--host`).
- `servers/captains-log`: audit log of AI-assisted work, backed by SQLite.
- `servers/decisions`: typed questions answered by a decision model (OpenAI Decisions or System One backends).

```sh
npm install && npm run build && npm test
```

## captains-log

Stores one entry per unit of work (usually one agent thread): detailed summary, effort, issues (links to tickets in any tracker), tags, outcome, time estimates, token/cost usage, and free-form **sources**. Sources are anything that fed the work (tickets, PRs, chats, docs, meetings), gathered by the skill from whatever tools the agent has connected. The server doesn't integrate with those systems itself.

DB: `~/.captains-log/captains-log.db` (override with `CAPTAINS_LOG_DB`). It uses WAL mode with a busy timeout, so several stdio processes plus the HTTP daemon can share it.

### Run

```sh
node servers/captains-log/dist/index.js                 # stdio
node servers/captains-log/dist/index.js --http          # http://127.0.0.1:3737/mcp (localhost only by default)
node servers/captains-log/dist/index.js --http --port 4000
```

Register (stdio), using an absolute path:

```sh
claude mcp add captains-log -- node /ABS/PATH/mcp-servs/servers/captains-log/dist/index.js
claude mcp add --transport http captains-log http://127.0.0.1:3737/mcp   # HTTP
```

Other clients (Cursor, Codex, etc.) take the same command and args in their MCP config, e.g. `{"mcpServers":{"captains-log":{"command":"node","args":["/ABS/PATH/.../dist/index.js"]}}}`.

### Tools

`log_entry`, `update_entry`, `get_entry`, `list_entries`, `search_entries`, `delete_entry`, `get_report_data`, `mark_report_generated`, `get_last_report`.
The two workflows are also exposed as MCP prompts (`write-captains-log`, `generate-captains-report`), so any MCP client can use them without a skills system.

### Skills

- `write-captains-log`: run at the end of a thread.
- `generate-captains-report`: defaults to "since the last report"; accepts any range.

Install into your agent platform (symlinks by default, `--copy` to copy):

```sh
node servers/captains-log/scripts/install-skills.mjs --target claude      # ~/.claude/skills
node servers/captains-log/scripts/install-skills.mjs --target agents      # ~/.agents/skills
node servers/captains-log/scripts/install-skills.mjs --target codex       # ~/.codex/skills
node servers/captains-log/scripts/install-skills.mjs --target cursor --project .     # .cursor/rules/*.mdc
node servers/captains-log/scripts/install-skills.mjs --target agents-md --project .  # AGENTS.md block
node servers/captains-log/scripts/install-skills.mjs --target dir:/some/path
```

**Workspace.** Each entry can record where the work happened: `workspace` (directory path), `repo` (git remote, with any embedded credentials stripped on save) and `branch`, plus a short `project` name. The skill fills them from the agent's environment. Reports can filter and group by workspace.

**One entry per thread.** Entries are keyed by `platform` + `session_ref` (the agent's real thread id, never invented). `log_entry` on a thread that already has an entry writes nothing and returns it with `status: "exists"`. `update_entry` writes nothing, and leaves `updated_at` alone, when the result is identical to what's stored (`changed: false`). The skill looks the thread up first and only updates when the work has materially changed. Without a session id it falls back to matching today's entries for the project and asks before updating. `list_entries` takes `session_ref` and `platform` filters.

Token usage is supplied by the agent. Entries flag it as `reported` or `estimated`, and reports show the split.

## decisions

Asks a fast decision model typed questions about some text or images and returns probabilities rather than prose. This is useful for routing, triage, classification and gating.

**One question format for clients.** The `decide` tool uses the OpenAI Decisions shape: a `questions` array of `predicate`, `choice` and `score` questions in, an `answers` array out. If the backend speaks TypeSafe's System One dialect (`/v1/systemone`: `noul`, `criteria` and an id-keyed `answers` object), the server translates in both directions. Agents never see the difference.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECISIONS_API_HOST` | `http://localhost:1234` | Base URL of any server exposing a decisions API |
| `DECISIONS_MODEL` | `cloudflare_clef-flash` | Default model; `decide` also takes a per-call `model` |
| `DECISIONS_API_FORMAT` | `auto` | `auto` tries `/v1/decisions` and falls back to `/v1/systemone` on 404/405. `openai` or `systemone` forces one. |
| `DECISIONS_API_KEY` | none | Sent as a Bearer token if set |
| `DECISIONS_TIMEOUT_MS` | `60000` | Per-request timeout |

```sh
claude mcp add decisions -e DECISIONS_API_HOST=http://localhost:1234 -- node /ABS/PATH/mcp-servs/servers/decisions/dist/index.js
```

Tools: `decide`, `list_decision_models` (also shows the active config). The backend must have a *decision* model loaded; chat models are rejected. `node servers/decisions/test/live.mjs` runs a live check against whatever the env points at.

### Question types

The `decide` tool exposes three question types. All questions share a unique `name` and `instructions`, and are answered independently about the same `input`. Answers come back in question order.

| Type | Use it for | You supply | You get back |
| --- | --- | --- | --- |
| `predicate` | A yes/no question ("Is the customer angry?") | nothing extra | `probability`: chance (0-1) the answer is yes/true. Apply your own threshold. |
| `choice` | Pick exactly one option (routing, category) | `choices`: 2-255 of `{value, description?}`. Include an "other" fallback. | `choice` (winner), `probabilities` per option (sum to 1), `confidence` (0 = all equally likely, 1 = certain) |
| `score` | Rate on an ordered scale (urgency, severity) | `levels`: 2-10 of `{label, description?}`, lowest first | `score`: probability-weighted level index, 0-based, may fall between levels (2.4 is between 2 and 3). Also `probabilities` per level and `confidence`. |

A question the model declines comes back as `{type: "refusal", name}`.

```jsonc
// decide({ input, questions })
{
  "input": "I was charged twice and nobody has replied.",
  "questions": [
    { "type": "predicate", "name": "angry", "instructions": "Is the customer angry?" },
    { "type": "choice", "name": "route", "instructions": "Which team should handle this?",
      "choices": [{ "value": "billing" }, { "value": "shipping" }, { "value": "other" }] },
    { "type": "score", "name": "urgency", "instructions": "How urgent is this?",
      "levels": [{ "label": "can wait" }, { "label": "today" }, { "label": "right now" }] }
  ]
}
// -> answers: [
//   { "type": "predicate", "name": "angry", "probability": 0.68 },
//   { "type": "choice", "name": "route", "choice": "billing", "probabilities": [...], "confidence": 0.9 },
//   { "type": "score", "name": "urgency", "score": 1.64, "probabilities": [...], "confidence": 0.3 } ]
```

### How the two backend dialects map

The two APIs ask for the same things in different shapes. The question semantics, limits (255 choices, 2-10 levels) and answer meanings are the same, so the translation is lossless for everything the tool exposes.

| | OpenAI Decisions (ours) | System One (translated) |
| --- | --- | --- |
| Endpoint | `POST /v1/decisions` | `POST /v1/systemone` |
| Text under evaluation | `input` | `state` |
| Questions | array, each with `name` | object keyed by question id |
| Yes/no | `predicate` -> `probability` | `noul` -> `noul` |
| Pick one | `choices: [{value, description}]` | `criteria: {option: description or null}` |
| Rate | `levels: [{label, description}]` | `criteria: ["level text", ...]` (one string per level, so we send `label: description`) |
| Answers | array in question order | object keyed by id |
| Probabilities | `[{value, probability}]` (score adds `label`) | `{option: p}`, score adds a `legend` map |
| Declined question | `refusal` answer | none (we synthesize a `refusal`) |

Not exposed, because only System One has them: structured (object/array) `state`, custom true/false wording for `noul`, and audio input. Pass structured data as JSON text in `input`.

### Which API is winning? (as of 2026-10-12, early days)

Both specs are days to weeks old, so this is a snapshot, not a verdict.

- **System One (`/v1/systemone`, TypeSafe/Jev):** launched 2026-09-15 and has the wider ecosystem. llama.cpp, Ollama (0.35), LM Studio, DigitalOcean Inference, LangSmith's gateway and the Kev, CLM-8B and Nace.AI servers all implement or route it. Most open-weight decision models are served through it, and the independent hub lists agent skills and MCP servers built on it. A New Stack headline says AWS, Upstage and Ollama agreed on a decision-model API, and the article text I could read didn't name which.
- **OpenAI Decisions (`/v1/decisions`):** public beta since 2026-10-06, with one model (`gpt-6-luna`). It has OpenAI's reach. LM Studio, LiteLLM and promptfoo have added support, and LangSmith lists it as a separate route. I found no evidence yet of llama.cpp, Ollama or vLLM serving it.
- **Net:** System One leads on implementations today, especially for local and open models. OpenAI's lead is distribution, and its shape is richer (arrays with names, labelled score probabilities, a refusal type). Using the OpenAI shape as the common format is a bet on where clients will go, and the translation layer means a wrong bet only costs a swap in one file.
- **Caveats:** Almost every source is a young vendor or blog page. Star counts and "everywhere" claims are unverified.

## License

[MIT](LICENSE). Use it however you like.
