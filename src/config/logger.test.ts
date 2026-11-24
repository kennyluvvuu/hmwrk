import { describe, expect, it } from "vitest";
import { createLogger, silentLogger, type LogFields } from "./logger";

const fixedNow = () => new Date("2026-11-24T10:15:30.000Z");

function captureLogger(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ level, now: fixedNow, sink: (line) => lines.push(line) });
  const records = (): LogFields[] => lines.map((line) => JSON.parse(line) as LogFields);
  return { logger, lines, records };
}

describe("createLogger", () => {
  it("writes one timestamped JSON line per record", () => {
    const { logger, lines, records } = captureLogger();

    logger.info("boot", { port: 8787 });
    logger.warn("slow", { ms: 1200 });

    expect(lines).toHaveLength(2);
    expect(records()[0]).toEqual({ ts: "2026-11-24T10:15:30.000Z", level: "info", msg: "boot", port: 8787 });
    expect(records()[1]).toMatchObject({ level: "warn", msg: "slow", ms: 1200 });
  });

  it("filters below the threshold", () => {
    const { logger, records } = captureLogger("warn");

    logger.debug("skip me");
    logger.info("skip me too");
    logger.warn("keep");
    logger.error("keep too");

    expect(records().map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("merges child bindings without leaking them to the parent", () => {
    const { logger, records } = captureLogger();
    const child = logger.child({ module: "telegram" });

    child.info("sent", { chat: 42 });
    logger.info("plain");

    expect(records()[0]).toMatchObject({ module: "telegram", chat: 42, msg: "sent" });
    expect(records()[1]?.module).toBeUndefined();
    expect(child.level).toBe("debug");
  });

  it("serializes Error values and survives circular fields", () => {
    const { logger, records } = captureLogger();
    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;

    logger.error("failed", { error: new Error("boom"), circular });

    const record = records()[0];
    expect(record?.error).toMatchObject({ name: "Error", message: "boom" });
    expect((record?.circular as Record<string, unknown>).self).toBe("[circular]");
  });

  it("silentLogger drops everything", () => {
    expect(() => silentLogger().error("nothing happens")).not.toThrow();
  });
});
