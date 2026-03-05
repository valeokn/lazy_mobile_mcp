import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AndroidAdapter } from "./adapters/androidAdapter.js";
import { IOSAdapter } from "./adapters/iosAdapter.js";
import { AppError, DependencyError } from "./errors.js";
import { PerfCollector } from "./perfCollector.js";
import { PolicyGuard } from "./policyGuard.js";
import { Storage } from "./storage.js";

export interface SelectedDevice {
  deviceId: string;
  platform: "android" | "ios";
  targetType?: string;
}

export interface WorkerOptions {
  sqlitePath: string;
  allowlist?: string[];
  highRiskTools?: string[];
  adbBin?: string;
  wdaBaseUrl?: string;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function asInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

const INLINE_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

export class Worker {
  private readonly storage: Storage;
  private readonly policyGuard: PolicyGuard;
  private readonly android: AndroidAdapter;
  private readonly ios: IOSAdapter;
  private readonly perf: PerfCollector;
  private selected: SelectedDevice | null = null;

  constructor(options: WorkerOptions) {
    this.storage = new Storage(options.sqlitePath);
    this.storage.initialize();

    const highRiskDefaults = ["mobile.factory_reset", "mobile.uninstall_app", "mobile.reboot"];
    this.policyGuard = new PolicyGuard({
      allowlist: options.allowlist ?? [],
      highRiskTools: options.highRiskTools ?? highRiskDefaults
    });

    this.android = new AndroidAdapter(options.adbBin ?? "adb");
    this.ios = new IOSAdapter({ wdaBaseUrl: options.wdaBaseUrl });
    this.perf = new PerfCollector(this.storage);
  }

  handle(method: string, params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    try {
      this.policyGuard.assertToolRisk({
        toolName: method,
        args: params
      });

      switch (method) {
        case "mobile.list_devices":
          return this.listDevices(params, traceId);
        case "mobile.select_device":
          return this.selectDevice(params, traceId);
        case "mobile.get_capabilities":
          return this.getCapabilities(params, traceId);
        case "mobile.screenshot":
          return this.screenshot(params, traceId);
        case "mobile.tap":
          return this.tap(params, traceId);
        case "mobile.swipe":
          return this.swipe(params, traceId);
        case "mobile.input_text":
          return this.inputText(params, traceId);
        case "mobile.launch_app":
          return this.launchApp(params, traceId);
        case "mobile.stop_app":
          return this.stopApp(params, traceId);
        case "mobile.start_perf_session":
          return this.startPerfSession(params, traceId);
        case "mobile.stop_perf_session":
          return this.stopPerfSession(params, traceId);
        case "mobile.get_perf_samples":
          return this.getPerfSamples(params, traceId);
        default:
          throw new AppError({
            message: `Unsupported tool method: ${method}`,
            code: "ERR_UNSUPPORTED_TOOL",
            category: "validation",
            traceId
          });
      }
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      if (error instanceof DependencyError) {
        throw new AppError({
          message: error.message,
          code: error.code,
          category: "dependency",
          traceId,
          cause: error
        });
      }

      if (error instanceof Error) {
        throw new AppError({
          message: "Unexpected worker error",
          code: "ERR_INTERNAL",
          category: "system",
          traceId,
          cause: error
        });
      }

      throw new AppError({
        message: "Unknown worker error",
        code: "ERR_INTERNAL",
        category: "system",
        traceId
      });
    }
  }

  private listDevices(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const target = asString(params.platform).trim() || "all";
    const devices: Record<string, unknown>[] = [];

    if (target === "android" || target === "all") {
      devices.push(...this.android.listDevices());
    }

    if (target === "ios" || target === "all") {
      const iosDevices = this.ios.listDevices();
      if (target === "ios" && iosDevices.length === 0 && !this.ios.isSupportedHost) {
        throw new AppError({
          message: "iOS control requires macOS host",
          code: "ERR_IOS_UNAVAILABLE_ON_HOST",
          category: "dependency",
          traceId
        });
      }
      devices.push(...iosDevices);
    }

    return { devices };
  }

