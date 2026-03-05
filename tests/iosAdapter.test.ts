import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { IOSAdapter } from "../src/adapters/iosAdapter.js";
import { DependencyError } from "../src/errors.js";

class FakeIOSAdapter extends IOSAdapter {
  public commands: string[][] = [];
  public devicectlCalls: string[][] = [];
  public devicectlResults: Record<string, unknown>[] = [];
  public simulatorBootState = new Map<string, string>([["SIM-1234-AAAA", "Shutdown"]]);
  public simulatorTerminateErrorMessage: string | null = null;

  override get isSupportedHost(): boolean {
    return true;
  }

  protected override run(command: string[]): { stdout: string; stderr: string } {
    this.commands.push(command);

    if (command.slice(0, 4).join(" ") === "xcrun xctrace list devices") {
      return {
        stdout: "iPhone 16 Simulator (18.0) (SIM-1234-AAAA)\nJohn iPhone (17.2) (PHY-7777-BBBB)",
        stderr: ""
      };
    }

    if (command.slice(0, 4).join(" ") === "xcrun simctl list devices") {
      const deviceId = command[4] ?? "";
      const state = this.simulatorBootState.get(deviceId) ?? "Shutdown";
      return {
        stdout: `iPhone 16 Simulator (${deviceId}) (${state})`,
        stderr: ""
      };
    }

    if (command.slice(0, 3).join(" ") === "xcrun simctl boot") {
      const deviceId = command[3] ?? "";
      this.simulatorBootState.set(deviceId, "Booted");
      return { stdout: "", stderr: "" };
    }

    if (command.slice(0, 3).join(" ") === "xcrun simctl terminate") {
      if (this.simulatorTerminateErrorMessage) {
        throw new DependencyError(this.simulatorTerminateErrorMessage);
      }
      return { stdout: "", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  }

  protected override runDevicectlJson(subcommandArgs: string[]): Record<string, unknown> {
    this.devicectlCalls.push(subcommandArgs);
    return this.devicectlResults.shift() ?? {};
  }

  protected override discoverWdaBaseUrl(): string | null {
    return null;
  }
}

class FakeWDAIOSAdapter extends FakeIOSAdapter {
  public wdaCalls: Array<{ method: string; path: string; payload: Record<string, unknown> | null }> = [];
  public wdaSessionId = "session-1";
  public failFirstTapForInvalidSession = false;

  constructor() {
    super({ wdaBaseUrl: "http://127.0.0.1:8100" });
  }

  protected override wdaJsonCall(
    method: string,
    urlPath: string,
    payload: Record<string, unknown> | null
  ): Record<string, unknown> {
    this.wdaCalls.push({ method, path: urlPath, payload });

    if (urlPath === "/session") {
      return { value: { sessionId: this.wdaSessionId } };
    }

    if (this.failFirstTapForInvalidSession && urlPath.endsWith("/wda/tap")) {
      this.failFirstTapForInvalidSession = false;
      throw new Error("invalid session id");
    }

    if (urlPath.endsWith("/screenshot")) {
      return { value: "ZmFrZS1wbmctZGF0YQ==" };
    }

    return { value: {} };
  }
}

class FakeAutoDiscoverWDAIOSAdapter extends FakeWDAIOSAdapter {
  public discoveryCount = 0;

  constructor() {
    super();
    this.clearWdaBaseUrl();
  }

  protected override discoverWdaBaseUrl(): string | null {
    this.discoveryCount += 1;
    return "http://127.0.0.1:8100";
  }
}

class FakeNoDiscoverWDAIOSAdapter extends FakeWDAIOSAdapter {
  constructor() {
    super();
    this.clearWdaBaseUrl();
  }

  protected override discoverWdaBaseUrl(): string | null {
    return null;
  }
}

const tempDirs: string[] = [];

function makeTempPath(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lazy-mobile-ios-"));
  tempDirs.push(dir);
  return path.join(dir, name);
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

describe("IOSAdapter", () => {
  it("detects simulator and physical target types", () => {
    const adapter = new FakeIOSAdapter();

    const devices = adapter.listDevices();

    expect(devices).toHaveLength(2);
    const simulator = devices.find((item) => item.target_type === "simulator");
    const physical = devices.find((item) => item.target_type === "physical");
    expect(simulator?.capabilities.actions).toContain("mobile.screenshot");
    expect(physical?.capabilities.unsupported).toContain("mobile.screenshot");
  });

  it("uses simctl launch for simulator", () => {
    const adapter = new FakeIOSAdapter();
    adapter.listDevices();

    adapter.launchApp({ deviceId: "SIM-1234-AAAA", appId: "com.example.app", coldStart: false });

    expect(adapter.commands).toContainEqual(["xcrun", "simctl", "launch", "SIM-1234-AAAA", "com.example.app"]);
  });

  it("uses devicectl launch for physical device", () => {
    const adapter = new FakeIOSAdapter();
    adapter.listDevices();

    adapter.launchApp({ deviceId: "PHY-7777-BBBB", appId: "com.example.app", coldStart: false });

    expect(adapter.devicectlCalls.some((call) => call.slice(0, 3).join(" ") === "device process launch")).toBe(true);
  });

  it("stops physical app by pid", () => {
    const adapter = new FakeIOSAdapter();
    adapter.listDevices();
    adapter.devicectlResults = [
      {
        result: {
          processes: [
            {
              bundleIdentifier: "com.example.app",
              pid: 1234
            }
          ]
        }
      },
      {}
    ];

    adapter.stopApp({ deviceId: "PHY-7777-BBBB", appId: "com.example.app" });

    expect(adapter.devicectlCalls[0]?.slice(0, 3)).toEqual(["device", "info", "processes"]);
    expect(adapter.devicectlCalls[1]?.slice(0, 3)).toEqual(["device", "process", "terminate"]);
    expect(adapter.devicectlCalls[1]).toContain("1234");
  });

  it("continues simulator cold launch when app is not running", () => {
    const adapter = new FakeIOSAdapter();
    adapter.listDevices();
    adapter.simulatorTerminateErrorMessage = JSON.stringify({
      command: ["xcrun", "simctl", "terminate", "SIM-1234-AAAA", "com.example.app"],
      code: 3,
      stderr: "No such process"
    });

    adapter.launchApp({ deviceId: "SIM-1234-AAAA", appId: "com.example.app", coldStart: true });

    expect(adapter.commands).toContainEqual(["xcrun", "simctl", "terminate", "SIM-1234-AAAA", "com.example.app"]);
    expect(adapter.commands).toContainEqual(["xcrun", "simctl", "launch", "SIM-1234-AAAA", "com.example.app"]);
  });

  it("cold launch on physical device attempts stop before launch", () => {
    const adapter = new FakeIOSAdapter();
    adapter.listDevices();
    adapter.devicectlResults = [{ result: { processes: [] } }, {}];

    adapter.launchApp({ deviceId: "PHY-7777-BBBB", appId: "com.example.app", coldStart: true });

    expect(adapter.devicectlCalls[0]?.slice(0, 3)).toEqual(["device", "info", "processes"]);
    expect(adapter.devicectlCalls[1]?.slice(0, 3)).toEqual(["device", "process", "launch"]);
  });

  it("parses xctrace line variants", () => {
    const withoutTail = IOSAdapter.parseXctraceDeviceLine("iPhone 16 Simulator (18.0) (SIM-1234-AAAA)");
    const withTail = IOSAdapter.parseXctraceDeviceLine("iPhone 15 (17.2) (SIM-9999-ZZZZ) (Simulator)");

    expect(withoutTail).toEqual({ deviceId: "SIM-1234-AAAA", name: "iPhone 16 Simulator", targetType: "simulator" });
    expect(withTail).toEqual({ deviceId: "SIM-9999-ZZZZ", name: "iPhone 15", targetType: "simulator" });
  });

  it("boots simulator before screenshot capture", () => {
    const adapter = new FakeIOSAdapter();
    adapter.listDevices();
    const outputPath = makeTempPath("sim.png");

    adapter.screenshot({ deviceId: "SIM-1234-AAAA", outputPath });

    expect(adapter.commands).toContainEqual(["xcrun", "simctl", "boot", "SIM-1234-AAAA"]);
    expect(adapter.commands).toContainEqual(["xcrun", "simctl", "bootstatus", "SIM-1234-AAAA", "-b"]);
    expect(adapter.commands).toContainEqual(["xcrun", "simctl", "io", "SIM-1234-AAAA", "screenshot", outputPath]);
  });

  it("uses WDA for physical screenshot", () => {
    const adapter = new FakeWDAIOSAdapter();
    adapter.listDevices();
    const outputPath = makeTempPath("physical.png");

    const result = adapter.screenshot({ deviceId: "PHY-7777-BBBB", outputPath });

    expect(result.path).toBe(outputPath);
    expect(readFileSync(outputPath)).toEqual(Buffer.from("fake-png-data", "utf-8"));
    expect(adapter.wdaCalls.some((call) => call.path.endsWith("/screenshot"))).toBe(true);
  });

  it("creates and reuses WDA session across actions", () => {
    const adapter = new FakeWDAIOSAdapter();
    adapter.listDevices();

    adapter.tap({ deviceId: "PHY-7777-BBBB", x: 10, y: 20 });
    adapter.swipe({ deviceId: "PHY-7777-BBBB", x1: 10, y1: 20, x2: 30, y2: 40, durationMs: 500 });
    adapter.inputText({ deviceId: "PHY-7777-BBBB", text: "hello" });

    const sessionCreates = adapter.wdaCalls.filter((call) => call.path === "/session");
    expect(sessionCreates).toHaveLength(1);
    expect(adapter.wdaCalls.some((call) => call.path === "/session/session-1/wda/tap")).toBe(true);
    expect(adapter.wdaCalls.some((call) => call.path === "/session/session-1/wda/dragfromtoforduration")).toBe(true);
    expect(adapter.wdaCalls.some((call) => call.path === "/session/session-1/wda/keys")).toBe(true);
  });

  it("recreates WDA session when server returns invalid session", () => {
    const adapter = new FakeWDAIOSAdapter();
    adapter.listDevices();
    adapter.failFirstTapForInvalidSession = true;

    adapter.tap({ deviceId: "PHY-7777-BBBB", x: 1, y: 2 });

    const sessionCreates = adapter.wdaCalls.filter((call) => call.path === "/session");
    expect(sessionCreates).toHaveLength(2);
  });

  it("auto-discovers WDA base URL once", () => {
    const adapter = new FakeAutoDiscoverWDAIOSAdapter();
    adapter.listDevices();

    adapter.tap({ deviceId: "PHY-7777-BBBB", x: 1, y: 2 });
    adapter.swipe({ deviceId: "PHY-7777-BBBB", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 300 });

    expect(adapter.discoveryCount).toBe(1);
    expect(adapter.peekWdaBaseUrl()).toBe("http://127.0.0.1:8100");
  });

  it("enables physical interactive capabilities when WDA can be discovered", () => {
    const adapter = new FakeAutoDiscoverWDAIOSAdapter();
    adapter.listDevices();

    const capabilities = adapter.getCapabilities({ deviceId: "PHY-7777-BBBB" });

    expect(capabilities.actions).toContain("mobile.screenshot");
    expect(capabilities.actions).toContain("mobile.tap");
    expect(capabilities.actions).toContain("mobile.swipe");
    expect(capabilities.actions).toContain("mobile.input_text");
    expect(adapter.discoveryCount).toBe(1);
  });

  it("fails interactive actions when WDA discovery fails", () => {
    const adapter = new FakeNoDiscoverWDAIOSAdapter();
    adapter.listDevices();

    expect(() => adapter.tap({ deviceId: "PHY-7777-BBBB", x: 1, y: 2 })).toThrow(/auto-discovery failed/);
  });
});
