import { describe, expect, it } from "vitest";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";

describe("boot: зависимости живы", () => {
  it("pi-durable отдаёт Harness и MemoryStorage", () => {
    expect(Harness).toBeDefined();
    expect(typeof Harness.open).toBe("function");
    expect(typeof MemoryStorage).toBe("function");
  });

  it("pi-ai отдаёт createModels", () => {
    expect(typeof createModels).toBe("function");
  });
});