  private selectDevice(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const deviceId = asString(params.device_id).trim();
    if (deviceId.length === 0) {
      throw new AppError({
        message: "device_id is required",
        code: "ERR_VALIDATION",
        category: "validation",
        traceId
      });
    }

    this.policyGuard.assertDeviceAllowed(deviceId);

    const allDevices = this.listDevices({ platform: "all" }, traceId).devices as Array<Record<string, unknown>>;
    const matched = allDevices.find((item) => item.device_id === deviceId);

    if (!matched) {
      throw new AppError({
        message: `Device not found: ${deviceId}`,
        code: "ERR_DEVICE_NOT_FOUND",
        category: "business",
        traceId
      });
    }

    const selected: SelectedDevice = {
      deviceId,
      platform: asString(matched.platform) as "android" | "ios",
      targetType: asString(matched.target_type) || undefined
    };

    this.selected = selected;

    this.storage.upsertDevice({
      deviceId: selected.deviceId,
      platform: selected.platform,
      host: os.hostname(),
      lastSeenAt: new Date().toISOString(),
      capabilities:
        matched.capabilities && typeof matched.capabilities === "object" && !Array.isArray(matched.capabilities)
          ? (matched.capabilities as Record<string, unknown>)
          : {}
    });

    return {
      selected_device: {
        device_id: selected.deviceId,
        platform: selected.platform,
        target_type: selected.targetType ?? null
      }
    };
  }

  private getCapabilities(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);

    if (selected.platform === "android") {
      return this.android.getCapabilities();
    }

    return this.ios.getCapabilities({ deviceId: selected.deviceId });
  }

  private screenshot(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const save = asBoolean(params.save, true);

    if (!save) {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "lazy-mobile-inline-screenshot-"));
      const tempPath = path.join(tempDir, `${randomUUID()}.png`);

