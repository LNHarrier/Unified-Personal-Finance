import { describe, expect, it } from "vitest";
import { validateProductionConfig } from "./config.js";

const validConfig = {
  jwtSecret: "a-production-secret-with-at-least-32-characters",
  databaseUrl: "libsql://finance-example.turso.io",
  databaseAuthToken: "database-access-token",
  corsOrigins: ["https://finance.example.com"],
};

describe("production configuration", () => {
  it("rejects local databases and missing database credentials", () => {
    expect(() => validateProductionConfig({
      ...validConfig,
      databaseUrl: "file:./data/upf.db",
    })).toThrow(/secure remote libSQL/);
    expect(() => validateProductionConfig({
      ...validConfig,
      databaseAuthToken: undefined,
    })).toThrow(/DATABASE_AUTH_TOKEN/);
  });

  it("requires a strong session secret and HTTPS web origins", () => {
    expect(() => validateProductionConfig({
      ...validConfig,
      jwtSecret: "short",
    })).toThrow(/at least 32 characters/);
    expect(() => validateProductionConfig({
      ...validConfig,
      corsOrigins: ["http://finance.example.com"],
    })).toThrow(/valid HTTPS origins/);
  });
});
