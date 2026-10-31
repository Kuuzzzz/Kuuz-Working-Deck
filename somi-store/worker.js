const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function text(data, status = 200) {
  return new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function telegramCall(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${method} failed`);
  return result;
}

async function sendMessage(env, chatId, message, extra = {}) {
  return telegramCall(env, "sendMessage", { chat_id: chatId, text: message, ...extra });
}

async function getAuthorizedUser(env, telegramId) {
  return env.DB.prepare(
    "SELECT telegram_id, display_name, role, enabled, language FROM telegram_users WHERE telegram_id = ? AND enabled = 1"
  ).bind(String(telegramId)).first();
}

async function setLanguage(env, telegramId, language) {
  await env.DB.prepare(
    "UPDATE telegram_users SET language = ? WHERE telegram_id = ? AND enabled = 1"
  ).bind(language, String(telegramId)).run();
}

async function shopSummary(env, language) {
  const [customers, orders, pending, payments] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM customers").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE LOWER(status) NOT IN ('done','completed','delivered','cancelled')").first(),
    env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM payments").first()
  ]);
  if (language === "km") {
    return [
      "🌸 សង្ខេប Somi Store",
      `អតិថិជនសរុប៖ ${customers?.n ?? 0}`,
      `ការបញ្ជាទិញសរុប៖ ${orders?.n ?? 0}`,
      `ការបញ្ជាទិញកំពុងដំណើរការ៖ ${pending?.n ?? 0}`,
      `ប្រាក់ទទួលបានសរុប៖ ${Number(payments?.n ?? 0).toLocaleString("en-US")}`
    ].join("\n");
  }
  return [
    "🌸 Somi Store Summary",
    `Customers: ${customers?.n ?? 0}`,
    `Total orders: ${orders?.n ?? 0}`,
    `Open orders: ${pending?.n ?? 0}`,
    `Payments received: ${Number(payments?.n ?? 0).toLocaleString("en-US")}`
  ].join("\n");
}

async function askGemini(env, prompt, language) {
  if (!env.GEMINI_API_KEY) return language === "km"
    ? "ខ្ញុំមិនទាន់អាចភ្ជាប់ Gemini បានទេ។ សូមព្យាយាមម្ដងទៀតពេលក្រោយ។"
    : "Gemini is not configured yet. Please try again later.";
  const system = language === "km"
    ? "អ្នកគឺ Somi Store Assistant។ ឆ្លើយជាភាសាខ្មែរ ឲ្យខ្លី ច្បាស់ និងរួសរាយ។ ជួយណែនាំការគ្រប់គ្រងហាង។ កុំអះអាងថាបានបង្កើត ឬកែប្រែទិន្នន័យ។ ប្រសិនបើសំណើពាក់ព័ន្ធនឹងការបញ្ជាទិញ អតិថិជន ការទូទាត់ ឬដឹកជញ្ជូន សូមណែនាំឲ្យប្រើមុខងារដែលមាន។"
    : "You are Somi Store Assistant. Reply warmly and concisely in English. Help the shop owner understand store operations. Never claim to have created or changed records. If a request involves orders, customers, payments, or delivery, explain that record-management actions will be available through guided flows.";
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: String(prompt).slice(0, 4000) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 500 }
      })
    }
  );
  if (!response.ok) throw new Error("Gemini request failed");
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim()
    || (language === "km" ? "សូមសាកល្បងម្ដងទៀត។" : "Sorry, I couldn't prepare a reply. Please try again.");
}

async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message?.chat?.id || !message?.from?.id || typeof message.text !== "string") return;
  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const input = message.text.trim();
  const languageRow = await env.DB.prepare(
    "SELECT language FROM telegram_users WHERE telegram_id = ?"
  ).bind(telegramId).first();
  const language = languageRow?.language === "km" ? "km" : "en";
  const user = await getAuthorizedUser(env, telegramId);
  if (!user) {
    await sendMessage(env, chatId, "🔒 This account is not authorized to access Somi Store. Please ask the shop owner to add your Telegram account.");
    return;
  }
  if (input === "/start" || input === "/help") {
    const greeting = language === "km"
      ? "សួស្តី! 🌸 ខ្ញុំជា Somi Store Assistant។\n\nខ្ញុំអាចជួយមើលសង្ខេបហាង និងណែនាំការគ្រប់គ្រងអតិថិជន ការបញ្ជាទិញ ការទូទាត់ និងការដឹកជញ្ជូន។\n\n/summary — មើលសង្ខេបហាង\n/language — ប្ដូរភាសា\n/help — ជំនួយ"
      : "Welcome to Somi Store Assistant 🌸\n\nI can help with your shared shop workspace: customers, orders, payments and deliveries.\n\n/summary — View shop summary\n/language — Change language\n/help — Help";
    await sendMessage(env, chatId, greeting);
    return;
  }
  if (input === "/language") {
    await sendMessage(env, chatId, "Choose your language / ជ្រើសរើសភាសា", {
      reply_markup: { inline_keyboard: [[
        { text: "English", callback_data: "lang_en" },
        { text: "ខ្មែរ", callback_data: "lang_km" }
      ]] }
    });
    return;
  }
  if (input === "/summary") {
    await sendMessage(env, chatId, await shopSummary(env, language));
    return;
  }
  if (input === "/cancel") {
    await env.DB.prepare("DELETE FROM bot_sessions WHERE telegram_id = ?").bind(telegramId).run();
    await sendMessage(env, chatId, language === "km" ? "បានបោះបង់សកម្មភាពបច្ចុប្បន្ន។" : "Current action cancelled.");
    return;
  }
  const reply = await askGemini(env, input, language);
  await sendMessage(env, chatId, reply);
}

async function handleCallback(update, env) {
  const query = update.callback_query;
  if (!query?.from?.id || !query?.message?.chat?.id) return;
  const telegramId = String(query.from.id);
  const user = await getAuthorizedUser(env, telegramId);
  if (!user) {
    await telegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Not authorized" });
    return;
  }
  const language = query.data === "lang_km" ? "km" : "en";
  await setLanguage(env, telegramId, language);
  await telegramCall(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Language updated" });
  await sendMessage(env, query.message.chat.id, language === "km" ? "បានប្ដូរភាសាទៅខ្មែរ។ 🌸" : "Language changed to English. 🌸");
}

const connectPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Somi Store Telegram</title><style>body{font:16px system-ui;background:#fff7fb;color:#29202a;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;padding:28px;border-radius:18px;max-width:420px;width:calc(100% - 56px);box-shadow:0 8px 32px #5b17401a}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:10px;margin-top:12px;font:inherit}input{border:1px solid #ddd}button{border:0;background:#e94b91;color:white;font-weight:700;cursor:pointer}#result{white-space:pre-wrap;margin-top:16px}</style></head><body><main class="card"><h2>🌸 Connect KuuzBot</h2><p>Enter your existing TELEGRAM_WEBHOOK_SECRET from your Cloudflare Worker settings. It stays in this browser and is sent securely to your development Worker.</p><input id="secret" type="password" autocomplete="off" placeholder="Webhook secret"><button id="connect">Connect Telegram</button><div id="result" role="status"></div></main><script>document.getElementById('connect').addEventListener('click',async()=>{const secret=document.getElementById('secret').value;const result=document.getElementById('result');if(!secret){result.textContent='Please enter the webhook secret.';return;}result.textContent='Connecting…';try{const r=await fetch('/setup-webhook',{method:'POST',headers:{'X-Setup-Secret':secret}});const d=await r.json();result.textContent=d.ok?'✅ Telegram webhook connected! Open Telegram and send /start to @KuuzBot.':('❌ '+(d.error||'Connection failed'));if(d.ok)document.getElementById('secret').value='';}catch(e){result.textContent='Connection failed. Please try again.';}});</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "somi-store-assistant", mode: "development" });
    }
    if (url.pathname === "/connect-telegram" && request.method === "GET") {
      return new Response(connectPage, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/setup-webhook" && request.method === "POST") {
      const suppliedSecret = request.headers.get("X-Setup-Secret");
      if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return json({ ok: false, error: "Secret did not match. Check the TELEGRAM_WEBHOOK_SECRET in Worker settings." }, 401);
      }
      if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "TELEGRAM_BOT_TOKEN is missing from Worker secrets." }, 500);
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
        return json({ ok: false, error: "Your webhook secret must contain only A-Z, a-z, 0-9, underscore or hyphen. Update that Worker secret, then retry." }, 400);
      }
      try {
        const webhookUrl = `${url.origin}/telegram/webhook`;
        const result = await telegramCall(env, "setWebhook", {
          url: webhookUrl,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true
        });
        return json({ ok: true, message: "Telegram webhook connected", webhook: webhookUrl, telegram_result: result.description || "Webhook was set" });
      } catch (error) {
        return json({ ok: false, error: error.message || "Telegram could not register the webhook." }, 502);
      }
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) return text("Unauthorized", 401);
      let update;
      try { update = await request.json(); } catch { return text("Invalid JSON", 400); }
      try {
        if (update.callback_query) await handleCallback(update, env);
        else await handleTelegramUpdate(update, env);
      } catch (error) {
        console.error("Telegram update handling failed:", error?.message || "unknown error");
      }
      return json({ ok: true });
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "API route not implemented yet" }, 501);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return text("Somi Store Assistant is running.");
  }
};