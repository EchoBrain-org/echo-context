import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface SyncResult {
  ok: boolean;
  changed: string[];
  unchanged: string[];
  mcp_url: string;
}

interface AgentInstructionModule {
  resolveAgentMcpUrl(userHome: string, explicit?: string): string;
  syncAgentInstructions(options: {
    userHome: string;
    repoRoot: string;
    mcpUrl?: string;
    check: boolean;
  }): SyncResult;
}

const toolUrl = new URL(
  "../../tools/sync-agent-instructions.mjs",
  import.meta.url,
).href;
const tool = (await import(toolUrl)) as AgentInstructionModule;

const ROOT = resolve(import.meta.dirname, "..", "..");
let userHome: string;

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), "echo-context-agent-sync-"));
});

afterEach(() => {
  rmSync(userHome, { recursive: true, force: true });
});

function path(...parts: string[]): string {
  return join(userHome, ...parts);
}

describe("echo-context agent instruction sync", () => {
  it("installs exact canonical skill bytes for Codex and Claude and preserves other banner text", () => {
    mkdirSync(path(".codex"), { recursive: true });
    mkdirSync(path(".claude"), { recursive: true });
    writeFileSync(path(".codex", "AGENTS.md"), "# Personal Codex rule\n");
    writeFileSync(path(".claude", "CLAUDE.md"), "# Personal Claude rule\n");

    const first = tool.syncAgentInstructions({
      userHome,
      repoRoot: ROOT,
      mcpUrl: "http://127.0.0.1:39478/mcp",
      check: false,
    });
    expect(first.ok).toBe(true);
    expect(first.changed).toHaveLength(8);
    expect(first.mcp_url).toBe("http://127.0.0.1:39478/mcp");

    const canonicalSkill = readFileSync(
      join(ROOT, "skills", "using-echo-mcp", "SKILL.md"),
    );
    const canonicalMetadata = readFileSync(
      join(ROOT, "skills", "using-echo-mcp", "agents", "openai.yaml"),
    );
    expect(
      readFileSync(
        path(
          ".local",
          "share",
          "echo-context",
          "skills",
          "using-echo-mcp",
          "SKILL.md",
        ),
      ),
    ).toEqual(canonicalSkill);
    expect(
      readFileSync(
        path(".local", "share", "echo-context", "tools", "journal-client.mjs"),
        "utf8",
      ),
    ).toContain("resolveJournal");
    expect(
      readFileSync(path(".codex", "skills", "using-echo-mcp", "SKILL.md")),
    ).toEqual(canonicalSkill);
    expect(
      readFileSync(path(".claude", "commands", "using-echo-mcp.md")),
    ).toEqual(canonicalSkill);
    expect(
      readFileSync(
        path(".codex", "skills", "using-echo-mcp", "agents", "openai.yaml"),
      ),
    ).toEqual(canonicalMetadata);

    const codexBanner = readFileSync(path(".codex", "AGENTS.md"), "utf8");
    expect(codexBanner).toContain("# Personal Codex rule");
    expect(codexBanner).toContain("http://127.0.0.1:39478/mcp");
    expect(codexBanner).toContain("$using-echo-mcp");
    const claudeBanner = readFileSync(path(".claude", "CLAUDE.md"), "utf8");
    expect(claudeBanner).toContain("# Personal Claude rule");
    expect(claudeBanner).toContain("~/.claude/commands/using-echo-mcp.md");
    expect(existsSync(path(".cursor"))).toBe(false);

    const second = tool.syncAgentInstructions({
      userHome,
      repoRoot: ROOT,
      mcpUrl: "http://127.0.0.1:39478/mcp",
      check: false,
    });
    expect(second.changed).toEqual([]);
    expect(second.unchanged).toHaveLength(8);
  });

  it("reports drift without writing in check mode", () => {
    const before = tool.syncAgentInstructions({
      userHome,
      repoRoot: ROOT,
      mcpUrl: "http://127.0.0.1:39478/mcp",
      check: true,
    });
    expect(before.ok).toBe(false);
    expect(before.changed).toHaveLength(8);
    expect(existsSync(path(".codex", "AGENTS.md"))).toBe(false);

    tool.syncAgentInstructions({
      userHome,
      repoRoot: ROOT,
      mcpUrl: "http://127.0.0.1:39478/mcp",
      check: false,
    });
    const claudeSkill = path(".claude", "commands", "using-echo-mcp.md");
    writeFileSync(claudeSkill, "drift\n");
    const after = tool.syncAgentInstructions({
      userHome,
      repoRoot: ROOT,
      mcpUrl: "http://127.0.0.1:39478/mcp",
      check: true,
    });
    expect(after.ok).toBe(false);
    expect(after.changed).toEqual([claudeSkill]);
    expect(readFileSync(claudeSkill, "utf8")).toBe("drift\n");
  });

  it("fails before any write when a managed banner is malformed", () => {
    mkdirSync(path(".codex"), { recursive: true });
    writeFileSync(path(".codex", "AGENTS.md"), "<!-- BEGIN ECHO -->\nbroken\n");

    expect(() =>
      tool.syncAgentInstructions({
        userHome,
        repoRoot: ROOT,
        mcpUrl: "http://127.0.0.1:39478/mcp",
        check: false,
      }),
    ).toThrow("managed ECHO markers");
    expect(
      existsSync(
        path(
          ".local",
          "share",
          "echo-context",
          "skills",
          "using-echo-mcp",
          "SKILL.md",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a symlinked skill destination before writing any other target", () => {
    const outside = path("outside-skill.md");
    writeFileSync(outside, "outside\n");
    const codexSkill = path(".codex", "skills", "using-echo-mcp", "SKILL.md");
    mkdirSync(join(codexSkill, ".."), { recursive: true });
    symlinkSync(outside, codexSkill);

    expect(() =>
      tool.syncAgentInstructions({
        userHome,
        repoRoot: ROOT,
        mcpUrl: "http://127.0.0.1:39478/mcp",
        check: false,
      }),
    ).toThrow("refusing to replace symlink");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(existsSync(path(".claude", "commands", "using-echo-mcp.md"))).toBe(
      false,
    );
  });

  it("reads only a stable echo-context registry and accepts only loopback MCP URLs", () => {
    const registry = path(
      ".local",
      "share",
      "echo-context",
      "state",
      "dogfooding-journals.json",
    );
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        enabled: true,
        mcp_url: "http://127.0.0.1:39478/mcp",
        health_url: "http://127.0.0.1:39478/healthz",
      })}\n`,
    );
    expect(tool.resolveAgentMcpUrl(userHome)).toBe(
      "http://127.0.0.1:39478/mcp",
    );
    expect(() =>
      tool.resolveAgentMcpUrl(userHome, "https://example.com/mcp"),
    ).toThrow("loopback");
    expect(existsSync(path(".echo", "state"))).toBe(false);
  });

  it("refuses split MCP and health identities in an enabled registry", () => {
    const registry = path(
      ".local",
      "share",
      "echo-context",
      "state",
      "dogfooding-journals.json",
    );
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        enabled: true,
        mcp_url: "http://127.0.0.1:39478/mcp",
        health_url: "http://127.0.0.1:39479/healthz",
      })}\n`,
    );
    expect(() => tool.resolveAgentMcpUrl(userHome)).toThrow(
      "MCP and health URLs do not share an origin",
    );
  });

  it("refuses an explicit MCP URL that conflicts with enabled canonical state", () => {
    const registry = path(
      ".local",
      "share",
      "echo-context",
      "state",
      "dogfooding-journals.json",
    );
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        enabled: true,
        mcp_url: "http://127.0.0.1:39478/mcp",
        health_url: "http://127.0.0.1:39478/healthz",
      })}\n`,
    );
    expect(() =>
      tool.resolveAgentMcpUrl(userHome, "http://127.0.0.1:39479/mcp"),
    ).toThrow("--mcp-url conflicts with the enabled dogfooding registry");
    expect(
      tool.resolveAgentMcpUrl(userHome, "http://127.0.0.1:39478/mcp"),
    ).toBe("http://127.0.0.1:39478/mcp");
  });

  it("does not let an explicit URL bypass malformed canonical state", () => {
    const registry = path(
      ".local",
      "share",
      "echo-context",
      "state",
      "dogfooding-journals.json",
    );
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        enabled: "true",
        mcp_url: "http://127.0.0.1:39478/mcp",
        health_url: "http://127.0.0.1:39478/healthz",
      })}\n`,
    );
    expect(() =>
      tool.resolveAgentMcpUrl(userHome, "http://127.0.0.1:39479/mcp"),
    ).toThrow("registry enabled must be boolean");
  });

  it("permits explicit bootstrap only for absent or explicitly disabled state", () => {
    expect(
      tool.resolveAgentMcpUrl(userHome, "http://127.0.0.1:39478/mcp"),
    ).toBe("http://127.0.0.1:39478/mcp");
    const registry = path(
      ".local",
      "share",
      "echo-context",
      "state",
      "dogfooding-journals.json",
    );
    mkdirSync(join(registry, ".."), { recursive: true });
    writeFileSync(
      registry,
      `${JSON.stringify({
        enabled: false,
        mcp_url: "http://127.0.0.1:39478/mcp",
      })}\n`,
    );
    expect(
      tool.resolveAgentMcpUrl(userHome, "http://127.0.0.1:39479/mcp"),
    ).toBe("http://127.0.0.1:39479/mcp");
  });

  it("rejects credentials, queries, and fragments in MCP endpoints", () => {
    expect(() =>
      tool.resolveAgentMcpUrl(userHome, "http://token@127.0.0.1:39478/mcp"),
    ).toThrow("must be a loopback");
    expect(() =>
      tool.resolveAgentMcpUrl(
        userHome,
        "http://127.0.0.1:39478/mcp?daemon=other",
      ),
    ).toThrow("must be a loopback");
    expect(() =>
      tool.resolveAgentMcpUrl(userHome, "http://127.0.0.1:39478/mcp#other"),
    ).toThrow("must be a loopback");
  });

  it("fails closed instead of guessing a port when canonical state is absent", () => {
    expect(() => tool.resolveAgentMcpUrl(userHome)).toThrow(
      "pass --mcp-url during first sync",
    );
  });
});

