import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DependencyError } from "../errors.js";

type TargetType = "simulator" | "physical" | "unknown";

export interface IOSAdapterOptions {
  wdaBaseUrl?: string;
}

export interface ParsedXctraceDevice {
  deviceId: string;
  name: string;
  targetType: TargetType;
}

export interface IOSDevice {
  [key: string]: unknown;
  device_id: string;
  platform: "ios";
  state: "available";
  name: string;
  target_type: TargetType;
  capabilities: {
    actions: string[];
    metrics: string[];
    unsupported: string[];
  };
}

interface CurlResult {
  statusCode: number;
  body: string;
}

export class IOSAdapter {
  private wdaBaseUrl?: string;
  private readonly deviceKinds = new Map<string, TargetType>();
  private readonly wdaSessions = new Map<string, string>();
  private readonly wdaDiscoveryPorts = new Set([8100, 8101, 8200, 8201]);

  constructor(options: IOSAdapterOptions = {}) {
    this.wdaBaseUrl = options.wdaBaseUrl;
  }

  get isSupportedHost(): boolean {
    return process.platform === "darwin";
  }

  listDevices(): IOSDevice[] {
    if (!this.isSupportedHost) {
      return [];
    }

    const output = this.run(["xcrun", "xctrace", "list", "devices"]).stdout;
    const devices: IOSDevice[] = [];

    for (const line of output.split(/\r?\n/)) {
      const parsed = IOSAdapter.parseXctraceDeviceLine(line);
      if (!parsed) {
        continue;
      }

      this.deviceKinds.set(parsed.deviceId, parsed.targetType);
      devices.push({
        device_id: parsed.deviceId,
        platform: "ios",
        state: "available",
        name: parsed.name,
        target_type: parsed.targetType,
        capabilities: this.getCapabilities({ deviceId: parsed.deviceId })
      });
    }

    return devices;
  }

  getCapabilities(input: { deviceId?: string } = {}): {
    actions: string[];
    metrics: string[];
    unsupported: string[];
  } {
    const targetType = this.deviceKinds.get(input.deviceId ?? "") ?? "unknown";
    const wdaAvailable = this.hasWdaEndpoint();

    const actions = new Set<string>(["mobile.launch_app", "mobile.stop_app"]);
    const unsupported = new Set<string>(["fps", "jank_pct"]);

    if (targetType === "simulator" || targetType === "unknown" || (targetType === "physical" && wdaAvailable)) {
      actions.add("mobile.screenshot");
    } else {
      unsupported.add("mobile.screenshot");
    }

    if (wdaAvailable) {
      actions.add("mobile.tap");
      actions.add("mobile.swipe");
      actions.add("mobile.input_text");
    } else {
      unsupported.add("mobile.tap");
      unsupported.add("mobile.swipe");
      unsupported.add("mobile.input_text");
    }

    return {
      actions: [...actions].sort(),
      metrics: ["cpu_pct", "memory_mb", "launch_ms"],
      unsupported: [...unsupported].sort()
    };
  }

  screenshot(input: { deviceId: string; outputPath: string }): { path: string; width: number; height: number } {
    if (!this.isSupportedHost) {
      throw new DependencyError("iOS tools require macOS host");
    }

    const targetType = this.deviceTypeFor(input.deviceId);
    mkdirSync(path.dirname(input.outputPath), { recursive: true });

    if (targetType === "physical") {
      writeFileSync(input.outputPath, this.wdaScreenshotPng());
      return {
        path: input.outputPath,
        width: 0,
        height: 0
      };
    }

    this.ensureSimulatorBooted(input.deviceId);
    this.run(["xcrun", "simctl", "io", input.deviceId, "screenshot", input.outputPath]);
    return {
      path: input.outputPath,
      width: 0,
      height: 0
    };
  }

  tap(input: { deviceId: string; x: number; y: number }): void {
    this.wdaCallWithSession({
      deviceId: input.deviceId,
      method: "POST",
      sessionPath: "/wda/tap",
      payload: {
        x: input.x,
        y: input.y
      }
    });
  }

