#!/usr/bin/env node
import { parseArgs, run } from "@mcp-servs/common";
import { defaultDbPath, openDb } from "./db.js";
import { createServer } from "./server.js";

const db = openDb(defaultDbPath());
await run(() => createServer(db), parseArgs(process.argv.slice(2)));
