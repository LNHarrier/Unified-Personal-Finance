import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { applySchema } from "./db/schema.js";

await applySchema(db);

const app = buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
