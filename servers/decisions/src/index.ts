#!/usr/bin/env node
import { parseArgs, run } from "@mcp-servs/common";
import { DecisionsClient, configFromEnv } from "./client.js";
import { createServer } from "./server.js";

const client = new DecisionsClient(configFromEnv());
await run(() => createServer(client), parseArgs(process.argv.slice(2)));
