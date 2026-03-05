import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toolValidators } from "../src/toolSchemas.js";

describe("tool contract documentation", () => {
  it("documents the same tool names exposed by the server", () => {
    const docPath = path.resolve(process.cwd(), "docs", "tool-contract.md");
    const doc = readFileSync(docPath, "utf-8");
    const docTools = [...doc.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]).sort();

    expect(docTools).toEqual(Object.keys(toolValidators).sort());
  });
});
