import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { applySchema } from "./db/schema.js";

const app = buildApp();
const ready = (async () => {
  await applySchema(db);
  await app.ready();
})();

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await ready;
  app.server.emit("request", request, response);
}
