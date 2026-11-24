/**
 * Durable domain tasks barrel.
 *
 * W5 has one task here: {@link createVerifyExtension} (`hmwrk.verify`, `VerifySpawner`). W7 adds the
 * scheduled broadcasts through the same pattern: a `defineTask` factory over repositories, registered
 * by an extension that boot wiring installs.
 */

export * from "./verify.js";
export * from "./notify.js";
