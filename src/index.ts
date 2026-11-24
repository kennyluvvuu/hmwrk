/**
 * hmwrk entry point.
 *
 * Only process concerns live here: load config, build the wired application (`src/app.ts`), listen,
 * and shut down on `SIGTERM`/`SIGINT`. Everything about *what* is wired — core, domain, LLM, agent,
 * verify task, roles — is in {@link createHmwrkApp}, so this file has no ordering knowledge to get
 * wrong and the integration tests drive the very same wiring.
 *
 * Tests pass a fake or temp-dir config through {@link bootstrap}; the HTTP layer never opens SQLite.
 */
import { pathToFileURL } from "node:url";
import { createHmwrkApp, type CreateHmwrkAppOptions, type HmwrkApp } from "./app.js";
import { ConfigError, createLogger, loadConfig, type Config, type Logger } from "./config/index.js";
import { shutdown } from "./durable/index.js";
import { serve } from "./server/node-server.js";

export interface BootstrapOptions extends Omit<CreateHmwrkAppOptions, "logger"> {
  readonly logger?: Logger;
  /** Overrides `config.port` (`0` binds a free port). */
  readonly port?: number;
  readonly hostname?: string;
}

export interface RunningServer {
  /** Port actually bound (`config.port` or the OS-assigned one). */
  readonly port: number;
  /** The wired application, for tests and for embedding. */
  readonly app: HmwrkApp;
  /** Stops the HTTP server, then seals and closes the core (K11). Idempotent. */
  close(): Promise<void>;
}

/**
 * Boot sequence: build the app (core → domain → LLM → verify → tools → agent → roles → runner),
 * then listen. Logs `hmwrk listening on :PORT` once the socket is bound.
 */
export async function bootstrap(options: BootstrapOptions): Promise<RunningServer> {
  const { port, hostname, logger: injectedLogger, ...appOptions } = options;
  const { config } = options;
  const logger = injectedLogger ?? createLogger({ level: config.logLevel, bindings: { module: "server" } });

  const app = await createHmwrkApp({ ...appOptions, logger });
  const server = await serve(app.app, {
    port: port ?? config.port,
    ...(hostname === undefined ? {} : { hostname }),
  });
  logger.info(`hmwrk listening on :${server.port}`, { port: server.port });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await server.close();
      // K11: seal admission, settle committed commits, wait for running task code. The hard-exit
      // safety timer lives in `shutdown()` — one shutdown path, not two.
      await shutdown(app.core, { logger });
      logger.info("hmwrk stopped");
    })();
    return closing;
  };

  return { port: server.port, app, close };
}

/** Process entry point: real config, real core, SIGTERM/SIGINT handling. */
async function main(): Promise<void> {
  const config: Config = loadConfig();
  const logger = createLogger({ level: config.logLevel, bindings: { module: "boot" } });

  const running = await bootstrap({ config, logger });

  const handle = (signal: NodeJS.Signals): void => {
    logger.info(`received ${signal}, shutting down`);
    // `shutdown()` inside `close()` guards a hanging close with its own timer (10 s, K11).
    void running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("shutdown failed", { error });
        process.exit(1);
      },
    );
  };

  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
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