describe("canonical using-echo-mcp contract", () => {
  const skill = readFileSync(
    join(ROOT, "skills", "using-echo-mcp", "SKILL.md"),
    "utf8",
  );

  it("uses context-owned stable state and live runtime identity", () => {
    expect(skill).toContain(
      "~/.local/share/echo-context/state/dogfooding-journals.json",
    );
    expect(skill).toContain("`components.runtime.details.version`");
    expect(skill).toContain("`components.runtime.details.artifact_digest`");
    expect(skill).toContain("make no ECHO call");
    expect(skill).not.toContain("onboarding");
  });

  it("keeps only the active Codex and Claude founder-live lanes", () => {
    expect(skill).toContain("`codex.md`");
    expect(skill).toContain("`claude.md`");
    expect(skill).not.toContain("codex-ops");
    expect(skill).not.toContain("cursor.md");
    expect(skill).not.toContain("Project_echo");
  });

  it("requires consent before creating a new version journal", () => {
    expect(skill).toContain(
      "`ECHO runtime <version> has no dogfooding journal. Create it now and make it current?`",
    );
    expect(skill).toContain("If the founder answers yes");
    expect(skill).toContain("Then run `resolve --actor <actor>`");
    expect(skill).toContain("again and proceed only when it returns `ready`");
    expect(skill).toContain("directory mode `0700`");
    expect(skill).toContain("file mode `0600`");
  });

  it("defines a usable and truthful append contract", () => {
    expect(skill).toContain("Every supplied value must be a non-empty string");
    expect(skill).toContain("`verdict` must begin with `right`, `partial`, or");
    expect(skill).toContain("`wrong`, followed by the reason");
    expect(skill).toContain('append returns `status: "appended"`');
    expect(skill).toContain("the ECHO call was not recorded");
  });
});
