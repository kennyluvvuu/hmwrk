/**
 * hmwrk entry point (S2): load config, open the durable core, listen on PORT, shut down cleanly.
 *
 * Dependency injection lives in {@link bootstrap}: the boot code passes the real
 * `openHarness` factory, tests pass a fake core — the HTTP layer itself never opens SQLite.
 */
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigError, createLogger, loadConfig, type Config, type Logger } from "./config/index.js";
import { openHarness, type Core } from "./contracts/harness.js";
import type { UserDirectory } from "./contracts/roles.js";
import { createRoleResolver } from "./server/auth.js";
import { serve } from "./server/node-server.js";
import { createApp } from "./server/routes.js";

export interface BootstrapOptions {
  readonly config: Config;
  /** Opens the durable facade (S1's `openHarness`). Injected so tests stay harness-free. */
  readonly openCore: (config: Config) => Promise<Core>;
  readonly logger?: Logger;
  /**
   * `users` directory for OpenWebUI-header role resolution (SPEC §4). Absent until D2 ships its
   * repository, so M1 roles come from the static keys only (resolver degrades to `static-keys`).
   */
  readonly users?: UserDirectory;
  /** Overrides `config.port` (`0` binds a free port). */
  readonly port?: number;
  readonly hostname?: string;
}

export interface RunningServer {
  /** Port actually bound (`config.port` or the OS-assigned one). */
  readonly port: number;
  /** Stops the HTTP server, then seals and closes the core (K11). Idempotent. */
  close(): Promise<void>;
}

/**
 * Boot sequence: create the data directory, open + resume the core, build the app, listen.
 * Logs `hmwrk listening on :PORT` once the socket is bound.
 */
export async function bootstrap(options: BootstrapOptions): Promise<RunningServer> {
  const { config } = options;
  const logger = options.logger ?? createLogger({ level: config.logLevel, bindings: { module: "server" } });

  // Config resolves paths but never touches the filesystem; boot owns creating them.
  mkdirSync(config.dataDir, { recursive: true });

  const core = await options.openCore(config);
  await core.resume();

  const resolver = createRoleResolver({
    keys: config.roles,
    ...(options.users === undefined ? {} : { users: options.users }),
  });
  logger.info("role resolver configured", { mode: resolver.mode });

  const app = createApp({ core, resolver, logger });
  const server = await serve(app, {
    port: options.port ?? config.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });
  logger.info(`hmwrk listening on :${server.port}`, { port: server.port });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await server.close();
      await core.close();
      logger.info("hmwrk stopped");
    })();
    return closing;
  };

  return { port: server.port, close };
}

/** Process entry point: real config, real core, SIGTERM/SIGINT handling. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, bindings: { module: "boot" } });

  const running = await bootstrap({
    config,
    logger,
    // S1 implements `openHarness`; until it lands, boot fails loudly instead of serving nothing.
    openCore: (loaded) => openHarness(loaded),
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info(`received ${signal}, shutting down`);
    // K11: closing can take a moment (runs finish); never hang the host's `docker stop`.
    const hardExit = setTimeout(() => {
      logger.error("graceful shutdown timed out");
      process.exit(1);
    }, 10_000);
    hardExit.unref();
    void running.close().then(
      () => {
        clearTimeout(hardExit);
        process.exit(0);
      },
      (error: unknown) => {
        logger.error("shutdown failed", { error });
        process.exit(1);
      },
    );
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // A failed boot must say why (config problems are multi-line) and exit non-zero.
  void main().catch((error: unknown) => {
    const detail =
      error instanceof ConfigError
        ? error.format()
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error);
    process.stderr.write(`hmwrk failed to start: ${detail}\n`);
    process.exit(1);
  });
}
