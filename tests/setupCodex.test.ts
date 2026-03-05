import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDefaultSetupCodexOptions,
  parseSetupCodexArgs,
  runSetupCodex,
  setupCodexUsage,
  type CommandResult,
  type CommandRunner
} from "../src/setupCodex.js";

interface Call {
  command: string;
  args: string[];
}

function makeRunner(results: CommandResult[]): { runCommand: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    runCommand: (command, args) => {
      calls.push({ command, args });
      const result = results.shift();
      if (!result) {
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      }
      return result;
    }
  };
}

const expectedLocalEntrypoint = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "lazy-mobile-mcp.js"
);

describe("setupCodex", () => {
  it("uses default options from home directory", () => {
    const options = createDefaultSetupCodexOptions("/tmp/home");

    expect(options.name).toBe("lazy-mobile-mcp");
    expect(options.sqlitePath).toBe(path.join("/tmp/home", ".codex", "mcp-data", "lazy-mobile", "mobile.db"));
    expect(options.adbBin).toBe("adb");
    expect(options.packageName).toBe("lazy_mobile_mcp@latest");
    expect(options.local).toBe(false);
  });

  it("shows latest package in usage output", () => {
    expect(setupCodexUsage()).toContain("default: lazy_mobile_mcp@latest");
    expect(setupCodexUsage()).toContain("--local");
  });

  it("parses setup arguments", () => {
    const options = parseSetupCodexArgs([
      "--name",
      "custom-mcp",
      "--sqlite-path",
      "/tmp/custom.db",
      "--adb-bin",
      "/usr/local/bin/adb",
      "--wda-base-url",
      "http://127.0.0.1:8100"
    ]);

    expect(options.name).toBe("custom-mcp");
    expect(options.sqlitePath).toBe("/tmp/custom.db");
    expect(options.adbBin).toBe("/usr/local/bin/adb");
    expect(options.wdaBaseUrl).toBe("http://127.0.0.1:8100");
    expect(options.local).toBe(false);
  });

  it("parses local mode", () => {
    const options = parseSetupCodexArgs(["--local"]);

    expect(options.local).toBe(true);
    expect(options.packageName).toBe("lazy_mobile_mcp@latest");
  });

  it("rejects --local with --package-name", () => {
    expect(() => parseSetupCodexArgs(["--local", "--package-name", "lazy_mobile_mcp@next"])).toThrow(
      /--local cannot be combined with --package-name/
    );
  });

  it("adds server when not found", () => {
    const runner = makeRunner([
      { status: 0, stdout: "1.0.0", stderr: "" },
      { status: 1, stdout: "", stderr: "Error: No MCP server named 'lazy-mobile-mcp' found." },
      { status: 0, stdout: "", stderr: "" }
    ]);

    const out: string[] = [];

    runSetupCodex(
        {
          name: "lazy-mobile-mcp",
          sqlitePath: "/tmp/mobile.db",
          adbBin: "adb",
          packageName: "lazy_mobile_mcp",
          local: false
        },
        {
          runCommand: runner.runCommand,
          stdout: { write: (text: string) => out.push(text) }
      }
    );

    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]).toEqual({ command: "codex", args: ["--version"] });
    expect(runner.calls[1]).toEqual({ command: "codex", args: ["mcp", "get", "lazy-mobile-mcp", "--json"] });
    expect(runner.calls[2]).toEqual({
      command: "codex",
      args: [
        "mcp",
        "add",
        "lazy-mobile-mcp",
        "--env",
        "SQLITE_PATH=/tmp/mobile.db",
        "--env",
        "ADB_BIN=adb",
        "--",
        "npx",
        "-y",
        "lazy_mobile_mcp"
      ]
    });
    expect(out.join(" ")).toContain("Configured MCP server");
  });

  it("removes existing server before add", () => {
    const runner = makeRunner([
      { status: 0, stdout: "1.0.0", stderr: "" },
      { status: 0, stdout: "{}", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" }
    ]);

    runSetupCodex(
        {
          name: "lazy-mobile-mcp",
          sqlitePath: "/tmp/mobile.db",
          adbBin: "adb",
          packageName: "lazy_mobile_mcp",
          wdaBaseUrl: "http://127.0.0.1:8100",
          local: false
        },
        {
          runCommand: runner.runCommand,
          stdout: { write: () => 0 }
        }
    );

    expect(runner.calls.map((item) => item.args.slice(0, 3))).toEqual([
      ["--version"],
      ["mcp", "get", "lazy-mobile-mcp"],
      ["mcp", "remove", "lazy-mobile-mcp"],
      ["mcp", "add", "lazy-mobile-mcp"]
    ]);

    const addCall = runner.calls[3];
    expect(addCall?.args).toContain("WDA_BASE_URL=http://127.0.0.1:8100");
  });

  it("uses the local bin entrypoint when --local is enabled", () => {
    const runner = makeRunner([
      { status: 0, stdout: "1.0.0", stderr: "" },
      { status: 1, stdout: "", stderr: "Error: No MCP server named 'lazy-mobile-mcp' found." },
      { status: 0, stdout: "", stderr: "" }
    ]);

    runSetupCodex(
      {
        name: "lazy-mobile-mcp",
        sqlitePath: "/tmp/mobile.db",
        adbBin: "adb",
        packageName: "lazy_mobile_mcp@latest",
        local: true
      },
      {
        runCommand: runner.runCommand,
        stdout: { write: () => 0 }
      }
    );

    expect(runner.calls[2]).toEqual({
      command: "codex",
      args: [
        "mcp",
        "add",
        "lazy-mobile-mcp",
        "--env",
        "SQLITE_PATH=/tmp/mobile.db",
        "--env",
        "ADB_BIN=adb",
        "--",
        "node",
        expectedLocalEntrypoint
      ]
    });
  });

  it("fails when codex cli is missing", () => {
    const runner = makeRunner([
      {
        status: 1,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })
      }
    ]);

    expect(() =>
      runSetupCodex(
        {
          name: "lazy-mobile-mcp",
          sqlitePath: "/tmp/mobile.db",
          adbBin: "adb",
          packageName: "lazy_mobile_mcp",
          local: false
        },
        {
          runCommand: runner.runCommand,
          stdout: { write: () => 0 }
        }
      )
    ).toThrow(/Codex CLI is required/);
  });

  it("fails when mcp get returns unexpected error", () => {
    const runner = makeRunner([
      { status: 0, stdout: "1.0.0", stderr: "" },
      { status: 1, stdout: "", stderr: "network error" }
    ]);

    expect(() =>
      runSetupCodex(
        {
          name: "lazy-mobile-mcp",
          sqlitePath: "/tmp/mobile.db",
          adbBin: "adb",
          packageName: "lazy_mobile_mcp",
          local: false
        },
        {
          runCommand: runner.runCommand,
          stdout: { write: () => 0 }
        }
      )
    ).toThrow(/Failed to inspect MCP server/);
  });
});
