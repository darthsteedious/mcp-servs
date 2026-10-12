#!/usr/bin/env node
// Install the captain's log skills into an agent platform.
// Usage: node scripts/install-skills.mjs --target <claude|agents|codex|cursor|agents-md|dir:PATH> [--copy] [--project DIR]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const target = flag("--target");
const copy = args.includes("--copy");
const project = resolve(flag("--project") ?? process.cwd());
const skills = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

const skillDirs = {
  claude: join(homedir(), ".claude", "skills"),
  agents: join(homedir(), ".agents", "skills"), // generic Agent Skills location
  codex: join(homedir(), ".codex", "skills"),
};

const strip = (t) => t.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const desc = (t) => /^description:\s*(.*)$/m.exec(t)?.[1] ?? "";

function installDir(base) {
  mkdirSync(base, { recursive: true });
  for (const s of skills) {
    const dest = join(base, s);
    rmSync(dest, { recursive: true, force: true });
    if (copy) cpSync(join(root, s), dest, { recursive: true });
    else symlinkSync(join(root, s), dest, "dir");
    console.log(`${copy ? "copied" : "linked"} ${s} -> ${dest}`);
  }
}

if (!target) { console.error("Missing --target (claude|agents|codex|cursor|agents-md|dir:PATH)"); process.exit(1); }

if (skillDirs[target]) installDir(skillDirs[target]);
else if (target.startsWith("dir:")) installDir(resolve(target.slice(4)));
else if (target === "cursor") {
  const dir = join(project, ".cursor", "rules");
  mkdirSync(dir, { recursive: true });
  for (const s of skills) {
    const raw = readFileSync(join(root, s, "SKILL.md"), "utf8");
    const out = join(dir, `${s}.mdc`);
    writeFileSync(out, `---\ndescription: ${desc(raw)}\nalwaysApply: false\n---\n\n${strip(raw)}\n`);
    console.log(`wrote ${out}`);
  }
} else if (target === "agents-md") {
  const file = join(project, "AGENTS.md");
  const begin = "<!-- captains-log:begin -->", end = "<!-- captains-log:end -->";
  const block = [begin, "# Captain's log workflows", ...skills.map((s) => {
    const raw = readFileSync(join(root, s, "SKILL.md"), "utf8");
    return `\n## ${s}\n\n${strip(raw).replace(/^# .*\n+/, "")}`;
  }), end].join("\n");
  let cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (re.test(cur)) writeFileSync(file, cur.replace(re, () => block));
  else appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + block + "\n");
  console.log(`updated ${file}`);
} else { console.error(`Unknown target: ${target}`); process.exit(1); }
