# mcp-servs

Monorepo of locally run MCP servers (stdio and Streamable HTTP). Built with TypeScript and npm workspaces.

- `packages/mcp-common`: shared transport bootstrap (`--http`, `--port`, `--host`).
- `servers/captains-log`: audit log of AI-assisted work, backed by SQLite.

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
