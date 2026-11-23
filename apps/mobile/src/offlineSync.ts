import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { notificationCapture } from "./notificationCapture.js";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";
const DATABASE_KEY = "finova_offline_db_key";
const DEVICE_ID_KEY = "finova_device_id";

export type OfflineOperationType =
  | "transaction"
  | "transfer"
  | "notification_confirmation"
  | "notification_delete";
export type OfflineOperation = {
  id: string;
  operation_type: OfflineOperationType;
  status: "pending" | "failed";
  created_at: string;
  payload: Record<string, unknown> & { idempotencyKey: string; amountMinor?: number; description?: string };
  last_error: string | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
let syncPromise: Promise<{ pendingCount: number; failedCount: number }> | undefined;

async function database() {
  if (!databasePromise) {
    databasePromise = (async () => {
      let key = await SecureStore.getItemAsync(DATABASE_KEY);
      if (!key) {
        key = Array.from(await Crypto.getRandomBytesAsync(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
        await SecureStore.setItemAsync(DATABASE_KEY, key, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
      }
      const db = await SQLite.openDatabaseAsync("finova-offline.db");
      await db.execAsync(`PRAGMA key = "x'${key}'";`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS offline_operations (
          id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          last_error TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS offline_reference_data (
          user_id TEXT PRIMARY KEY NOT NULL,
          accounts_json TEXT NOT NULL,
          categories_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_offline_operations_user_status
          ON offline_operations(user_id,status,created_at);
      `);
      return db;
    })().catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function saveOfflineReferenceData(
  userId: string,
  accounts: unknown[],
  categories: unknown[],
) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO offline_reference_data(user_id,accounts_json,categories_json,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET accounts_json=excluded.accounts_json,
       categories_json=excluded.categories_json,updated_at=excluded.updated_at`,
    userId,
    JSON.stringify(accounts),
    JSON.stringify(categories),
    new Date().toISOString(),
  );
}

export async function getOfflineReferenceData(userId: string) {
  const db = await database();
  const row = await db.getFirstAsync<{
    accounts_json: string;
    categories_json: string;
  }>("SELECT accounts_json,categories_json FROM offline_reference_data WHERE user_id=?", userId);
  if (!row) return { accounts: [], categories: [] };
  return {
    accounts: JSON.parse(row.accounts_json) as unknown[],
    categories: JSON.parse(row.categories_json) as unknown[],
  };
}

export async function getDeviceId() {
  let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  return deviceId;
}

export async function enqueueOfflineOperation(
  userId: string,
  operationType: OfflineOperationType,
  payload: Record<string, unknown> & { idempotencyKey: string },
) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO offline_operations (id,user_id,operation_type,payload,status,created_at)
     VALUES (?,?,?,?,'pending',?)`,
    payload.idempotencyKey,
    userId,
    operationType,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

export async function listOfflineOperations(userId: string): Promise<OfflineOperation[]> {
  const db = await database();
  const rows = await db.getAllAsync<Omit<OfflineOperation, "payload"> & { payload: string }>(
    `SELECT id,operation_type,payload,status,last_error,created_at
     FROM offline_operations WHERE user_id=? AND status IN ('pending','failed')
     ORDER BY created_at`,
    userId,
  );
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as OfflineOperation["payload"] }));
}

export async function discardOfflineOperation(userId: string, operationId: string) {
  const db = await database();
  await db.runAsync(
    "DELETE FROM offline_operations WHERE id=? AND user_id=? AND status='failed'",
    operationId,
    userId,
  );
}

export async function discardOfflineOperations(userId: string, operationType: OfflineOperationType) {
  const db = await database();
  await db.runAsync(
    "DELETE FROM offline_operations WHERE user_id=? AND operation_type=?",
    userId,
    operationType,
  );
}

export function syncOfflineOperations(token: string, userId: string) {
  if (syncPromise) return syncPromise;
  syncPromise = flushOfflineOperations(token, userId).finally(() => { syncPromise = undefined; });
  return syncPromise;
}

async function flushOfflineOperations(token: string, userId: string) {
  const db = await database();
  const network = await Network.getNetworkStateAsync();
  if (!network.isConnected || network.isInternetReachable === false) {
    const current = await listOfflineOperations(userId);
    return {
      pendingCount: current.filter((operation) => operation.status === "pending").length,
      failedCount: current.filter((operation) => operation.status === "failed").length,
    };
  }
  const operations = await db.getAllAsync<{
    id: string;
    operation_type: OfflineOperationType;
    payload: string;
  }>(
    `SELECT id,operation_type,payload FROM offline_operations
     WHERE user_id=? AND status='pending' ORDER BY created_at`,
    userId,
  );
  const deviceId = await getDeviceId();
  for (const operation of operations) {
    try {
      const response = await fetch(`${API_URL}/api/v1/sync/operations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          idempotencyKey: operation.id,
          operationType: operation.operation_type,
          payload: JSON.parse(operation.payload),
        }),
      });
      if (response.ok) {
        const payload = JSON.parse(operation.payload) as { candidateId?: string };
        if (operation.operation_type === "notification_confirmation" && payload.candidateId) {
          await notificationCapture?.removeCandidate(payload.candidateId);
        }
        await db.runAsync("DELETE FROM offline_operations WHERE id=? AND user_id=?", operation.id,userId);
        continue;
      }
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (response.status >= 400 && response.status < 500 && response.status !== 401) {
        await db.runAsync(
          "UPDATE offline_operations SET status='failed',last_error=? WHERE id=? AND user_id=?",
          result.message ?? `Server rejected the operation (${response.status}).`,
          operation.id,
          userId,
        );
        continue;
      }
      break;
    } catch {
      break;
    }
  }
  const current = await listOfflineOperations(userId);
  return {
    pendingCount: current.filter((operation) => operation.status === "pending").length,
    failedCount: current.filter((operation) => operation.status === "failed").length,
  };
}
