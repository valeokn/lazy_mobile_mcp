import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DependencyError } from "../errors.js";

export interface AndroidDevice {
  [key: string]: unknown;
  device_id: string;
  platform: "android";
  state: string;
  capabilities: {
    actions: string[];
    metrics: string[];
    unsupported: string[];
  };
}

export class AndroidAdapter {
  constructor(private readonly adbBin = "adb") {}

  listDevices(): AndroidDevice[] {
    const result = this.run([this.adbBin, "devices"]);
    const lines = result.stdout.trim().split(/\r?\n/);
    const devices: AndroidDevice[] = [];

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parts = trimmed.split("\t");
      if (parts.length < 2) {
        continue;
      }

      const deviceId = parts[0] ?? "";
      const state = parts[1] ?? "";

      devices.push({
        device_id: deviceId,
        platform: "android",
        state,
        capabilities: this.getCapabilities()
      });
    }

    return devices;
  }

  getCapabilities(): { actions: string[]; metrics: string[]; unsupported: string[] } {
    return {
      actions: [
        "mobile.screenshot",
        "mobile.tap",
        "mobile.swipe",
        "mobile.input_text",
        "mobile.launch_app",
        "mobile.stop_app",
        "mobile.start_perf_session",
        "mobile.stop_perf_session",
        "mobile.get_perf_samples"
      ],
      metrics: ["cpu_pct", "memory_mb", "launch_ms"],
      unsupported: []
    };
  }

  screenshot(input: { deviceId: string; outputPath: string }): { path: string; width: number; height: number } {
    mkdirSync(path.dirname(input.outputPath), { recursive: true });

    const result = spawnSync(
      this.adbBin,
      ["-s", input.deviceId, "exec-out", "screencap", "-p"],
      {
        encoding: "buffer",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    if (result.error) {
      throw new DependencyError(result.error.message);
    }

    if (result.status !== 0) {
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf-8") : String(result.stderr ?? "");
      throw new DependencyError(stderr);
    }

    const payload = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    writeFileSync(input.outputPath, payload);

    const resolution = this.getResolution(input.deviceId);
    return {
      path: input.outputPath,
      width: resolution.width,
      height: resolution.height
    };
  }

  tap(input: { deviceId: string; x: number; y: number }): void {
    this.run([this.adbBin, "-s", input.deviceId, "shell", "input", "tap", String(input.x), String(input.y)]);
  }

  swipe(input: { deviceId: string; x1: number; y1: number; x2: number; y2: number; durationMs: number }): void {
    this.run([
      this.adbBin,
      "-s",
      input.deviceId,
      "shell",
      "input",
      "swipe",
      String(input.x1),
      String(input.y1),
      String(input.x2),
      String(input.y2),
      String(input.durationMs)
    ]);
  }

  inputText(input: { deviceId: string; text: string }): void {
    const escaped = input.text.replace(/ /g, "%s");
    this.run([this.adbBin, "-s", input.deviceId, "shell", "input", "text", escaped]);
  }

  launchApp(input: { deviceId: string; appId: string; coldStart: boolean }): { launch_ms: number } {
    if (input.coldStart) {
      this.stopApp({ deviceId: input.deviceId, appId: input.appId });
    }

    const start = process.hrtime.bigint();
    this.run([
      this.adbBin,
      "-s",
      input.deviceId,
      "shell",
      "monkey",
      "-p",
      input.appId,
      "-c",
      "android.intent.category.LAUNCHER",
      "1"
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    return { launch_ms: elapsedMs };
  }

  stopApp(input: { deviceId: string; appId: string }): void {
    this.run([this.adbBin, "-s", input.deviceId, "shell", "am", "force-stop", input.appId]);
  }

  collectMetrics(input: { deviceId: string; appId: string; metrics: string[] }): Record<string, number> {
    const result: Record<string, number> = {};

    if (input.metrics.includes("cpu_pct")) {
      result.cpu_pct = this.readCpuPct(input.deviceId, input.appId);
    }

    if (input.metrics.includes("memory_mb")) {
      result.memory_mb = this.readMemoryMb(input.deviceId, input.appId);
    }

    if (input.metrics.includes("launch_ms")) {
      result.launch_ms = 0;
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

  private readCpuPct(deviceId: string, appId: string): number {
    const output = this.run([this.adbBin, "-s", deviceId, "shell", "top", "-n", "1", "-b"]).stdout;

    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(appId)) {
        continue;
      }

      const match = line.match(/([0-9]+(?:\.[0-9]+)?)%/);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }

    return 0;
  }

  private readMemoryMb(deviceId: string, appId: string): number {
    const output = this.run([this.adbBin, "-s", deviceId, "shell", "dumpsys", "meminfo", appId]).stdout;

    for (const line of output.split(/\r?\n/)) {
      if (!line.includes("TOTAL PSS")) {
        continue;
      }

      const match = line.match(/(\d+)/);
      if (match?.[1]) {
        return Number(match[1]) / 1024;
      }
    }

    return 0;
  }

  private getResolution(deviceId: string): { width: number; height: number } {
    const output = this.run([this.adbBin, "-s", deviceId, "shell", "wm", "size"]).stdout;
    const match = output.match(/(\d+)x(\d+)/);

    if (!match || !match[1] || !match[2]) {
      return { width: 0, height: 0 };
    }

    return {
      width: Number(match[1]),
      height: Number(match[2])
    };
  }
}
