import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeError, toErrorResponse } from "./errors.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { PolicyGuard } from "./policyGuard.js";
import { highRiskTools, toolDescriptions, toolValidators, ToolName } from "./toolSchemas.js";
import { WorkerClient } from "./workerClient.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function extractDeviceId(args: Record<string, unknown>): string | undefined {
  const candidate = args.device_id;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return undefined;
}

type ToolOutput = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  const workerClient = new WorkerClient({
    sqlitePath: config.sqlitePath,
    allowlist: config.allowlist,
    logger,
    adbBin: config.adbBin,
    wdaBaseUrl: config.wdaBaseUrl
  });
  await workerClient.start();

  const policyGuard = new PolicyGuard({
    allowlist: config.allowlist,
    highRiskTools
  });

  const server = new McpServer({
    name: "lazy-mobile-mcp",
    version: "1.0.3"
  });

  const registerTool = (toolName: ToolName): void => {
    (server as any).registerTool(
      toolName,
      {
        description: toolDescriptions[toolName],
        inputSchema: toolValidators[toolName]
      },
      async (argsInput: unknown): Promise<ToolOutput> => {
        const traceId = randomUUID();
        const argsRecord = asRecord(argsInput);

        try {
          const parsedArgs = toolValidators[toolName].parse(argsRecord);
          const parsedArgsRecord = asRecord(parsedArgs);

          policyGuard.assertToolRisk({
            toolName,
            args: parsedArgsRecord
          });

          const deviceId = extractDeviceId(parsedArgsRecord);
          if (deviceId) {
            policyGuard.assertDeviceAllowed(deviceId);
          }

          logger.info("tool-call", {
            trace_id: traceId,
            tool: toolName,
            device_id: deviceId ?? null
          });

          const result = await workerClient.call(toolName, parsedArgsRecord, traceId);
          const structuredContent = {
            ...result,
            trace_id: traceId
          };

          return {
            content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
            structuredContent
          };
        } catch (error: unknown) {
          const appError = normalizeError(error, traceId);
          const errorResponse = toErrorResponse(appError);

          logger.error("tool-error", {
            trace_id: errorResponse.trace_id,
            tool: toolName,
            code: errorResponse.code,
            category: appError.category,
            error: errorResponse.error
          });

          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }],
            structuredContent: errorResponse as unknown as Record<string, unknown>
          };
        }
      }
    );
  };

  for (const toolName of Object.keys(toolValidators) as ToolName[]) {
    registerTool(toolName);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("server-started", {
    transport: "stdio",
    sqlite_path: config.sqlitePath
  });

  const shutdown = async (): Promise<void> => {
    logger.info("server-shutdown", {});
    await workerClient.stop();
    await server.close();
  };

  process.on("SIGINT", () => {
    shutdown().catch((error) => {
      const appError = error instanceof Error ? error : new Error("Unexpected shutdown error");
      logger.error("server-shutdown-failed", { message: appError.message });
    });
  });

  process.on("SIGTERM", () => {
    shutdown().catch((error) => {
      const appError = error instanceof Error ? error : new Error("Unexpected shutdown error");
      logger.error("server-shutdown-failed", { message: appError.message });
    });
  });
}

main().catch((error: unknown) => {
  const appError = normalizeError(error, randomUUID());
  const response = toErrorResponse(appError);
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exit(1);
});
