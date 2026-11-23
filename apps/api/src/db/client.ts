import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

function ensureLocalDatabaseDirectory(url: string): void {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  if (path !== ":memory:" && path.includes("/")) {
    mkdirSync(dirname(path), { recursive: true });
  }
}

ensureLocalDatabaseDirectory(config.databaseUrl);

export const db: Client = createClient({
  url: config.databaseUrl,
  ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}),
});
