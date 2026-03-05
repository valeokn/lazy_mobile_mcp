import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { Worker } from "../src/worker.js";

const tempDirs: string[] = [];
const generatedFiles: string[] = [];

function makeTempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lazy-mobile-worker-behavior-"));
  tempDirs.push(dir);
  return path.join(dir, "mobile.db");
}

function countArtifacts(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) as count FROM artifacts").get() as { count: number };
  db.close();
  return row.count;
}

class FakeAndroidAdapter {
  public launchCalls: Array<{ deviceId: string; appId: string; coldStart: boolean }> = [];
  public screenshotPayload = Buffer.from("fake-png-data", "utf-8");

  listDevices(): Array<Record<string, unknown>> {
    return [
      {
        device_id: "emulator-5554",
        platform: "android",
        state: "device",
        capabilities: {
          actions: ["mobile.screenshot", "mobile.launch_app", "mobile.stop_app"],
          metrics: ["cpu_pct", "memory_mb", "launch_ms"],
          unsupported: []
        }
      }
    ];
  }

  launchApp(input: { deviceId: string; appId: string; coldStart: boolean }): { launch_ms: number } {
    this.launchCalls.push(input);
    return { launch_ms: 123.45 };
  }

  screenshot(input: { deviceId: string; outputPath: string }): { path: string; width: number; height: number } {
    generatedFiles.push(input.outputPath);
    writeFileSync(input.outputPath, this.screenshotPayload);
    return {
      path: input.outputPath,
      width: 1080,
      height: 1920
    };
  }
}

afterEach(() => {
  while (generatedFiles.length > 0) {
    const file = generatedFiles.pop();
    if (!file) {
      continue;
    }

    rmSync(file, { force: true });
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Worker behavior", () => {
  it("passes cold_start=true to adapter and returns cold-start flags", () => {
    const dbPath = makeTempDbPath();
    const worker = new Worker({ sqlitePath: dbPath });
    const fakeAndroid = new FakeAndroidAdapter();

    (worker as any).android = fakeAndroid;
    (worker as any).selected = {
      deviceId: "emulator-5554",
      platform: "android"
    };

    const response = worker.handle("mobile.launch_app", { app_id: "com.example.app", cold_start: true }, "trace-cold-true");

    expect(fakeAndroid.launchCalls[0]).toEqual({
      deviceId: "emulator-5554",
      appId: "com.example.app",
      coldStart: true
    });
    expect(response).toMatchObject({
      ok: true,
      launch_ms: 123.45,
      cold_start_requested: true,
      cold_start_applied: true
    });
  });

  it("keeps backward-compatible launch behavior when cold_start is not provided", () => {
    const dbPath = makeTempDbPath();
    const worker = new Worker({ sqlitePath: dbPath });
    const fakeAndroid = new FakeAndroidAdapter();

    (worker as any).android = fakeAndroid;
    (worker as any).selected = {
      deviceId: "emulator-5554",
      platform: "android"
    };

    const response = worker.handle("mobile.launch_app", { app_id: "com.example.app" }, "trace-cold-default");

    expect(fakeAndroid.launchCalls[0]?.coldStart).toBe(false);
    expect(response).toMatchObject({
      ok: true,
      cold_start_requested: false,
      cold_start_applied: false
    });
  });

  it("returns inline base64 screenshot and skips artifact persistence when save=false", () => {
    const dbPath = makeTempDbPath();
    const worker = new Worker({ sqlitePath: dbPath });
    const fakeAndroid = new FakeAndroidAdapter();

    (worker as any).android = fakeAndroid;
    (worker as any).selected = {
      deviceId: "emulator-5554",
      platform: "android"
    };

    const response = worker.handle("mobile.screenshot", { save: false, format: "png" }, "trace-inline-screenshot");

    expect(response).toMatchObject({
      artifact_id: null,
      path: null,
      width: 1080,
      height: 1920,
      saved: false,
      mime_type: "image/png"
    });
    expect(typeof response.image_base64).toBe("string");
    expect(Buffer.from(response.image_base64 as string, "base64")).toEqual(fakeAndroid.screenshotPayload);
    expect(countArtifacts(dbPath)).toBe(0);
  });

  it("returns saved=true and persists artifact record when save=true", () => {
    const dbPath = makeTempDbPath();
    const worker = new Worker({ sqlitePath: dbPath });
    const fakeAndroid = new FakeAndroidAdapter();

    (worker as any).android = fakeAndroid;
    (worker as any).selected = {
      deviceId: "emulator-5554",
      platform: "android"
    };

    const response = worker.handle("mobile.screenshot", { save: true, format: "png" }, "trace-saved-screenshot");

    expect(response.saved).toBe(true);
    expect(typeof response.path).toBe("string");
    expect(typeof response.artifact_id).toBe("string");
    expect(countArtifacts(dbPath)).toBe(1);
  });

  it("rejects inline screenshot payloads larger than 8MB with validation error", () => {
    const dbPath = makeTempDbPath();
    const worker = new Worker({ sqlitePath: dbPath });
    const fakeAndroid = new FakeAndroidAdapter();
    fakeAndroid.screenshotPayload = Buffer.alloc(8 * 1024 * 1024 + 1, 1);

    (worker as any).android = fakeAndroid;
    (worker as any).selected = {
      deviceId: "emulator-5554",
      platform: "android"
    };

    try {
      worker.handle("mobile.screenshot", { save: false, format: "png" }, "trace-large-inline");
      throw new Error("expected payload-size error");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("ERR_PAYLOAD_TOO_LARGE");
      expect(appError.category).toBe("validation");
      expect(appError.traceId).toBe("trace-large-inline");
      expect(countArtifacts(dbPath)).toBe(0);
    }
  });
});
