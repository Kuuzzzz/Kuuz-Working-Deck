const SYNC_ROUTES = new Set([
  "/.netlify/functions/somi-store-sync",
  "/api/somi-store-sync"
]);

const MAX_PAYLOAD_BYTES = 1_500_000;
const WORKSPACE_ID = "main";
const TABLE_NAME = "somi_store_workspace";

let schemaPromise;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}

function constantTimeEqual(actual, expected) {
  const encoder = new TextEncoder();
  const a = encoder.encode(String(actual || ""));
  const b = encoder.encode(String(expected || ""));
  if (!b.length || a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.prepare(
      `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        workspace_id TEXT PRIMARY KEY NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      )`
    ).run();
  }

  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = undefined;
    throw error;
  }
}

async function readWorkspace(db) {
  return db.prepare(
    `SELECT data_json, updated_at, revision
       FROM ${TABLE_NAME}
      WHERE workspace_id = ?1
      LIMIT 1`
  ).bind(WORKSPACE_ID).first();
}

function validateWorkspace(data) {
  return Boolean(
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray(data.customers) &&
    Array.isArray(data.orders) &&
    data.customers.length <= 20000 &&
    data.orders.length <= 50000
  );
}

async function handleSync(request, env) {
  if (!["GET", "PUT"].includes(request.method)) {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const configuredPin = env.SOMI_STORE_PIN;
  if (typeof configuredPin !== "string" || configuredPin.length < 16) {
    return jsonResponse({
      error: "Somi Store cloud access is not configured. The owner must set a private SOMI_STORE_PIN (at least 16 characters) in Cloudflare Worker secrets."
    }, 503);
  }

  if (!env.SOMI_DB) {
    return jsonResponse({
      error: "Somi Store cloud database is not connected yet. Ask the owner to finish the Cloudflare D1 setup."
    }, 503);
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ error: "This origin is not allowed." }, 403);
  }

  const suppliedPin = request.headers.get("x-somi-pin");
  if (!constantTimeEqual(suppliedPin, configuredPin)) {
    return jsonResponse({ error: "Incorrect Somi Store access PIN." }, 401);
  }

  try {
    const db = env.SOMI_DB;
    await ensureSchema(db);

    if (request.method === "GET") {
      const saved = await readWorkspace(db);
      if (!saved) {
        return jsonResponse({ data: null, updatedAt: 0, orderCount: 0, revision: 0 });
      }

      let data;
      try {
        data = JSON.parse(saved.data_json);
      } catch {
        return jsonResponse({ error: "The shared store data could not be read. Your local records have not been changed." }, 500);
      }

      if (!validateWorkspace(data)) {
        return jsonResponse({ error: "The shared store contains invalid workspace data. Your local records have not been changed." }, 500);
      }

      return jsonResponse({
        data,
        updatedAt: Number(saved.updated_at || 0),
        revision: Number(saved.revision || 1),
        orderCount: data.orders.length
      });
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: "The workspace data is too large to sync." }, 413);
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: "The workspace data is too large to sync." }, 413);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "The sync request is not valid JSON." }, 400);
    }

    const data = body?.data;
    if (!validateWorkspace(data)) {
      return jsonResponse({ error: "Invalid workspace data. Customer and order records must be valid lists." }, 400);
    }

    const expectedUpdatedAt = Number(body?.baseUpdatedAt);
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
      return jsonResponse({ error: "The sync version is missing. Refresh the shared store and try again." }, 400);
    }

    const serialized = JSON.stringify(data);
    if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: "The workspace data is too large to sync." }, 413);
    }

    const current = await readWorkspace(db);
    const currentUpdatedAt = Number(current?.updated_at || 0);

    if (currentUpdatedAt !== expectedUpdatedAt) {
      return jsonResponse({
        error: "The shared store changed on another device. Your local records are safe. Reconnect in Settings and choose whether to upload this device or download the shared copy.",
        conflict: true,
        currentUpdatedAt,
        orderCount: current ? (() => {
          try { return JSON.parse(current.data_json).orders?.length || 0; } catch { return 0; }
        })() : 0
      }, 409);
    }

    const updatedAt = Date.now();
    let result;

    if (!current) {
      result = await db.prepare(
        `INSERT OR IGNORE INTO ${TABLE_NAME}
           (workspace_id, data_json, updated_at, revision)
         VALUES (?1, ?2, ?3, 1)`
      ).bind(WORKSPACE_ID, serialized, updatedAt).run();
    } else {
      result = await db.prepare(
        `UPDATE ${TABLE_NAME}
            SET data_json = ?1,
                updated_at = ?2,
                revision = revision + 1
          WHERE workspace_id = ?3
            AND updated_at = ?4`
      ).bind(serialized, updatedAt, WORKSPACE_ID, expectedUpdatedAt).run();
    }

    if (Number(result?.meta?.changes || 0) !== 1) {
      return jsonResponse({
        error: "Another device saved changes first. Your local records are safe. Reconnect in Settings to resolve the two copies.",
        conflict: true
      }, 409);
    }

    const revision = current ? Number(current.revision || 1) + 1 : 1;
    return jsonResponse({
      ok: true,
      updatedAt,
      revision,
      orderCount: data.orders.length
    });
  } catch (error) {
    console.error("Somi Store D1 sync failed:", error?.message || error);
    return jsonResponse({
      error: "Cloud sync failed. Your records remain saved in this browser. Try again or export a backup."
    }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (SYNC_ROUTES.has(url.pathname)) {
      return handleSync(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
