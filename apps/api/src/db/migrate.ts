import { db } from "./client.js";
import { applySchema } from "./schema.js";

try {
  await applySchema(db);
  console.log("Database migrations completed.");
} finally {
  db.close();
}
