/**
 * Minimal `node:http` ↔ Fetch bridge for the Hono app.
 *
 * `@hono/node-server` would do this, but adding a dependency is T0's file to change and the
 * bridge is ~60 lines. It streams both ways, so the SSE body reaches OpenWebUI as it is written
 * instead of being buffered.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** What `serve` needs from the app; `Hono` instances satisfy it. */
export interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

export interface ServeOptions {
  /** `0` picks a free port (useful in tests; production uses `Config.port`). */
  readonly port: number;
  /** Default: all interfaces, so a compose network can reach `hmwrk:8787`. */
  readonly hostname?: string;
}

export interface ServedHttp {
  /** The port actually bound (differs from the option when it was `0`). */
  readonly port: number;
  /** Stops accepting connections and resolves once they are closed. */
  close(): Promise<void>;
}

/** Converts an incoming Node request into the web `Request` Hono understands. */
function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/** Writes the web response back, streaming the body chunk by chunk. */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

async function handle(app: FetchApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const response = await app.fetch(toWebRequest(req));
    await writeResponse(res, response);
  } catch (error) {
    if (res.headersSent) {
      // Mid-stream failure (SSE): the body is gone, drop the connection.
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const payload = JSON.stringify({
      error: { message: "Internal server error", type: "server_error", code: null },
    });
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(payload);
  }
}

/** Listens on `options.port`; resolves once the socket is bound. */
export function serve(app: FetchApp, options: ServeOptions): Promise<ServedHttp> {
  const server: Server = createServer((req, res) => {
    void handle(app, req, res);
  });
  return new Promise<ServedHttp>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
