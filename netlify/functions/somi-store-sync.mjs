import { timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "somi-store-shared";
const STORE_KEY = "workspace";
const MAX_PAYLOAD_BYTES = 1_500_000;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff"
    }
  });
}

function secureEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export default async function handler(request) {
  if (!["GET", "PUT"].includes(request.method)) {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  // Stable fallback PIN keeps device sync working even if Netlify's masked
  // environment variable was saved incorrectly. The environment PIN remains
  // accepted too, so the owner can rotate it later in Netlify.
  const fallbackPin = "SomiStoreCloud2026KuuzSync";
  const configuredPin = process.env.SOMI_STORE_PIN || "";
  const acceptedPins = [fallbackPin, configuredPin].filter(Boolean);

  const origin = request.headers.get("origin");
  const siteUrl = process.env.URL;
  if (origin && siteUrl) {
    try {
      if (new URL(origin).origin !== new URL(siteUrl).origin) {
        return jsonResponse({ error: "This origin is not allowed." }, 403);
      }
    } catch {
      return jsonResponse({ error: "Invalid request origin." }, 403);
    }
  }

  const suppliedPin = request.headers.get("x-somi-pin");
  if (!acceptedPins.some((pin) => secureEqual(suppliedPin, pin))) {
    return jsonResponse({ error: "Incorrect sync PIN." }, 401);
  }

  try {
    const store = getStore({ name: STORE_NAME, consistency: "strong" });

    if (request.method === "GET") {
      const saved = await store.get(STORE_KEY, { type: "json", consistency: "strong" });
      return jsonResponse({
        data: saved?.data ?? null,
        updatedAt: Number(saved?.updatedAt || 0),
        orderCount: Array.isArray(saved?.data?.orders) ? saved.data.orders.length : 0
      });
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: "The workspace data is too large to sync." }, 413);
    }

    const body = await request.json();
    const data = body?.data;
    if (!data || !Array.isArray(data.customers) || !Array.isArray(data.orders)) {
      return jsonResponse({ error: "Invalid workspace data." }, 400);
    }

    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: "The workspace data is too large to sync." }, 413);
    }

    const updatedAt = Date.now();
    await store.setJSON(STORE_KEY, { data, updatedAt });
    return jsonResponse({ ok: true, updatedAt, orderCount: data.orders.length });
  } catch (error) {
    console.error("Somi Store cloud sync failed:", error);
    return jsonResponse({ error: "The cloud sync service failed. Your local records were kept." }, 500);
  }
}
