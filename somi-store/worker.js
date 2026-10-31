const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }
function text(data, status = 200) { return new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8" } }); }

async function telegramCall(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API ${method} failed`);
  return result;
}
async function sendMessage(env, chatId, message, extra = {}) {
  return telegramCall(env, "sendMessage", { chat_id: chatId, text: message, ...extra });
}
async function getAuthorizedUser(env, telegramId) {
  return env.DB.prepare("SELECT telegram_id, display_name, role, enabled, language FROM telegram_users WHERE telegram_id = ? AND enabled = 1").bind(String(telegramId)).first();
}
async function setLanguage(env, telegramId, language) {
  await env.DB.prepare("UPDATE telegram_users SET language = ? WHERE telegram_id = ? AND enabled = 1").bind(language, String(telegramId)).run();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function workspaceDate(value) {
  return value || new Date().toISOString().slice(0, 10);
}
async function readWorkspace(env) {
  const [customers, orderRows, paymentRows, deliveryRows, revision] = await Promise.all([
    env.DB.prepare("SELECT id, name, phone, email, address, notes FROM customers ORDER BY created_at, id").all(),
    env.DB.prepare("SELECT id, customer_id, product, qty, unit_price, total, status, customer_status, owner_status, delivery_method, tracking_number, color, size, delivery_date, notes FROM orders ORDER BY created_at, id").all(),
    env.DB.prepare("SELECT order_id, COALESCE(SUM(amount), 0) AS amount FROM payments GROUP BY order_id").all(),
    env.DB.prepare("SELECT d.order_id, d.delivery_status, d.delivery_method, d.tracking_number, d.delivery_date, d.notes FROM deliveries d INNER JOIN (SELECT order_id, MAX(created_at) AS latest FROM deliveries GROUP BY order_id) x ON x.order_id=d.order_id AND x.latest=d.created_at").all(),
    env.DB.prepare("SELECT MAX(ts) AS changed FROM (SELECT updated_at AS ts FROM customers UNION ALL SELECT updated_at FROM orders UNION ALL SELECT created_at FROM payments UNION ALL SELECT updated_at FROM deliveries)").first()
  ]);
  const paidByOrder = new Map((paymentRows.results || []).map(x => [String(x.order_id), safeNumber(x.amount)]));
  const deliveryByOrder = new Map((deliveryRows.results || []).map(x => [String(x.order_id), x]));
  const orders = (orderRows.results || []).map(row => {
    const delivery = deliveryByOrder.get(String(row.id)) || {};
    const deposit = paidByOrder.get(String(row.id)) || 0;
    const total = safeNumber(row.total);
    return {
      id: row.id, customer: row.customer_id, product: row.product, qty: safeNumber(row.qty, 1),
      unitPrice: safeNumber(row.unit_price), total, deposit: Math.min(total, deposit),
      remaining: Math.max(0, total - deposit), payment: deposit >= total && total > 0 ? "Paid" : deposit > 0 ? "Deposit Paid" : "Unpaid",
      status: row.customer_status || row.status || "Ordered",
      customerStatus: row.customer_status || row.status || "Ordered",
      ownerStatus: row.owner_status || "Not started",
      delivery: delivery.delivery_method || row.delivery_method || "",
      tracking: delivery.tracking_number || row.tracking_number || "",
      color: row.color || "", size: row.size || "",
      deliveryDate: delivery.delivery_date || row.delivery_date || "",
      date: workspaceDate(row.created_at), notes: row.notes || delivery.notes || ""
    };
  });
  const changed = revision?.changed ? Date.parse(revision.changed.replace(" ", "T") + (revision.changed.includes("Z") ? "" : "Z")) : 0;
  const data = {
    customers: (customers.results || []).map(c => ({ id:c.id, name:c.name, phone:c.phone || "", email:c.email || "", address:c.address || "", notes:c.notes || "" })),
    orders
  };
  return { data, updatedAt: Number.isFinite(changed) && changed > 0 ? changed : 0, customerCount:data.customers.length, orderCount:orders.length };
}
async function writeWorkspace(env, data) {
  if (!data || !Array.isArray(data.customers) || !Array.isArray(data.orders)) throw new Error("Workspace must contain customers and orders arrays.");
  if (data.customers.length > 5000 || data.orders.length > 10000) throw new Error("Workspace is larger than the allowed sync limit.");
  const statements = [];
  for (const c of data.customers) {
    if (!c?.id || !String(c.name || "").trim()) continue;
    statements.push(env.DB.prepare("INSERT INTO customers (id,name,phone,email,address,notes) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,email=excluded.email,address=excluded.address,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP")
      .bind(String(c.id), String(c.name).trim(), String(c.phone || ""), String(c.email || ""), String(c.address || ""), String(c.notes || "")));
  }
  for (const o of data.orders) {
    if (!o?.id || !o?.customer || !o?.product) continue;
    const total = Math.max(0, safeNumber(o.total));
    const qty = Math.max(1, safeNumber(o.qty, 1));
    const unitPrice = Math.max(0, safeNumber(o.unitPrice, total / qty));
    const status = String(o.customerStatus || o.status || "Ordered");
    const deliveryMethod = String(o.delivery || "");
    statements.push(env.DB.prepare("INSERT INTO orders (id,customer_id,product,qty,unit_price,total,status,customer_status,owner_status,delivery_method,tracking_number,color,size,delivery_date,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,product=excluded.product,qty=excluded.qty,unit_price=excluded.unit_price,total=excluded.total,status=excluded.status,customer_status=excluded.customer_status,owner_status=excluded.owner_status,delivery_method=excluded.delivery_method,tracking_number=excluded.tracking_number,color=excluded.color,size=excluded.size,delivery_date=excluded.delivery_date,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP")
      .bind(String(o.id), String(o.customer), String(o.product), qty, unitPrice, total, status, status, String(o.ownerStatus || "Not started"), deliveryMethod, String(o.tracking || ""), String(o.color || ""), String(o.size || ""), String(o.deliveryDate || ""), String(o.notes || "")));
    const deposit = Math.min(total, Math.max(0, safeNumber(o.deposit)));
    const paymentId = "WEB-" + String(o.id);
    if (deposit > 0) {
      statements.push(env.DB.prepare("INSERT INTO payments (id,order_id,amount,payment_method,payment_date,notes) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount,payment_method=excluded.payment_method,payment_date=excluded.payment_date,notes=excluded.notes")
        .bind(paymentId, String(o.id), deposit, "Dashboard sync", workspaceDate(o.date), "Synced deposit / total paid from Somi Store dashboard"));
    } else {
      statements.push(env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(paymentId));
    }
    const deliveryId = "WEB-" + String(o.id);
    statements.push(env.DB.prepare("INSERT INTO deliveries (id,order_id,delivery_status,delivery_method,tracking_number,delivery_date,notes) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET delivery_status=excluded.delivery_status,delivery_method=excluded.delivery_method,tracking_number=excluded.tracking_number,delivery_date=excluded.delivery_date,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP")
      .bind(deliveryId, String(o.id), status, deliveryMethod, String(o.tracking || ""), String(o.deliveryDate || ""), String(o.notes || "")));
  }
  if (statements.length) await env.DB.batch(statements);
  return readWorkspace(env);
}

async function shopSummary(env, language) {
  const [customers, orders, pending, payments] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM customers").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE LOWER(COALESCE(customer_status,status,'ordered')) NOT IN ('done','completed','delivered','cancelled')").first(),
    env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM payments").first()
  ]);
  if (language === "km") return ["🌸 សង្ខេប Somi Store",`អតិថិជនសរុប៖ ${customers?.n ?? 0}`,`ការបញ្ជាទិញសរុប៖ ${orders?.n ?? 0}`,`ការបញ្ជាទិញកំពុងដំណើរការ៖ ${pending?.n ?? 0}`,`ប្រាក់ទទួលបានសរុប៖ ${Number(payments?.n ?? 0).toLocaleString("en-US")}`].join("\n");
  return ["🌸 Somi Store Summary",`Customers: ${customers?.n ?? 0}`,`Total orders: ${orders?.n ?? 0}`,`Open orders: ${pending?.n ?? 0}`,`Payments received: ${Number(payments?.n ?? 0).toLocaleString("en-US")}`].join("\n");
}
async function askGemini(env, prompt, language) {
  if (!env.GEMINI_API_KEY) return language === "km" ? "ខ្ញុំមិនទាន់អាចភ្ជាប់ Gemini បានទេ។ សូមព្យាយាមម្ដងទៀតពេលក្រោយ។" : "Gemini is not configured yet. Please try again later.";
  const system = language === "km" ? "អ្នកគឺ Somi Store Assistant។ ឆ្លើយជាភាសាខ្មែរ ឲ្យខ្លី ច្បាស់ និងរួសរាយ។ ជួយណែនាំការគ្រប់គ្រងហាង។ កុំអះអាងថាបានបង្កើត ឬកែប្រែទិន្នន័យ។" : "You are Somi Store Assistant. Reply warmly and concisely in English. Help the shop owner understand store operations. Never claim to have created or changed records.";
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method:"POST", headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
    body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:String(prompt).slice(0,4000)}]}],generationConfig:{temperature:0.4,maxOutputTokens:500}})
  });
  if (!response.ok) throw new Error("Gemini request failed");
  const result = await response.json();
  return result.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim() || (language==="km"?"សូមសាកល្បងម្ដងទៀត។":"Please try again.");
}
async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message?.chat?.id || !message?.from?.id || typeof message.text !== "string") return;
  const chatId = message.chat.id, telegramId = String(message.from.id), input = message.text.trim();
  const languageRow = await env.DB.prepare("SELECT language FROM telegram_users WHERE telegram_id = ?").bind(telegramId).first();
  const language = languageRow?.language === "km" ? "km" : "en";
  const user = await getAuthorizedUser(env, telegramId);
  if (!user) { await sendMessage(env, chatId, "🔒 This account is not authorized to access Somi Store. Please ask the shop owner to add your Telegram account."); return; }
  if (input === "/start" || input === "/help") {
    await sendMessage(env, chatId, language === "km" ? "សួស្តី! 🌸 ខ្ញុំជា Somi Store Assistant។\n\n/summary — មើលសង្ខេបហាង\n/language — ប្ដូរភាសា\n/help — ជំនួយ" : "Welcome to Somi Store Assistant 🌸\n\nYour shared shop workspace is connected.\n\n/summary — View shop summary\n/language — Change language\n/help — Help");
    return;
  }
  if (input === "/language") {
    await sendMessage(env, chatId, "Choose your language / ជ្រើសរើសភាសា", {reply_markup:{inline_keyboard:[[{text:"English",callback_data:"lang_en"},{text:"ខ្មែរ",callback_data:"lang_km"}]]}});
    return;
  }
  if (input === "/summary") { await sendMessage(env, chatId, await shopSummary(env, language)); return; }
  if (input === "/cancel") {
    await env.DB.prepare("DELETE FROM bot_sessions WHERE telegram_id = ?").bind(telegramId).run();
    await sendMessage(env, chatId, language === "km" ? "បានបោះបង់សកម្មភាពបច្ចុប្បន្ន។" : "Current action cancelled."); return;
  }
  await sendMessage(env, chatId, await askGemini(env, input, language));
}
async function handleCallback(update, env) {
  const query = update.callback_query;
  if (!query?.from?.id || !query?.message?.chat?.id) return;
  const telegramId = String(query.from.id), user = await getAuthorizedUser(env, telegramId);
  if (!user) { await telegramCall(env,"answerCallbackQuery",{callback_query_id:query.id,text:"Not authorized"}); return; }
  const language = query.data === "lang_km" ? "km" : "en";
  await setLanguage(env, telegramId, language);
  await telegramCall(env,"answerCallbackQuery",{callback_query_id:query.id,text:"Language updated"});
  await sendMessage(env,query.message.chat.id,language==="km"?"បានប្ដូរភាសាទៅខ្មែរ។ 🌸":"Language changed to English. 🌸");
}
const connectPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Somi Store Telegram</title><style>body{font:16px system-ui;background:#fff7fb;color:#29202a;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;padding:28px;border-radius:18px;max-width:420px;width:calc(100% - 56px);box-shadow:0 8px 32px #5b17401a}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:10px;margin-top:12px;font:inherit}input{border:1px solid #ddd}button{border:0;background:#e94b91;color:white;font-weight:700;cursor:pointer}#result{white-space:pre-wrap;margin-top:16px}</style></head><body><main class="card"><h2>🌸 Connect KuuzBot</h2><p>Enter your existing TELEGRAM_WEBHOOK_SECRET from your Cloudflare Worker settings. It stays in this browser and is sent securely to your development Worker.</p><input id="secret" type="password" autocomplete="off" placeholder="Webhook secret"><button id="connect">Connect Telegram</button><div id="result" role="status"></div></main><script>document.getElementById('connect').addEventListener('click',async()=>{const secret=document.getElementById('secret').value;const result=document.getElementById('result');if(!secret){result.textContent='Please enter the webhook secret.';return;}result.textContent='Connecting…';try{const r=await fetch('/setup-webhook',{method:'POST',headers:{'X-Setup-Secret':secret}});const d=await r.json();result.textContent=d.ok?'✅ Telegram webhook connected! Open Telegram and send /start to @KuuzBot.':('❌ '+(d.error||'Connection failed'));if(d.ok)document.getElementById('secret').value='';}catch(e){result.textContent='Connection failed. Please try again.';}});</script></main></body></html>`;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ok:true,service:"somi-store-assistant",mode:"development"});
    if (url.pathname === "/api/workspace" && (request.method === "GET" || request.method === "PUT")) {
      const supplied = request.headers.get("x-somi-pin") || "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || supplied !== env.TELEGRAM_WEBHOOK_SECRET) return json({error:"Incorrect shared access PIN. Use the existing TELEGRAM_WEBHOOK_SECRET."},401);
      try {
        if (request.method === "GET") { const workspace = await readWorkspace(env); if (workspace.customerCount === 0 && workspace.orderCount === 0) return json({ data: null, updatedAt: 0, customerCount: 0, orderCount: 0 }); return json(workspace); }
        const body = await request.json();
        const result = await writeWorkspace(env, body?.data);
        return json({ok:true,updatedAt:result.updatedAt || Date.now(),customerCount:result.customerCount,orderCount:result.orderCount});
      } catch(error) { console.error("Workspace API error:",error?.message||"unknown"); return json({error:error?.message||"Workspace request failed"},400); }
    }
    if (url.pathname === "/connect-telegram" && request.method === "GET") return new Response(connectPage,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    if (url.pathname === "/setup-webhook" && request.method === "POST") {
      const suppliedSecret=request.headers.get("X-Setup-Secret");
      if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret!==env.TELEGRAM_WEBHOOK_SECRET) return json({ok:false,error:"Secret did not match. Check TELEGRAM_WEBHOOK_SECRET in Worker settings."},401);
      if (!env.TELEGRAM_BOT_TOKEN) return json({ok:false,error:"TELEGRAM_BOT_TOKEN is missing from Worker secrets."},500);
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) return json({ok:false,error:"Webhook secret must contain only letters, numbers, underscore or hyphen."},400);
      try {
        const webhookUrl=`${url.origin}/telegram/webhook`;
        const result=await telegramCall(env,"setWebhook",{url:webhookUrl,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message","callback_query"],drop_pending_updates:true});
        return json({ok:true,message:"Telegram webhook connected",webhook:webhookUrl,telegram_result:result.description||"Webhook was set"});
      } catch(error) { return json({ok:false,error:error.message||"Telegram could not register the webhook."},502); }
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.TELEGRAM_WEBHOOK_SECRET) return text("Unauthorized",401);
      let update; try { update=await request.json(); } catch { return text("Invalid JSON",400); }
      try { if(update.callback_query) await handleCallback(update,env); else await handleTelegramUpdate(update,env); }
      catch(error) { console.error("Telegram update failed:",error?.message||"unknown"); }
      return json({ok:true});
    }
    if (url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return text("Somi Store Assistant is running.");
  }
};