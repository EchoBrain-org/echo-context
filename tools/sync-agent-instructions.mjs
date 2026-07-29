#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BEGIN = "<!-- BEGIN ECHO -->";
const END = "<!-- END ECHO -->";
const TOOL_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(TOOL_PATH), "..");

function fail(message) {
  throw new Error(message);
}

function regularFileOrMissing(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(`refusing to replace symlink: ${path}`);
  if (!stat.isFile()) fail(`expected regular file: ${path}`);
}

function count(text, token) {
  return text.split(token).length - 1;
}

export function upsertManagedEchoBlock(existing, block) {
  const begins = count(existing, BEGIN);
  const ends = count(existing, END);
  if (begins !== ends || begins > 1) {
    fail("managed ECHO markers are missing, duplicated, or unbalanced");
  }
  if (begins === 0) {
    return existing.trim().length === 0
      ? `${block}\n`
      : `${block}\n\n${existing.replace(/^\n+/, "")}`;
  }
  const start = existing.indexOf(BEGIN);
  const finish = existing.indexOf(END, start) + END.length;
  return `${existing.slice(0, start)}${block}${existing.slice(finish)}`;
}

function loopbackMcpUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (!loopback || parsed.protocol !== "http:" || parsed.pathname !== "/mcp")
    return null;
  return parsed.toString().replace(/\/$/, "");
}

function loopbackHealthUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (
    !loopback ||
    parsed.protocol !== "http:" ||
    parsed.pathname !== "/healthz"
  ) {
    return null;
  }
  return parsed.toString().replace(/\/$/, "");
}

export function resolveAgentMcpUrl(userHome, explicit) {
  let explicitUrl;
  if (explicit !== undefined) {
    explicitUrl = loopbackMcpUrl(explicit);
    if (explicitUrl === null)
      fail(`--mcp-url must be a loopback http /mcp URL: ${explicit}`);
  }

  const registry = join(
    userHome,
    ".local",
    "share",
    "echo-context",
    "state",
    "dogfooding-journals.json",
  );
  if (!existsSync(registry)) {
    if (explicitUrl !== undefined) return explicitUrl;
    fail(
      `no canonical ECHO MCP URL is configured; pass --mcp-url during first sync or create ${registry}`,
    );
  }
  regularFileOrMissing(registry);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registry, "utf8"));
  } catch {
    fail(`could not parse dogfooding registry: ${registry}`);
  }
  const accepted = loopbackMcpUrl(parsed?.mcp_url);
  if (parsed?.enabled !== true && explicitUrl !== undefined) {
    return explicitUrl;
  }
  if (accepted === null) {
    fail(`dogfooding registry has no valid loopback mcp_url: ${registry}`);
  }
  if (parsed?.enabled === true) {
    const health = loopbackHealthUrl(parsed?.health_url);
    if (health === null)
      fail(`enabled dogfooding registry has no valid health_url: ${registry}`);
    if (new URL(accepted).origin !== new URL(health).origin) {
      fail(`dogfooding registry MCP and health URLs do not share an origin`);
    }
    if (explicitUrl !== undefined && explicitUrl !== accepted) {
      fail(`--mcp-url conflicts with the enabled dogfooding registry`);
    }
  }
  return accepted;
}

export function renderAgentEchoBlock(agent, mcpUrl) {
  const instruction =
    agent === "codex"
      ? "Before calling ECHO, follow the installed `$using-echo-mcp` skill."
      : "Before calling ECHO, read and follow `~/.claude/commands/using-echo-mcp.md`.";
  return [
    BEGIN,
    "# ECHO",
    "",
    `ECHO context is available through the \`echo\` MCP server at \`${mcpUrl}\`.`,
    "",
    instruction,
    "On founder-live machines, those instructions also bind every ECHO-using turn to the live runtime’s versioned dogfooding journal.",
    "",
    "<!-- echo-context-agent-instructions: 1 -->",
    "",
    END,
  ].join("\n");
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function atomicWrite(path, content, mode) {
  regularFileOrMissing(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort
    }
    throw error;
  }
}

function sourceBytes(repoRoot, relativePath) {
  const path = resolve(repoRoot, relativePath);
  if (!path.startsWith(`${resolve(repoRoot)}/`))
    fail(`source escapes repository: ${path}`);
  regularFileOrMissing(path);
  if (!existsSync(path)) fail(`missing canonical source: ${path}`);
  return readFileSync(path);
}