  swipe(input: { deviceId: string; x1: number; y1: number; x2: number; y2: number; durationMs: number }): void {
    this.wdaCallWithSession({
      deviceId: input.deviceId,
      method: "POST",
      sessionPath: "/wda/dragfromtoforduration",
      payload: {
        fromX: input.x1,
        fromY: input.y1,
        toX: input.x2,
        toY: input.y2,
        duration: Math.max(input.durationMs / 1000, 0.01)
      }
    });
  }

  inputText(input: { deviceId: string; text: string }): void {
    this.wdaCallWithSession({
      deviceId: input.deviceId,
      method: "POST",
      sessionPath: "/wda/keys",
      payload: {
        value: input.text.split("")
      }
    });
  }

  launchApp(input: { deviceId: string; appId: string; coldStart: boolean }): { launch_ms: number } {
    if (!this.isSupportedHost) {
      throw new DependencyError("iOS tools require macOS host");
    }

    const start = process.hrtime.bigint();
    const targetType = this.deviceTypeFor(input.deviceId);

    if (targetType === "simulator") {
      this.ensureSimulatorBooted(input.deviceId);
      if (input.coldStart) {
        try {
          this.run(["xcrun", "simctl", "terminate", input.deviceId, input.appId]);
        } catch (error: unknown) {
          if (!(error instanceof DependencyError) || !IOSAdapter.isIgnorableSimulatorTerminateError(error.message)) {
            throw error;
          }
        }
      }
      this.run(["xcrun", "simctl", "launch", input.deviceId, input.appId]);
    } else {
      if (input.coldStart) {
        this.stopApp({ deviceId: input.deviceId, appId: input.appId });
      }

      this.runDevicectlJson([
        "device",
        "process",
        "launch",
        "--device",
        input.deviceId,
        "--terminate-existing",
        "--activate",
        input.appId
      ]);
    }

    const launchMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    return { launch_ms: launchMs };
  }

  stopApp(input: { deviceId: string; appId: string }): void {
    if (!this.isSupportedHost) {
      throw new DependencyError("iOS tools require macOS host");
    }

    const targetType = this.deviceTypeFor(input.deviceId);

    if (targetType === "simulator") {
      this.run(["xcrun", "simctl", "terminate", input.deviceId, input.appId]);
      return;
    }

    const processesPayload = this.runDevicectlJson(["device", "info", "processes", "--device", input.deviceId]);
    const pid = IOSAdapter.findPidFromProcessesPayload(processesPayload, input.appId);

    if (pid === null) {
      return;
    }

    this.runDevicectlJson(["device", "process", "terminate", "--device", input.deviceId, "--pid", String(pid)]);
  }

  collectMetrics(input: { deviceId: string; appId: string; metrics: string[] }): Record<string, number> {
    void input.deviceId;
    void input.appId;

    const result: Record<string, number> = {};
    for (const metric of input.metrics) {
      if (metric === "cpu_pct" || metric === "memory_mb" || metric === "launch_ms") {
        result[metric] = 0;
      }
    }
    return result;
  }

  protected run(command: string[]): { stdout: string; stderr: string } {
    const result = spawnSync(command[0] ?? "", command.slice(1), {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.error) {
      throw new DependencyError(result.error.message);
    }

    if (result.status !== 0) {
      throw new DependencyError(
        JSON.stringify({
          command,
          code: result.status,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? ""
        })
      );
    }

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  }

  protected runDevicectlJson(subcommandArgs: string[]): Record<string, unknown> {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "lazy-mobile-devicectl-"));
    const jsonPath = path.join(tempDir, "output.json");

