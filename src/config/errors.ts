import type { z } from "zod";

/** One human-readable configuration problem (variable or file field). */
export interface ConfigProblem {
  /** Variable name or dotted JSON path, e.g. `HMWRK_PARENT_KEY` or `read.provider`. */
  key: string;
  reason: string;
}

/**
 * Configuration is invalid or unreadable. `problems` lists every independent
 * issue so a single failed boot reports all of them, not just the first.
 */
export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];
  /** Where the problems came from, e.g. the resolved models.json path. */
  readonly source: string | undefined;

  constructor(message: string, problems: readonly ConfigProblem[] = [], source?: string) {
    super(message);
    this.name = "ConfigError";
    this.problems = problems;
    this.source = source;
  }

  /** Multi-line rendering for logs and CLI output. */
  format(): string {
    if (this.problems.length === 0) return this.message;
    const details = this.problems.map((p) => `  - ${p.key}: ${p.reason}`).join("\n");
    const origin = this.source ? `${this.message} (${this.source})` : this.message;
    return `${origin}\n${details}`;
  }
}

/** Turns a zod issue into one plain sentence, without zod's own wording where it is unhelpful. */
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type": {
      // `received` is absent for a missing key but present (e.g. NaN) for a failed coercion.
      const received = (issue as { received?: unknown }).received;
      if (received === undefined) return "is required, but missing";
      return `expected ${issue.expected}, got ${String(received)}`;
    }
    case "too_small":
      if (issue.origin === "string" && issue.minimum === 1) return "must not be empty";
      return issue.message;
    case "unrecognized_keys":
      return `unknown field(s): ${issue.keys.join(", ")}`;
    default:
      return issue.message;
  }
}

/** Converts zod issues into `ConfigProblem`s, skipping an optional key prefix. */
export function problemsFromZod(error: z.ZodError, prefix?: string): ConfigProblem[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    const joined = prefix && path ? `${prefix}.${path}` : path || prefix || "(root)";
    return { key: joined, reason: describeIssue(issue) };
  });
}
