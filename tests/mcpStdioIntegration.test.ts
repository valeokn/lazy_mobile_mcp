import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { toolValidators } from "../src/toolSchemas.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lazy-mobile-mcp-integration-"));
  tempDirs.push(dir);
  return dir;
}

function makeFakeAdb(dir: string): string {
  const adbPath = path.join(dir, "fake-adb");
  writeFileSync(
    adbPath,
    `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\n\\n'
  exit 0
fi
printf 'unsupported fake adb invocation: %s\\n' "$*" >&2
exit 1
`
  );
  chmodSync(adbPath, 0o755);
  return adbPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }

    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP stdio integration", () => {
  it(
    "serves object input schemas and accepts mobile.list_devices over stdio",
    async () => {
      const tempDir = makeTempDir();
      const adbBin = makeFakeAdb(tempDir);
      const sqlitePath = path.join(tempDir, "mobile.db");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
        env: {
          ...process.env,
          LOG_LEVEL: "error",
          SQLITE_PATH: sqlitePath,
          ADB_BIN: adbBin
        }
      });
      const client = new Client({ name: "integration-test-client", version: "1.0.0" });

      try {
        await client.connect(transport);

        const toolsResult = await client.listTools();
        const toolNames = toolsResult.tools.map((tool) => tool.name).sort();

        expect(toolNames).toEqual(Object.keys(toolValidators).sort());
        expect(toolsResult.tools.every((tool) => tool.inputSchema?.type === "object")).toBe(true);

        const launchAppTool = toolsResult.tools.find((tool) => tool.name === "mobile.launch_app");
        const tapTool = toolsResult.tools.find((tool) => tool.name === "mobile.tap");

        expect(launchAppTool?.inputSchema.properties).toHaveProperty("app_id");
        expect(tapTool?.inputSchema.properties).toHaveProperty("x");
        expect(tapTool?.inputSchema.properties).toHaveProperty("y");

        const listDevicesResult = await client.callTool({
          name: "mobile.list_devices",
          arguments: { platform: "android" }
        });

        expect(listDevicesResult.isError).not.toBe(true);
        expect(listDevicesResult.structuredContent).toMatchObject({
          devices: expect.any(Array),
          trace_id: expect.any(String)
        });
      } finally {
        await client.close();
      }
    },
    15_000
  );
});
