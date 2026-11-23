import "dotenv/config";

type ProductionConfig = {
  jwtSecret: string;
  databaseUrl: string;
  databaseAuthToken?: string;
  corsOrigins: string[];
};

export function validateProductionConfig(value: ProductionConfig): void {
  if (value.jwtSecret.length < 32
    || value.jwtSecret === "development-only-secret-change-before-use") {
    throw new Error("JWT_SECRET must be at least 32 characters in production.");
  }
  if (!value.databaseUrl.startsWith("libsql://") && !value.databaseUrl.startsWith("https://")) {
    throw new Error("Production DATABASE_URL must use a secure remote libSQL endpoint.");
  }
  if (!value.databaseAuthToken?.trim()) {
    throw new Error("DATABASE_AUTH_TOKEN must be set for the production database.");
  }
  if (value.corsOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must include the production web origin.");
  }
  for (const origin of value.corsOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("CORS_ORIGINS must contain valid HTTPS origins.");
    }
    if (parsed.protocol !== "https:" || parsed.origin !== origin) {
      throw new Error("CORS_ORIGINS must contain valid HTTPS origins without paths.");
    }
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "file:./data/upf.db",
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN,
  jwtSecret: process.env.JWT_SECRET ?? "development-only-secret-change-before-use",
  corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
};

if (process.env.NODE_ENV === "production") {
  validateProductionConfig(config);
}
