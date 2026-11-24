/**
 * Domain layer barrel: types, zod schemas, repository contracts and in-memory fakes.
 *
 * Consumers: A2 (`src/agent/tools`) imports {@link toolArgsSchemas} and the repo contracts,
 * D2 (`src/store`) implements the contracts, V2 (`src/llm`, `src/durable/tasks`) validates model
 * output with the verification schemas, N1 (`src/durable/tasks`) reads settings and dates.
 *
 * Nothing in `src/domain` performs I/O; the only ambient inputs are the clock and uuid v4.
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./dates.js";
export * from "./settings.js";
export * from "./status.js";
export * from "./schemas.js";
export * from "./repo.js";
export * from "./fakes.js";
