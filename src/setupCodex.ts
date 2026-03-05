import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SetupCodexOptions {
  name: string;
  sqlitePath: string;
  adbBin: string;
  wdaBaseUrl?: string;
  packageName: string;
  local: boolean;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface SetupCodexDependencies {
  runCommand?: CommandRunner;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

function resolveLocalEntrypoint(): string {
  return fileURLToPath(new URL("../bin/lazy-mobile-mcp.js", import.meta.url));
}

function defaultRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8"
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function takeOptionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${args[index] ?? "option"}`);
  }

  return value;
}

function isMcpNotFoundError(stderr: string): boolean {
  return stderr.includes("No MCP server named");
}

function assertCommandOk(command: string, args: string[], result: CommandResult, hint: string): void {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`${hint}: command not found: ${command}`);
    }

    throw new Error(`${hint}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const details = stderr.length > 0 ? stderr : stdout.length > 0 ? stdout : `exit=${String(result.status)}`;
    throw new Error(`${hint}: ${command} ${args.join(" ")} -> ${details}`);
  }
}

export function createDefaultSetupCodexOptions(homeDir = os.homedir()): SetupCodexOptions {
  return {
    name: "lazy-mobile-mcp",
    sqlitePath: path.join(homeDir, ".codex", "mcp-data", "lazy-mobile", "mobile.db"),
    adbBin: "adb",
    packageName: "lazy_mobile_mcp@latest",
    local: false
  };
}

export function parseSetupCodexArgs(args: string[], defaults = createDefaultSetupCodexOptions()): SetupCodexOptions {
  const options: SetupCodexOptions = {
    ...defaults
  };
  let packageNameExplicit = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      continue;
    }

    if (arg === "--name") {
      options.name = takeOptionValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--sqlite-path") {
      options.sqlitePath = takeOptionValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--adb-bin") {
      options.adbBin = takeOptionValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--wda-base-url") {
      options.wdaBaseUrl = takeOptionValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--package-name") {
      options.packageName = takeOptionValue(args, index);
      packageNameExplicit = true;
      index += 1;
      continue;
    }

    if (arg === "--local") {
      options.local = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.local && packageNameExplicit) {
    throw new Error("--local cannot be combined with --package-name");
  }

  return options;
}

export function setupCodexUsage(): string {
  return [
    "Usage: lazy-mobile-mcp setup-codex [options]",
    "",
    "Options:",
    "  --name <name>               MCP server name (default: lazy-mobile-mcp)",
    "  --sqlite-path <path>        SQLite path (default: ~/.codex/mcp-data/lazy-mobile/mobile.db)",
    "  --adb-bin <path>            adb binary (default: adb)",
    "  --wda-base-url <url>        Optional WDA base URL",
    "  --package-name <name>       npm package for npx (default: lazy_mobile_mcp@latest)",
    "  --local                     Register the current package's local bin instead of npx",
    "  -h, --help                  Show help"
  ].join("\n");
}

export function runSetupCodex(options: SetupCodexOptions, dependencies: SetupCodexDependencies = {}): void {
  const runCommand = dependencies.runCommand ?? defaultRunner;
  const stdout = dependencies.stdout ?? process.stdout;

  const codexVersion = runCommand("codex", ["--version"]);
  assertCommandOk("codex", ["--version"], codexVersion, "Codex CLI is required");

  mkdirSync(path.dirname(options.sqlitePath), { recursive: true });

  const getArgs = ["mcp", "get", options.name, "--json"];
  const existing = runCommand("codex", getArgs);

  if (existing.status === 0) {
    const removeArgs = ["mcp", "remove", options.name];
    const removeResult = runCommand("codex", removeArgs);
    assertCommandOk("codex", removeArgs, removeResult, `Failed to remove existing MCP server '${options.name}'`);
  } else {
    const stderr = existing.stderr;
    if (!isMcpNotFoundError(stderr)) {
      assertCommandOk("codex", getArgs, existing, `Failed to inspect MCP server '${options.name}'`);
    }
  }

  const addArgs = [
    "mcp",
    "add",
    options.name,
    "--env",
    `SQLITE_PATH=${options.sqlitePath}`,
    "--env",
    `ADB_BIN=${options.adbBin}`
  ];

  if (options.wdaBaseUrl && options.wdaBaseUrl.trim().length > 0) {
    addArgs.push("--env", `WDA_BASE_URL=${options.wdaBaseUrl}`);
  }

  if (options.local) {
    addArgs.push("--", "node", resolveLocalEntrypoint());
  } else {
    addArgs.push("--", "npx", "-y", options.packageName);
  }

  const addResult = runCommand("codex", addArgs);
  assertCommandOk("codex", addArgs, addResult, `Failed to add MCP server '${options.name}'`);

  stdout.write(`Configured MCP server '${options.name}'.\n`);
  stdout.write(`Verify with: codex mcp get ${options.name}\n`);
}
