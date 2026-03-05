import { describe, expect, it } from "vitest";
import { toolValidators } from "../src/toolSchemas.js";

describe("toolSchemas", () => {
  it("defaults screenshot save to true", () => {
    const parsed = toolValidators["mobile.screenshot"].parse({});
    expect(parsed.format).toBe("png");
    expect(parsed.save).toBe(true);
  });

  it("defaults launch cold_start to false", () => {
    const parsed = toolValidators["mobile.launch_app"].parse({ app_id: "com.example.app" });
    expect(parsed.cold_start).toBe(false);
  });

  it("validates tap args", () => {
    const parsed = toolValidators["mobile.tap"].parse({ x: 10, y: 20 });
    expect(parsed.x).toBe(10);
    expect(parsed.y).toBe(20);
  });

  it("fails for invalid swipe args", () => {
    expect(() =>
      toolValidators["mobile.swipe"].parse({ x1: 1, y1: 2, x2: 3, y2: 4, duration_ms: 0 })
    ).toThrow();
  });

  it("enforces perf interval boundaries", () => {
    expect(() =>
      toolValidators["mobile.start_perf_session"].parse({ app_id: "com.example.app", interval_ms: 100 })
    ).toThrow();
  });
});