      try {
        const result = this.captureScreenshot(selected, tempPath, traceId);
        const payload = readFileSync(tempPath);

        if (payload.byteLength > INLINE_SCREENSHOT_MAX_BYTES) {
          throw new AppError({
            message: "Inline screenshot payload exceeds 8MB limit",
            code: "ERR_PAYLOAD_TOO_LARGE",
            category: "validation",
            traceId
          });
        }

        return {
          artifact_id: null,
          path: null,
          width: result.width,
          height: result.height,
          saved: false,
          mime_type: "image/png",
          image_base64: payload.toString("base64")
        };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const artifactId = randomUUID();
    const outputPath = path.join("artifacts", "screenshots", `${artifactId}.png`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const result = this.captureScreenshot(selected, outputPath, traceId);

    this.storage.insertArtifact({
      artifactId,
      sessionId: null,
      artifactType: "screenshot",
      filePath: result.path,
      createdAt: new Date().toISOString(),
      meta: {
        width: result.width,
        height: result.height,
        device_id: selected.deviceId,
        platform: selected.platform
      }
    });

    return {
      artifact_id: artifactId,
      path: result.path,
      width: result.width,
      height: result.height,
      saved: true
    };
  }

  private tap(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const x = asInteger(params.x, 0);
    const y = asInteger(params.y, 0);

    if (selected.platform === "android") {
      this.android.tap({ deviceId: selected.deviceId, x, y });
    } else {
      this.assertIosHost(traceId);
      this.ios.tap({ deviceId: selected.deviceId, x, y });
    }

    return { ok: true };
  }

  private swipe(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const x1 = asInteger(params.x1, 0);
    const y1 = asInteger(params.y1, 0);
    const x2 = asInteger(params.x2, 0);
    const y2 = asInteger(params.y2, 0);
    const durationMs = asInteger(params.duration_ms, 300);

    if (selected.platform === "android") {
      this.android.swipe({
        deviceId: selected.deviceId,
        x1,
        y1,
        x2,
        y2,
        durationMs
      });
    } else {
      this.assertIosHost(traceId);
      this.ios.swipe({ deviceId: selected.deviceId, x1, y1, x2, y2, durationMs });
    }

    return { ok: true };
  }

  private inputText(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const text = asString(params.text);

    if (selected.platform === "android") {
      this.android.inputText({ deviceId: selected.deviceId, text });
    } else {
      this.assertIosHost(traceId);
      this.ios.inputText({ deviceId: selected.deviceId, text });
    }

    return { ok: true };
  }

  private launchApp(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const appId = asString(params.app_id).trim();
    const coldStart = asBoolean(params.cold_start, false);
    if (appId.length === 0) {
      throw new AppError({
        message: "app_id is required",
        code: "ERR_VALIDATION",
        category: "validation",
        traceId
      });
    }

    const result =
      selected.platform === "android"
        ? this.android.launchApp({ deviceId: selected.deviceId, appId, coldStart })
        : this.iosLaunchApp(selected, appId, coldStart, traceId);

    return {
      ok: true,
      launch_ms: result.launch_ms,
      cold_start_requested: coldStart,
      cold_start_applied: coldStart
    };
  }

  private stopApp(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const appId = asString(params.app_id).trim();
    if (appId.length === 0) {
      throw new AppError({
        message: "app_id is required",
        code: "ERR_VALIDATION",
        category: "validation",
        traceId
      });
    }

    if (selected.platform === "android") {
      this.android.stopApp({ deviceId: selected.deviceId, appId });
    } else {
      this.assertIosHost(traceId);
      this.ios.stopApp({ deviceId: selected.deviceId, appId });
    }

    return { ok: true };
  }

  private startPerfSession(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const selected = this.resolveDevice(params, traceId);
    const appId = asString(params.app_id).trim();
    if (appId.length === 0) {
      throw new AppError({
        message: "app_id is required",
        code: "ERR_VALIDATION",
        category: "validation",
        traceId
      });
    }

    const intervalMs = asInteger(params.interval_ms, 1000);
    const metrics = Array.isArray(params.metrics)
      ? params.metrics.filter((item): item is string => typeof item === "string")
      : ["cpu_pct", "memory_mb", "launch_ms"];

    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();

    this.storage.createSession({
      sessionId,
      deviceId: selected.deviceId,
      appId,
      platform: selected.platform,
      traceId,
      startedAt
    });

    this.perf.startSession({
      sessionId,
      intervalMs,
      metrics,
      sampleFn: (requestedMetrics) => {
        if (selected.platform === "android") {
          return this.android.collectMetrics({
            deviceId: selected.deviceId,
            appId,
            metrics: requestedMetrics
          });
        }

        return this.ios.collectMetrics({
          deviceId: selected.deviceId,
          appId,
          metrics: requestedMetrics
        });
      }
    });

    return {
      session_id: sessionId,
      started_at: startedAt
    };
  }

  private stopPerfSession(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const sessionId = asString(params.session_id).trim();
    if (sessionId.length === 0) {
      throw new AppError({
        message: "session_id is required",
        code: "ERR_VALIDATION",
        category: "validation",
        traceId
      });
    }

    const sampleCount = this.perf.stopSession({ sessionId });
    const endedAt = new Date().toISOString();

    this.storage.closeSession({
      sessionId,
      endedAt,
      status: "stopped"
    });

    return {
      sample_count: sampleCount,
      summary: {
        session_id: sessionId,
        ended_at: endedAt
      }
    };
  }

  private getPerfSamples(params: Record<string, unknown>, traceId: string): Record<string, unknown> {
    const sessionId = asString(params.session_id).trim();
    if (sessionId.length === 0) {
      throw new AppError({
        message: "session_id is required",
        code: "ERR_VALIDATION",
        category: "validation",
        traceId
      });
    }

    const limit = asInteger(params.limit, 100);
    const cursor = asInteger(params.cursor, 0);
    return {
      ...this.storage.listSamples({
      sessionId,
      limit,
      cursor
      })
    };
  }

  private resolveDevice(params: Record<string, unknown>, traceId: string): SelectedDevice {
    const requestedDeviceId = asString(params.device_id).trim();

    if (requestedDeviceId.length > 0) {
      this.policyGuard.assertDeviceAllowed(requestedDeviceId);
      const devices = this.listDevices({ platform: "all" }, traceId).devices as Array<Record<string, unknown>>;
      const matched = devices.find((item) => item.device_id === requestedDeviceId);

      if (!matched) {
        throw new AppError({
          message: `Device not found: ${requestedDeviceId}`,
          code: "ERR_DEVICE_NOT_FOUND",
          category: "business",
          traceId
        });
      }

      return {
        deviceId: requestedDeviceId,
        platform: asString(matched.platform) as "android" | "ios",
        targetType: asString(matched.target_type) || undefined
      };
    }

    if (this.selected) {
      return this.selected;
    }

    throw new AppError({
      message: "No selected device; call mobile.select_device first or pass device_id",
      code: "ERR_NO_ACTIVE_DEVICE",
      category: "business",
      traceId
    });
  }

  private assertIosHost(traceId: string): void {
    if (!this.ios.isSupportedHost) {
      throw new AppError({
        message: "iOS control requires macOS host",
        code: "ERR_IOS_UNAVAILABLE_ON_HOST",
        category: "dependency",
        traceId
      });
    }
  }

  private iosScreenshot(selected: SelectedDevice, outputPath: string, traceId: string): { path: string; width: number; height: number } {
    this.assertIosHost(traceId);
    return this.ios.screenshot({ deviceId: selected.deviceId, outputPath });
  }

  private iosLaunchApp(selected: SelectedDevice, appId: string, coldStart: boolean, traceId: string): { launch_ms: number } {
    this.assertIosHost(traceId);
    return this.ios.launchApp({ deviceId: selected.deviceId, appId, coldStart });
  }

  private captureScreenshot(selected: SelectedDevice, outputPath: string, traceId: string): { path: string; width: number; height: number } {
    return selected.platform === "android"
      ? this.android.screenshot({ deviceId: selected.deviceId, outputPath })
      : this.iosScreenshot(selected, outputPath, traceId);
  }
}