    try {
      this.run(["xcrun", "devicectl", "--quiet", "--json-output", jsonPath, ...subcommandArgs]);
      const text = readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new DependencyError("devicectl JSON output is invalid");
      }
      return parsed as Record<string, unknown>;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  protected discoverWdaBaseUrl(): string | null {
    for (const candidate of this.candidateWdaBaseUrls()) {
      if (this.probeWdaBaseUrl(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  protected wdaJsonCall(method: string, urlPath: string, payload: Record<string, unknown> | null): Record<string, unknown> {
    const baseUrl = this.getWdaBaseUrl();
    const targetUrl = `${baseUrl.replace(/\/$/, "")}${urlPath}`;
    const response = this.curlJson({
      method,
      url: targetUrl,
      payload,
      timeoutSeconds: 10
    });

    if (response.statusCode >= 300) {
      throw new DependencyError(`WDA request failed with status ${response.statusCode}`);
    }

    if (response.body.trim().length === 0) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (error: unknown) {
      throw new DependencyError("WDA response is not valid JSON", { cause: error });
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DependencyError("WDA response is not a JSON object");
    }

    return parsed as Record<string, unknown>;
  }

  public peekWdaBaseUrl(): string | null {
    return this.wdaBaseUrl ?? null;
  }

  protected clearWdaBaseUrl(): void {
    this.wdaBaseUrl = undefined;
  }

  private ensureSimulatorBooted(deviceId: string): void {
    if (this.isSimulatorBooted(deviceId)) {
      return;
    }

    this.run(["xcrun", "simctl", "boot", deviceId]);
    this.run(["xcrun", "simctl", "bootstatus", deviceId, "-b"]);
  }

  private isSimulatorBooted(deviceId: string): boolean {
    const output = this.run(["xcrun", "simctl", "list", "devices", deviceId]).stdout;
    return output.split(/\r?\n/).some((line) => line.includes(deviceId) && line.includes("(Booted)"));
  }

  private deviceTypeFor(deviceId: string): TargetType {
    const known = this.deviceKinds.get(deviceId);
    if (known) {
      return known;
    }

    for (const device of this.listDevices()) {
      if (device.device_id === deviceId) {
        return device.target_type;
      }
    }

    return "unknown";
  }

  private wdaCallWithSession(input: {
    deviceId: string;
    method: string;
    sessionPath: string;
    payload: Record<string, unknown>;
  }): void {
    const sessionId = this.ensureWdaSession(input.deviceId);
    const fullPath = `/session/${sessionId}${input.sessionPath}`;

    try {
      this.wdaJsonCall(input.method, fullPath, input.payload);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !IOSAdapter.isInvalidSessionError(error)) {
        throw error;
      }

      this.invalidateWdaSession(input.deviceId, sessionId);
      const retrySessionId = this.ensureWdaSession(input.deviceId);
      this.wdaJsonCall(input.method, `/session/${retrySessionId}${input.sessionPath}`, input.payload);
    }
  }

  private ensureWdaSession(deviceId: string): string {
    this.getWdaBaseUrl();

    const existing = this.wdaSessions.get(deviceId);
    if (existing) {
      return existing;
    }

    const targetType = this.deviceTypeFor(deviceId);
    if (targetType === "simulator") {
      this.ensureSimulatorBooted(deviceId);
    }

    const payloadCandidates: Array<Record<string, unknown> | null> = [
      {
        capabilities: {
          alwaysMatch: { udid: deviceId },
          firstMatch: [{}]
        }
      },
      { desiredCapabilities: { udid: deviceId } },
      null
    ];

    const errors: string[] = [];

    for (const payload of payloadCandidates) {
      try {
        const response = this.wdaJsonCall("POST", "/session", payload);
        const sessionId = IOSAdapter.extractSessionId(response);
        if (!sessionId) {
          errors.push("missing session id");
          continue;
        }

        this.wdaSessions.set(deviceId, sessionId);
        return sessionId;
      } catch (error: unknown) {
        if (error instanceof Error) {
          errors.push(error.message);
          continue;
        }

        errors.push("unknown WDA session error");
      }
    }

    throw new DependencyError(`Unable to create WDA session for device ${deviceId}: ${errors.join(" | ")}`);
  }

  private invalidateWdaSession(deviceId: string, expectedSessionId: string | null = null): void {
    const existing = this.wdaSessions.get(deviceId);
    if (!existing) {
      return;
    }

    if (expectedSessionId && existing !== expectedSessionId) {
      return;
    }

    this.wdaSessions.delete(deviceId);
  }

  private wdaScreenshotPng(): Buffer {
    const payload = this.wdaJsonCall("GET", "/screenshot", null);
    const value = payload.value;

    if (typeof value !== "string" || value.length === 0) {
      throw new DependencyError("WDA screenshot payload is missing image data");
    }

    const encoded = value.startsWith("data:image") && value.includes(",") ? value.split(",", 2)[1] ?? "" : value;

    try {
      return Buffer.from(encoded, "base64");
    } catch (error: unknown) {
      throw new DependencyError("WDA screenshot payload is not valid base64", { cause: error });
    }
  }

  private getWdaBaseUrl(): string {
    if (this.wdaBaseUrl) {
      return this.wdaBaseUrl;
    }

    const discovered = this.discoverWdaBaseUrl();
    if (!discovered) {
      throw new DependencyError(
        "WDA base URL is not configured and auto-discovery failed. Provide WDA_BASE_URL or ensure WDA is reachable on localhost."
      );
    }

    this.wdaBaseUrl = discovered;
    return discovered;
  }

  private hasWdaEndpoint(): boolean {
    if (this.wdaBaseUrl) {
      return true;
    }

    const discovered = this.discoverWdaBaseUrl();
    if (!discovered) {
      return false;
    }

    this.wdaBaseUrl = discovered;
    return true;
  }

  private candidateWdaBaseUrls(): string[] {
    const ports = new Set<number>(this.wdaDiscoveryPorts);
    for (const port of this.listLocalListeningPorts()) {
      if (port >= 8000 && port <= 9000) {
        ports.add(port);
      }
    }

    const sorted = [...ports].sort((a, b) => a - b);
    const candidates: string[] = [];
    for (const port of sorted) {
      candidates.push(`http://127.0.0.1:${port}`);
      candidates.push(`http://localhost:${port}`);
    }
    return candidates;
  }

  private listLocalListeningPorts(): number[] {
    try {
      const result = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
        encoding: "utf-8",
        timeout: 3_000,
        maxBuffer: 10 * 1024 * 1024
      });

      if (result.error || result.status !== 0) {
        return [];
      }

      const ports: number[] = [];
      for (const line of (result.stdout ?? "").split(/\r?\n/)) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (!match?.[1]) {
          continue;
        }

        const parsed = Number(match[1]);
        if (!Number.isNaN(parsed)) {
          ports.push(parsed);
        }
      }

      return ports;
    } catch (error: unknown) {
      void error;
      return [];
    }
  }

