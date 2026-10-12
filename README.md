# mcp-servs

Monorepo of locally run MCP servers (stdio and Streamable HTTP). Built with TypeScript and npm workspaces.

- `packages/mcp-common`: shared transport bootstrap (`--http`, `--port`, `--host`).
- `servers/captains-log`: audit log of AI-assisted work, backed by SQLite.
- `servers/decisions`: typed questions answered by a decision model (OpenAI Decisions or System One backends).

```sh
npm install && npm run build && npm test
```

## captains-log

Stores one entry per unit of work (usually one agent thread): detailed summary, effort, JIRA keys, tags, outcome, time estimates, token/cost usage, and free-form **sources**. Sources are anything that fed the work (tickets, PRs, chats, docs, meetings), gathered by the skill from whatever tools the agent has connected. The server doesn't integrate with those systems itself.

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

### Which API is winning? (as of 2026-10-12, early days)

Both specs are days to weeks old, so this is a snapshot, not a verdict.

- **System One (`/v1/systemone`, TypeSafe/Jev):** launched 2026-09-15 and has the wider ecosystem. llama.cpp, Ollama (0.35), LM Studio, DigitalOcean Inference, LangSmith's gateway and the Kev, CLM-8B and Nace.AI servers all implement or route it. Most open-weight decision models are served through it, and the independent hub lists agent skills and MCP servers built on it. A New Stack headline says AWS, Upstage and Ollama agreed on a decision-model API, and the article text I could read didn't name which.
- **OpenAI Decisions (`/v1/decisions`):** public beta since 2026-10-06, with one model (`gpt-6-luna`). It has OpenAI's reach. LM Studio, LiteLLM and promptfoo have added support, and LangSmith lists it as a separate route. I found no evidence yet of llama.cpp, Ollama or vLLM serving it.
- **Net:** System One leads on implementations today, especially for local and open models. OpenAI's lead is distribution, and its shape is richer (arrays with names, labelled score probabilities, a refusal type). Using the OpenAI shape as the common format is a bet on where clients will go, and the translation layer means a wrong bet only costs a swap in one file.
- **Caveats:** Almost every source is a young vendor or blog page. Star counts and "everywhere" claims are unverified.
