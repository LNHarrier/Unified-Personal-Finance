import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";

process.env.DATABASE_URL = "file::memory:?cache=shared";
process.env.JWT_SECRET = "vercel-handler-test-secret-that-is-long-enough";

const [{ default: handler }, { db }] = await Promise.all([
  import("./vercel.js"),
  import("./db/client.js"),
]);

const server = createServer((request, response) => {
  void handler(request, response).catch((error: unknown) => {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : "Handler failed");
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  db.close();
});

describe("Vercel API handler", () => {
  it("serves Fastify health checks through the serverless adapter", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("passes API paths through the adapter and enforces authentication", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/users/me`);
    expect(response.status).toBe(401);
  });
});