export function buildAgentInstructionPlan({
  userHome,
  repoRoot = REPO_ROOT,
  mcpUrl,
}) {
  const skill = sourceBytes(repoRoot, "skills/using-echo-mcp/SKILL.md");
  const metadata = sourceBytes(
    repoRoot,
    "skills/using-echo-mcp/agents/openai.yaml",
  );
  const journalClient = sourceBytes(
    repoRoot,
    "tools/dogfooding/journal-client.mjs",
  );
  const codexBanner = join(userHome, ".codex", "AGENTS.md");
  const claudeBanner = join(userHome, ".claude", "CLAUDE.md");
  regularFileOrMissing(codexBanner);
  regularFileOrMissing(claudeBanner);

  const currentCodexBanner = existsSync(codexBanner)
    ? readFileSync(codexBanner, "utf8")
    : "";
  const currentClaudeBanner = existsSync(claudeBanner)
    ? readFileSync(claudeBanner, "utf8")
    : "";

  return [
    {
      path: join(
        userHome,
        ".local",
        "share",
        "echo-context",
        "tools",
        "journal-client.mjs",
      ),
      content: journalClient,
      mode: 0o755,
    },
    {
      path: join(
        userHome,
        ".local",
        "share",
        "echo-context",
        "skills",
        "using-echo-mcp",
        "SKILL.md",
      ),
      content: skill,
      mode: 0o644,
    },
    {
      path: join(
        userHome,
        ".local",
        "share",
        "echo-context",
        "skills",
        "using-echo-mcp",
        "agents",
        "openai.yaml",
      ),
      content: metadata,
      mode: 0o644,
    },
    {
      path: join(userHome, ".codex", "skills", "using-echo-mcp", "SKILL.md"),
      content: skill,
      mode: 0o644,
    },
    {
      path: join(
        userHome,
        ".codex",
        "skills",
        "using-echo-mcp",
        "agents",
        "openai.yaml",
      ),
      content: metadata,
      mode: 0o644,
    },
    {
      path: join(userHome, ".claude", "commands", "using-echo-mcp.md"),
      content: skill,
      mode: 0o644,
    },
    {
      path: codexBanner,
      content: Buffer.from(
        upsertManagedEchoBlock(
          currentCodexBanner,
          renderAgentEchoBlock("codex", mcpUrl),
        ),
      ),
      mode: 0o644,
    },
    {
      path: claudeBanner,
      content: Buffer.from(
        upsertManagedEchoBlock(
          currentClaudeBanner,
          renderAgentEchoBlock("claude", mcpUrl),
        ),
      ),
      mode: 0o644,
    },
  ];
}

export function syncAgentInstructions(options) {
  const mcpUrl = resolveAgentMcpUrl(options.userHome, options.mcpUrl);
  const plan = buildAgentInstructionPlan({ ...options, mcpUrl });
  for (const entry of plan) regularFileOrMissing(entry.path);

  const changed = [];
  const unchanged = [];
  for (const entry of plan) {
    const current = existsSync(entry.path) ? readFileSync(entry.path) : null;
    if (current !== null && current.equals(entry.content)) {
      unchanged.push(entry.path);
      continue;
    }
    changed.push(entry.path);
  }

  if (!options.check) {
    for (const entry of plan) {
      if (changed.includes(entry.path))
        atomicWrite(entry.path, entry.content, entry.mode);
    }
  }

  return {
    ok: changed.length === 0 || !options.check,
    mode: options.check ? "check" : "sync",
    mcp_url: mcpUrl,
    skill_sha256: hash(
      sourceBytes(
        options.repoRoot ?? REPO_ROOT,
        "skills/using-echo-mcp/SKILL.md",
      ),
    ),
    changed,
    unchanged,
  };
}

function parseArgs(argv) {
  const options = {
    userHome: homedir(),
    repoRoot: REPO_ROOT,
    check: false,
    mcpUrl: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--home" || arg === "--repo" || arg === "--mcp-url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        fail(`${arg} requires a value`);
      if (arg === "--home") options.userHome = resolve(value);
      if (arg === "--repo") options.repoRoot = resolve(value);
      if (arg === "--mcp-url") options.mcpUrl = value;
      index += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  try {
    const result = syncAgentInstructions(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
