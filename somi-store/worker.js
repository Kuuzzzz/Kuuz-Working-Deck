const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function allowedTelegramIds(env) { return new Set(String(env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").map(v => v.trim()).filter(Boolean)); }
async function telegramSend(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot token is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
}
async function askGemini(env, message) {
  if (!env.GEMINI_API_KEY) throw new Error("Gemini API key is not configured.");
  const prompt = [
    "You are Somi Store Assistant, a private shop-management assistant.",
    "Support natural English and Khmer; reply in the language the user uses.",
    "This is the initial setup phase. Do not claim to have read or changed store records.",
    "If asked to create or update store records, explain that shared database actions are still being connected.",
    "Never ask for passwords, API keys, or payment card details.",
    `User message: ${message}`
  ].join("\n");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 500 } })
  });
  if (!response.ok) throw new Error(`Gemini request failed: ${response.status}`);
  const result = await response.json();
  return result.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "Sorry, I couldn't prepare a reply. Please try again.";
}
async function handleTelegram(request, env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || request.headers.get("x-telegram-bot-api-secret-token") !== expected) return json({ error: "Unauthorized webhook" }, 401);
  const update = await request.json();
  const message = update.message;
  if (!message?.chat?.id || !message?.from?.id || typeof message.text !== "string") return json({ ok: true });
  const userId = String(message.from.id), chatId = message.chat.id;
  if (!allowedTelegramIds(env).has(userId)) {
    await telegramSend(env, chatId, `Somi Store Assistant 🌸\nYour Telegram user ID is: ${userId}\n\nYou are not authorized yet. Please ask the store owner to approve this ID.`);
    return json({ ok: true, authorized: false });
  }
  const text = message.text.trim();
  if (text === "/start" || text === "/help") {
    await telegramSend(env, chatId, "Welcome to Somi Store Assistant 🌸\nI can chat in English or Khmer. Shared customer and order management is still being connected.");
    return json({ ok: true });
  }
  try { await telegramSend(env, chatId, await askGemini(env, text)); }
  catch (error) {
    await telegramSend(env, chatId, "Sorry, the assistant is temporarily unavailable. Please try again later.");
    return json({ ok: false, error: error.message }, 502);
  }
  return json({ ok: true });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "somi-store-worker" });
    if (request.method === "POST" && url.pathname === "/telegram/webhook") return handleTelegram(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Store API is not connected yet." }, 501);
    return env.ASSETS.fetch(request);
  }
};
