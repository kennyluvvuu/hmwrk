#!/usr/bin/env node
/**
 * Minimal Telegram Bot API mock for `scripts/verify-m3.sh` (I3).
 *
 * The real client (`src/telegram/client.ts`) only ever calls
 * `POST <TELEGRAM_API_URL>/bot<token>/sendMessage`, so that is all this server implements. It answers
 * with the `{ ok: true, result: { message_id } }` envelope Telegram returns, and appends one JSON line
 * per message to `MOCK_TELEGRAM_LOG`, which is what the verification script greps:
 *
 *   {"chat_id":"222","text":"<b>Завтра сдать…</b>","parse_mode":"HTML"}
 *
 * Recording the raw `text` (HTML included) is deliberate: the e2e proves both that the broadcast went
 * out and that the data inside it was escaped.
 *
 * Env: `MOCK_TELEGRAM_PORT` (127.0.0.1) and `MOCK_TELEGRAM_LOG`. Anything other than `sendMessage`
 * answers `404`, like the Bot API does for an unknown method.
 */

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.MOCK_TELEGRAM_PORT ?? 0);
const logPath = process.env.MOCK_TELEGRAM_LOG;

if (logPath === undefined || logPath === "") {
  process.stderr.write("mock-telegram: MOCK_TELEGRAM_LOG is required\n");
  process.exit(2);
}
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("mock-telegram: MOCK_TELEGRAM_PORT must be a positive port\n");
  process.exit(2);
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const method = /^\/bot[^/]+\/([A-Za-z]+)/.exec(request.url ?? "")?.[1];
    if (request.method !== "POST" || method !== "sendMessage") {
      json(response, 404, { ok: false, error_code: 404, description: "Not Found" });
      return;
    }

    let payload = {};
    try {
      payload = body === "" ? {} : JSON.parse(body);
    } catch {
      json(response, 400, { ok: false, error_code: 400, description: "Bad Request: bad JSON" });
      return;
    }

    appendFileSync(
      logPath,
      `${JSON.stringify({
        chat_id: payload.chat_id ?? null,
        text: payload.text ?? "",
        parse_mode: payload.parse_mode ?? null,
      })}\n`,
    );

    json(response, 200, {
      ok: true,
      result: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id },
        text: payload.text,
      },
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock telegram listening on 127.0.0.1:${port}\n`);
});
