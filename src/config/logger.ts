/**
 * Minimal leveled logger: one JSON object per line on stdout, no dependencies.
 * Every module that needs to report something takes a `Logger` (or a child of it).
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `bindings` into every line (e.g. `{ module: "telegram" }`). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to `info`. */
  level?: LogLevel;
  /** Receives each serialized line without the trailing newline. Defaults to stdout. */
  sink?: (line: string) => void;
  /** Fields merged into every line. */
  bindings?: LogFields;
  /** Clock injection for tests. */
  now?: () => Date;
}

function isEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return SEVERITY[level] >= SEVERITY[threshold];
}

/** Expands `Error`/`Date` values so they survive JSON serialization; cycles become "[circular]". */
function normalizeValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const items = value.map((item) => normalizeValue(item, seen));
    seen.delete(value);
    return items;
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = normalizeValue(nested, seen);
    seen.delete(value);
    return out;
  }
  return value;
}

function normalizeFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) out[key] = normalizeValue(value);
  return out;
}

const writeStdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold: LogLevel = options.level ?? "info";
  const sink = options.sink ?? writeStdout;
  const now = options.now ?? (() => new Date());
  const bindings = normalizeFields(options.bindings) ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!isEnabled(level, threshold)) return;
    const record: LogFields = {
      ts: now().toISOString(),
      level,
      msg: message,
      ...bindings,
      ...normalizeFields(fields),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Circular or otherwise unserializable field: fall back to the safe subset.
      line = JSON.stringify({ ts: record.ts, level, msg: message, logError: "unserializable fields" });
    }
    sink(line);
  };

  return {
    level: threshold,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => createLogger({ level: threshold, sink, now, bindings: { ...bindings, ...extra } }),
  };
}

/** Logger that discards everything; convenient default in tests and fakes. */
export function silentLogger(level: LogLevel = "error"): Logger {
  return createLogger({ level, sink: () => {} });
}
