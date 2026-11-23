import { SignJWT, jwtVerify } from "jose";
import { createHash, randomUUID } from "node:crypto";
import { db } from "./db/client.js";
import { config } from "./config.js";

export interface AuthUser {
  userId: string;
  email: string;
  sessionId: string;
}

const secret = new TextEncoder().encode(config.jwtSecret);

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, email: string) {
  const sessionId = randomUUID();
  const token = await new SignJWT({ email, sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [sessionId, userId, hashToken(token), expiresAt, new Date().toISOString()],
  });
  return { token, sessionId, expiresAt };
}

export async function authenticate(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.sub;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!userId || !sessionId || !email) return null;

    const result = await db.execute({
      sql: `SELECT s.id FROM sessions s
            WHERE s.id = ? AND s.user_id = ? AND s.token_hash = ?
              AND s.revoked_at IS NULL AND s.expires_at > ?`,
      args: [sessionId, userId, hashToken(token), new Date().toISOString()],
    });
    if (result.rows.length !== 1) return null;
    return { userId, email, sessionId };
  } catch {
    return null;
  }
}
