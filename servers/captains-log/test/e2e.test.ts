// Requires `npm run build` first (spawns dist/index.js).
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const text = (r: any) => r.content[0].text as string;

describe("e2e: stdio + http share one DB", () => {
  it("writes via stdio and http, reads both", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "cl-e2e-")), "e2e.db");
    const env = { ...process.env, CAPTAINS_LOG_DB: db } as Record<string, string>;

    const http = spawn("node", [entry, "--http", "--port", "0"], { env, stdio: ["ignore", "ignore", "pipe"] });
    const port = await new Promise<number>((res, rej) => {
      let buf = "";
      http.stderr!.on("data", (d) => {
        buf += d;
        const m = /:(\d+)\/mcp/.exec(buf);
        if (m) res(Number(m[1]));
      });
      http.on("exit", () => rej(new Error("http exited: " + buf)));
    });

    const stdio = new Client({ name: "t", version: "1" });
    await stdio.connect(new StdioClientTransport({ command: "node", args: [entry], env }));
    const web = new Client({ name: "t", version: "1" });
    await web.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    try {
      expect((await stdio.listTools()).tools.map((t) => t.name)).toContain("log_entry");
      await stdio.callTool({ name: "log_entry", arguments: { title: "via stdio", summary: "s", occurred_on: "2026-09-01", issues: [{ key: "A-1", tracker: "Jira", title: "Fix it" }] } });
      await web.callTool({ name: "log_entry", arguments: { title: "via http", summary: "s", occurred_on: "2026-09-02" } });

      const fromWeb = JSON.parse(text(await web.callTool({ name: "list_entries", arguments: {} })));
      expect(fromWeb.map((e: any) => e.title)).toEqual(["via stdio", "via http"]);
      const rep = JSON.parse(text(await stdio.callTool({ name: "get_report_data", arguments: { to: "2026-09-30", group_by: "issue" } })));
      expect(rep.totals.entries).toBe(2);
      expect(rep.issues).toEqual([{ tracker: "jira", key: "A-1", title: "Fix it", url: null }]);
      expect(rep.groups.map((g: any) => g.key).sort()).toEqual(["(no issue)", "jira:A-1"]);

      // Same thread logged twice (once per transport): one entry, second call reports 'exists'.
      const t = { title: "thread", summary: "first", occurred_on: "2026-09-03", platform: "claude-code", session_ref: "sess-1" };
      const first = JSON.parse(text(await stdio.callTool({ name: "log_entry", arguments: t })));
      const again = JSON.parse(text(await web.callTool({ name: "log_entry", arguments: { ...t, summary: "second" } })));
      expect(first.status).toBe("created");
      expect(again).toMatchObject({ status: "exists", id: first.id });
      expect(again.entry.summary).toBe("first");
      const found = JSON.parse(text(await web.callTool({ name: "list_entries", arguments: { session_ref: "sess-1", platform: "claude-code" } })));
      expect(found.map((e: any) => e.id)).toEqual([first.id]);
      const same = JSON.parse(text(await stdio.callTool({ name: "update_entry", arguments: { id: first.id, summary: "first" } })));
      expect(same).toEqual({ id: first.id, changed: false });
      const changed = JSON.parse(text(await stdio.callTool({ name: "update_entry", arguments: { id: first.id, summary: "revised" } })));
      expect(changed.changed).toBe(true);

      const bad = await stdio.callTool({ name: "get_entry", arguments: { id: "nope" } });
      expect(bad.isError).toBe(true);
      const p = await stdio.getPrompt({ name: "write-captains-log" });
      expect((p.messages[0].content as any).text).toContain("log_entry");
    } finally {
      await stdio.close();
      await web.close();
      http.kill();
    }
  }, 30000);
});