  private probeWdaBaseUrl(baseUrl: string): boolean {
    try {
      const response = this.curlJson({
        method: "GET",
        url: `${baseUrl.replace(/\/$/, "")}/status`,
        payload: null,
        timeoutSeconds: 1.5
      });

      if (response.statusCode >= 300 || response.body.trim().length === 0) {
        return false;
      }

      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return false;
      }

      const value = parsed.value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const ready = (value as Record<string, unknown>).ready;
        if (typeof ready === "boolean") {
          return true;
        }

        const message = (value as Record<string, unknown>).message;
        if (typeof message === "string" && message.toLowerCase().includes("webdriveragent")) {
          return true;
        }
      }

      return parsed.status === 0 && Object.prototype.hasOwnProperty.call(parsed, "value");
    } catch (error: unknown) {
      void error;
      return false;
    }
  }

  private curlJson(input: {
    method: string;
    url: string;
    payload: Record<string, unknown> | null;
    timeoutSeconds: number;
  }): CurlResult {
    const args = [
      "-sS",
      "-m",
      String(input.timeoutSeconds),
      "-X",
      input.method,
      "-H",
      "Content-Type: application/json",
      "-w",
      "\\n%{http_code}"
    ];

    if (input.payload !== null) {
      args.push("--data", JSON.stringify(input.payload));
    }

    args.push(input.url);

    const result = spawnSync("curl", args, {
      encoding: "utf-8",
      timeout: Math.ceil(input.timeoutSeconds * 1000),
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.error) {
      throw new DependencyError(`WDA request failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const message = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
      throw new DependencyError(`WDA request failed: ${message}`);
    }

    const output = result.stdout ?? "";
    const lines = output.split(/\r?\n/);
    const statusLine = lines.pop() ?? "";
    const statusCode = Number(statusLine);
    const body = lines.join("\n");

    if (Number.isNaN(statusCode)) {
      throw new DependencyError("WDA response missing HTTP status code");
    }

    return {
      statusCode,
      body
    };
  }

  static parseXctraceDeviceLine(line: string): ParsedXctraceDevice | null {
    const stripped = line.trim();
    if (stripped.length === 0 || stripped.startsWith("==")) {
      return null;
    }

    const groups = [...stripped.matchAll(/\(([^()]*)\)/g)].map((match) => match[1] ?? "");
    if (groups.length < 2) {
      return null;
    }

    const lineLower = stripped.toLowerCase();
    const tailGroup = groups[groups.length - 1]?.trim().toLowerCase() ?? "";

    let targetType: TargetType;
    let deviceId: string;

    if (tailGroup === "simulator") {
      targetType = "simulator";
      deviceId = groups[groups.length - 2]?.trim() ?? "";
    } else if (lineLower.includes("simulator")) {
      targetType = "simulator";
      deviceId = groups[groups.length - 1]?.trim() ?? "";
    } else {
      targetType = "physical";
      deviceId = groups[groups.length - 1]?.trim() ?? "";
    }

    if (deviceId.length < 6) {
      return null;
    }

    const name = stripped.split("(")[0]?.trim() ?? "";
    return {
      deviceId,
      name,
      targetType
    };
  }

  private static isIgnorableSimulatorTerminateError(message: string): boolean {
    const text = message.toLowerCase();
    return text.includes("no such process") || text.includes("found nothing to terminate") || text.includes("not running");
  }

  static findPidFromProcessesPayload(payload: unknown, appId: string): number | null {
    const pidKeys = new Set(["pid", "processidentifier", "process_id", "processid"]);
    const identifierKeys = new Set(["bundleidentifier", "bundle_id", "bundleid", "identifier", "name", "processname"]);

    const walk = (node: unknown): number | null => {
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = walk(item);
          if (found !== null) {
            return found;
          }
        }
        return null;
      }

      if (!node || typeof node !== "object") {
        return null;
      }

      const lowered = new Map<string, unknown>();
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        lowered.set(key.toLowerCase(), value);
      }

      let identifierMatch = false;
      for (const key of identifierKeys) {
        const value = lowered.get(key);
        if (typeof value === "string" && (value === appId || value.endsWith(`.${appId.split(".").pop() ?? ""}`))) {
          identifierMatch = true;
          break;
        }
      }

      if (identifierMatch) {
        for (const key of pidKeys) {
          const value = lowered.get(key);
          if (typeof value === "number" && Number.isInteger(value)) {
            return value;
          }
          if (typeof value === "string" && /^\d+$/.test(value)) {
            return Number(value);
          }
        }
      }

      for (const child of Object.values(node as Record<string, unknown>)) {
        const found = walk(child);
        if (found !== null) {
          return found;
        }
      }

      return null;
    };

    return walk(payload);
  }

  static extractSessionId(response: Record<string, unknown>): string | null {
    const direct = response.sessionId;
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }

    const value = response.value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>).sessionId;
      if (typeof nested === "string" && nested.length > 0) {
        return nested;
      }
    }

    return null;
  }

  static isInvalidSessionError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return ["invalid session id", "no such session", "session does not exist", "stale session"].some((pattern) =>
      message.includes(pattern)
    );
  }
}
