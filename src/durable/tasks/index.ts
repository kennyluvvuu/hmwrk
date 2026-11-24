/**
 * Durable domain tasks barrel.
 *
 * W5 has one task here: {@link createVerifyExtension} (`hmwrk.verify`, `VerifySpawner`). N1 adds
 * `reminder`/`digest` in W7 through the same pattern: a `defineTask` factory over repositories,
 * registered by an extension that boot wiring installs.
 */

export * from "./verify.js";
