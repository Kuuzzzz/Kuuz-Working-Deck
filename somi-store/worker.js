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
async function ensureInventoryTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS inventory_products (id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT, color TEXT, size TEXT, cost_price REAL NOT NULL DEFAULT 0, selling_price REAL NOT NULL DEFAULT 0, stock_qty INTEGER NOT NULL DEFAULT 0, low_stock_level INTEGER NOT NULL DEFAULT 3, image_url TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
}
async function readWorkspace(env) {
  await ensureInventoryTable(env);
  const [customers, orderRows, paymentRows, deliveryRows, products, revision] = await Promise.all([
    env.DB.prepare("SELECT id, name, phone, email, address, notes FROM customers ORDER BY created_at, id").all(),
    env.DB.prepare("SELECT id, customer_id, product, qty, unit_price, total, status, customer_status, owner_status, delivery_method, tracking_number, color, size, delivery_date, notes, created_at FROM orders ORDER BY created_at, id").all(),
    env.DB.prepare("SELECT order_id, COALESCE(SUM(amount), 0) AS amount FROM payments GROUP BY order_id").all(),
    env.DB.prepare("SELECT d.order_id, d.delivery_status, d.delivery_method, d.tracking_number, d.delivery_date, d.notes FROM deliveries d INNER JOIN (SELECT order_id, MAX(created_at) AS latest FROM deliveries GROUP BY order_id) x ON x.order_id=d.order_id AND x.latest=d.created_at").all(),
    env.DB.prepare("SELECT id,sku,name,category,color,size,cost_price,selling_price,stock_qty,low_stock_level,image_url,notes FROM inventory_products ORDER BY name,color,size").all(),
    env.DB.prepare("SELECT MAX(ts) AS changed FROM (SELECT updated_at AS ts FROM customers UNION ALL SELECT updated_at FROM orders UNION ALL SELECT created_at FROM payments UNION ALL SELECT updated_at FROM deliveries UNION ALL SELECT updated_at FROM inventory_products)").first()
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
    products: (products.results || []).map(p => ({id:p.id,sku:p.sku,name:p.name,category:p.category||"",color:p.color||"",size:p.size||"",costPrice:Number(p.cost_price||0),sellingPrice:Number(p.selling_price||0),stockQty:Number(p.stock_qty||0),lowStockLevel:Number(p.low_stock_level||3),imageUrl:p.image_url||"",notes:p.notes||""})),
    orders
  };
  return { data, updatedAt: Number.isFinite(changed) && changed > 0 ? changed : 0, customerCount:data.customers.length, orderCount:orders.length, productCount:data.products.length };
}
const ALLOWED_WEB_ORIGINS = new Set([
  "https://somi-store-preview.vercel.app",
  "https://somi-store.vercel.app",
  "https://kuuz-somi-store-dev.vengchhan2302.workers.dev"
]);
function apiJson(request, data, status = 200) {
  const origin = request.headers.get("Origin") || "";
  const headers = { ...JSON_HEADERS, "access-control-allow-methods": "GET, PUT, OPTIONS", "access-control-allow-headers": "content-type, x-somi-pin", "vary": "Origin" };
  if (ALLOWED_WEB_ORIGINS.has(origin)) headers["access-control-allow-origin"] = origin;
  return new Response(JSON.stringify(data), { status, headers });
}
async function writeWorkspace(env, data) {
  if (!data || !Array.isArray(data.customers) || !Array.isArray(data.orders)) throw new Error("Workspace must contain customers and orders arrays.");
  await ensureInventoryTable(env);
  const products = Array.isArray(data.products) ? data.products : [];
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
  for (const p of products) {
    if (!p?.id || !p?.sku || !p?.name) continue;
    statements.push(env.DB.prepare("INSERT INTO inventory_products (id,sku,name,category,color,size,cost_price,selling_price,stock_qty,low_stock_level,image_url,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sku=excluded.sku,name=excluded.name,category=excluded.category,color=excluded.color,size=excluded.size,cost_price=excluded.cost_price,selling_price=excluded.selling_price,stock_qty=excluded.stock_qty,low_stock_level=excluded.low_stock_level,image_url=excluded.image_url,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP").bind(String(p.id),String(p.sku),String(p.name),String(p.category||""),String(p.color||""),String(p.size||""),Math.max(0,safeNumber(p.costPrice)),Math.max(0,safeNumber(p.sellingPrice)),Math.max(0,Math.floor(safeNumber(p.stockQty))),Math.max(0,Math.floor(safeNumber(p.lowStockLevel,3))),String(p.imageUrl||""),String(p.notes||"")));
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
async function ensureWorkflowTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_workflows (telegram_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
}
async function getFlow(env,id) {
  await ensureWorkflowTable(env);
  const row=await env.DB.prepare("SELECT state,data_json FROM telegram_workflows WHERE telegram_id=?").bind(String(id)).first();
  if(!row)return null;let data={};try{data=JSON.parse(row.data_json||"{}")}catch{}return {state:row.state,data};
}
async function setFlow(env,id,chat,state,data={}) {
  await ensureWorkflowTable(env);
  await env.DB.prepare("INSERT INTO telegram_workflows (telegram_id,chat_id,state,data_json,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET chat_id=excluded.chat_id,state=excluded.state,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP").bind(String(id),String(chat),state,JSON.stringify(data)).run();
}
async function clearFlow(env,id) {
  await ensureWorkflowTable(env);await env.DB.prepare("DELETE FROM telegram_workflows WHERE telegram_id=?").bind(String(id)).run();
}
function homeKeyboard() {
  return {inline_keyboard:[
    [{text:"📦 Products & Stock",callback_data:"menu:products"}],
    [{text:"👥 Customers",callback_data:"menu:customers"},{text:"🛍 Orders",callback_data:"menu:orders"}],
    [{text:"💳 Payments",callback_data:"menu:payments"},{text:"🚚 Deliveries",callback_data:"menu:deliveries"}],
    [{text:"📊 Shop Summary",callback_data:"menu:summary"},{text:"🔎 Search",callback_data:"menu:search"}],
    [{text:"🌐 Language",callback_data:"menu:language"},{text:"❔ Help",callback_data:"menu:help"}]
  ]};
}
async function showHome(env,chat,lang) {
  const msg=lang==="km"?"🌸 សូមស្វាគមន៍មកកាន់ Somi Store Assistant! ជ្រើសរើសមុខងារខាងក្រោម៖":"🌸 Welcome to Somi Store Assistant! Choose a section:";
  return sendMessage(env,chat,msg,{reply_markup:homeKeyboard()});
}
async function promptFlow(env,chat,id,state,prompt,data={}) {
  await setFlow(env,id,chat,state,data);
  await sendMessage(env,chat,prompt,{reply_markup:{inline_keyboard:[[{text:"✖ Cancel",callback_data:"flow:cancel"},{text:"🏠 Main menu",callback_data:"menu:home"}]]}});
}
async function listCustomers(env,chat) {
  const r=await env.DB.prepare("SELECT name,phone FROM customers ORDER BY created_at DESC LIMIT 10").all();
  const rows=r.results||[];return sendMessage(env,chat,rows.length?"👥 Recent customers:\n"+rows.map((x,i)=>(i+1)+". "+x.name+(x.phone?" · "+x.phone:"")).join("\n"):"No customers yet.");
}
async function listOrders(env,chat) {
  const r=await env.DB.prepare("SELECT o.id,o.product,o.total,o.status,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 10").all();
  const rows=r.results||[];return sendMessage(env,chat,rows.length?"🛍 Recent orders:\n"+rows.map(x=>"• "+x.product+" · "+(x.customer_name||"Customer")+" · "+x.total+" · "+x.status).join("\n"):"No orders yet.");
}
async function beginPayment(env,chat) {
  const r=await env.DB.prepare("SELECT o.id,o.product,o.total,c.name AS customer_name,COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id=o.id),0) AS paid FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 15").all();
  const rows=(r.results||[]).filter(x=>Number(x.total)>Number(x.paid));
  if(!rows.length)return sendMessage(env,chat,"No orders with an outstanding balance.");
  const kb=rows.slice(0,10).map(x=>[{text:(x.customer_name||"Customer")+" · "+x.product+" · Due "+(Number(x.total)-Number(x.paid)),callback_data:"payorder:"+x.id}]);
  kb.push([{text:"🏠 Main menu",callback_data:"menu:home"}]);
  return sendMessage(env,chat,"💳 Choose an order to record a payment:",{reply_markup:{inline_keyboard:kb}});
}
async function beginDelivery(env,chat) {
  const r=await env.DB.prepare("SELECT o.id,o.product,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 12").all();
  const rows=r.results||[];if(!rows.length)return sendMessage(env,chat,"No orders to update.");
  const kb=rows.map(x=>[{text:(x.customer_name||"Customer")+" · "+x.product,callback_data:"delorder:"+x.id}]);kb.push([{text:"🏠 Main menu",callback_data:"menu:home"}]);
  return sendMessage(env,chat,"🚚 Choose an order:",{reply_markup:{inline_keyboard:kb}});
}
async function processFlowText(env,chat,id,input) {
  const f=await getFlow(env,id);if(!f)return false;const d=f.data||{};
  const ask=(state,prompt)=>promptFlow(env,chat,id,state,prompt,d);

  if(f.state==="product_name"){d.name=input;return ask("product_sku","🏷 Product SKU / code?");}
  if(f.state==="product_sku"){d.sku=input;return ask("product_category","🗂 Category? Send - to skip.");}
  if(f.state==="product_category"){d.category=input==="-"?"":input;return ask("product_color","🎨 Color? Send - if not applicable.");}
  if(f.state==="product_color"){d.color=input==="-"?"":input;return ask("product_size","📏 Size? Send - if not applicable.");}
  if(f.state==="product_size"){d.size=input==="-"?"":input;return ask("product_price","💵 Selling price?");}
  if(f.state==="product_price"){const n=Number(input);if(!Number.isFinite(n)||n<0){await sendMessage(env,chat,"Enter a valid price.");return true;}d.sellingPrice=n;return ask("product_cost","Cost price? Enter 0 if unknown.");}
  if(f.state==="product_cost"){const n=Number(input);if(!Number.isFinite(n)||n<0){await sendMessage(env,chat,"Enter a valid cost.");return true;}d.costPrice=n;return ask("product_stock","📦 Current stock quantity?");}
  if(f.state==="product_stock"){const n=Number(input);if(!Number.isInteger(n)||n<0){await sendMessage(env,chat,"Enter a whole number (0 or more).");return true;}d.stockQty=n;return ask("product_low","⚠️ Low-stock alert level?");}
  if(f.state==="product_low"){const n=Number(input);if(!Number.isInteger(n)||n<0){await sendMessage(env,chat,"Enter a whole number (0 or more).");return true;}d.lowStockLevel=n;await ensureInventoryTable(env);const idp="PRD-"+Date.now();try{await env.DB.prepare("INSERT INTO inventory_products (id,sku,name,category,color,size,cost_price,selling_price,stock_qty,low_stock_level) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(idp,d.sku,d.name,d.category,d.color,d.size,d.costPrice,d.sellingPrice,d.stockQty,d.lowStockLevel).run();}catch(e){await sendMessage(env,chat,"Could not save product. Check that the SKU is unique.");return true;}await clearFlow(env,id);await sendMessage(env,chat,"✅ Product variation added!\\n"+d.name+" · "+(d.color||"No color")+" · "+(d.size||"No size")+"\\nSKU: "+d.sku+"\\nStock: "+d.stockQty+"\\nSelling price: "+d.sellingPrice,{reply_markup:homeKeyboard()});return true;}
  if(f.state==="customer_name"){d.name=input;return ask("customer_phone","📱 Customer phone? Send - to skip.");}
  if(f.state==="customer_phone"){d.phone=input==="-"?"":input;return ask("customer_address","🏠 Customer address? Send - to skip.");}
  if(f.state==="customer_address"){d.address=input==="-"?"":input;return ask("customer_notes","📝 Notes? Send - to skip.");}
  if(f.state==="customer_notes"){
    const cid="CUS-"+Date.now();await env.DB.prepare("INSERT INTO customers (id,name,phone,email,address,notes) VALUES (?,?,?,'',?,?)").bind(cid,d.name,d.phone,d.address,input==="-"?"":input).run();await clearFlow(env,id);
    await sendMessage(env,chat,"✅ Customer added!\n"+d.name+"\n"+(d.phone||"No phone"),{reply_markup:homeKeyboard()});return true;
  }
  if(f.state==="order_customer"){
    const c=await env.DB.prepare("SELECT id,name FROM customers WHERE id=? OR LOWER(name)=LOWER(?) LIMIT 1").bind(input,input).first();
    if(!c){await sendMessage(env,chat,"Customer not found. Enter the exact customer name or ID, or add the customer first.");return true;}
    d.customerId=c.id;d.customerName=c.name;return ask("order_product","🛍 Product name?");
  }
  if(f.state==="order_product"){d.product=input;return ask("order_qty","🔢 Quantity?");}
  if(f.state==="order_qty"){const n=Number(input);if(!Number.isInteger(n)||n<1){await sendMessage(env,chat,"Enter a whole number above zero.");return true;}d.qty=n;return ask("order_price","💰 Unit price?");}
  if(f.state==="order_price"){const n=Number(input);if(!Number.isFinite(n)||n<0){await sendMessage(env,chat,"Enter a valid amount.");return true;}d.price=n;return ask("order_deposit","💳 Deposit received? Enter 0 if none.");}
  if(f.state==="order_deposit"){
    const dep=Number(input),total=d.qty*d.price;if(!Number.isFinite(dep)||dep<0||dep>total){await sendMessage(env,chat,"Enter a valid deposit between 0 and "+total+".");return true;}
    const oid="ORD-"+Date.now();await env.DB.prepare("INSERT INTO orders (id,customer_id,product,qty,unit_price,total,status,customer_status,owner_status) VALUES (?,?,?,?,?,?,?,?,?)").bind(oid,d.customerId,d.product,d.qty,d.price,total,"Ordered","Ordered","Not started").run();
    if(dep>0)await env.DB.prepare("INSERT INTO payments (id,order_id,amount,payment_method,payment_date,notes) VALUES (?,?,?,?,?,?)").bind("PAY-"+Date.now(),oid,dep,"Telegram",new Date().toISOString().slice(0,10),"Initial deposit").run();
    await clearFlow(env,id);await sendMessage(env,chat,"✅ Order created!\n"+oid+"\nCustomer: "+d.customerName+"\nProduct: "+d.product+"\nTotal: "+total+"\nPaid: "+dep+"\nRemaining: "+(total-dep),{reply_markup:homeKeyboard()});return true;
  }
  if(f.state==="payment_amount"){
    const n=Number(input);if(!Number.isFinite(n)||n<=0||n>d.remaining){await sendMessage(env,chat,"Enter an amount greater than 0 and no more than "+d.remaining+".");return true;}d.amount=n;return ask("payment_method","💳 Payment method? (Cash, ABA, ACLEDA...)");
  }
  if(f.state==="payment_method"){
    await env.DB.prepare("INSERT INTO payments (id,order_id,amount,payment_method,payment_date,notes) VALUES (?,?,?,?,?,?)").bind("PAY-"+Date.now(),d.orderId,d.amount,input,new Date().toISOString().slice(0,10),"Recorded via Telegram").run();
    await clearFlow(env,id);await sendMessage(env,chat,"✅ Payment recorded!\nReceived: "+d.amount+"\nRemaining: "+(d.remaining-d.amount),{reply_markup:homeKeyboard()});return true;
  }
  if(f.state==="delivery_tracking"){
    await env.DB.prepare("UPDATE orders SET tracking_number=?,status=?,customer_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(input==="-"?"":input,d.status,d.status,d.orderId).run();
    await env.DB.prepare("INSERT INTO deliveries (id,order_id,delivery_status,delivery_method,tracking_number,delivery_date,notes) VALUES (?,?,?,?,?,?,?)").bind("DEL-"+Date.now(),d.orderId,d.status,"",input==="-"?"":input,"","Updated in Telegram").run();
    await clearFlow(env,id);await sendMessage(env,chat,"✅ Delivery updated!\nStatus: "+d.status+"\nTracking: "+(input==="-"?"—":input),{reply_markup:homeKeyboard()});return true;
  }
  if(f.state==="search_query"){
    const t="%"+input+"%";const [c,o]=await Promise.all([env.DB.prepare("SELECT name,phone FROM customers WHERE name LIKE ? OR phone LIKE ? LIMIT 5").bind(t,t).all(),env.DB.prepare("SELECT o.product,o.total,o.status,c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.product LIKE ? OR o.id LIKE ? OR c.name LIKE ? LIMIT 5").bind(t,t,t).all()]);
    const lines=["🔎 Search results","Customers:",...(c.results||[]).map(x=>"• "+x.name+" "+(x.phone||"")),"Orders:",...(o.results||[]).map(x=>"• "+x.product+" · "+(x.customer_name||"")+" · "+x.total+" · "+x.status)];
    await clearFlow(env,id);await sendMessage(env,chat,lines.join("\n"),{reply_markup:homeKeyboard()});return true;
  }
  return false;
}
async function handleTelegramUpdate(update,env) {
  const m=update.message;if(!m?.chat?.id||!m?.from?.id||typeof m.text!=="string")return;
  const chat=m.chat.id,id=String(m.from.id),input=m.text.trim();
  const user=await getAuthorizedUser(env,id);if(!user){await sendMessage(env,chat,"🔒 This account is not authorized to access Somi Store.");return;}
  const lr=await env.DB.prepare("SELECT language FROM telegram_users WHERE telegram_id=?").bind(id).first();const lang=lr?.language==="km"?"km":"en";
  if(input==="/start"||input==="/menu"||input==="/help"){await clearFlow(env,id);await showHome(env,chat,lang);return;}
  if(input==="/cancel"){await clearFlow(env,id);await showHome(env,chat,lang);return;}
  if(input==="/summary"){await sendMessage(env,chat,await shopSummary(env,lang),{reply_markup:homeKeyboard()});return;}
  if(input==="/language"){await sendMessage(env,chat,"Choose your language / ជ្រើសរើសភាសា",{reply_markup:{inline_keyboard:[[{text:"English",callback_data:"lang_en"},{text:"ខ្មែរ",callback_data:"lang_km"}]]}});return;}
  if(await processFlowText(env,chat,id,input))return;
  await sendMessage(env,chat,await askGemini(env,input,lang),{reply_markup:homeKeyboard()});
}
async function handleCallback(update,env) {
  const q=update.callback_query;if(!q?.from?.id||!q?.message?.chat?.id)return;
  const id=String(q.from.id),chat=q.message.chat.id,user=await getAuthorizedUser(env,id);if(!user){await telegramCall(env,"answerCallbackQuery",{callback_query_id:q.id,text:"Not authorized"});return;}
  await telegramCall(env,"answerCallbackQuery",{callback_query_id:q.id});
  const data=q.data||"",lr=await env.DB.prepare("SELECT language FROM telegram_users WHERE telegram_id=?").bind(id).first(),lang=lr?.language==="km"?"km":"en";
  if(data==="lang_en"||data==="lang_km"){await setLanguage(env,id,data==="lang_km"?"km":"en");await showHome(env,chat,data==="lang_km"?"km":"en");return;}
  if(data==="flow:cancel"||data==="menu:home"){await clearFlow(env,id);await showHome(env,chat,lang);return;}
  if(data==="menu:language"){await sendMessage(env,chat,"Choose your language / ជ្រើសរើសភាសា",{reply_markup:{inline_keyboard:[[{text:"English",callback_data:"lang_en"},{text:"ខ្មែរ",callback_data:"lang_km"}]]}});return;}
  if(data==="menu:help"){await sendMessage(env,chat,"🌸 Use the buttons to manage customers, orders, payments and deliveries. Send /cancel to stop any guided action.",{reply_markup:homeKeyboard()});return;}
  if(data==="menu:summary"){await sendMessage(env,chat,await shopSummary(env,lang),{reply_markup:homeKeyboard()});return;}

  if(data==="menu:products"){await ensureInventoryTable(env);const r=await env.DB.prepare("SELECT COUNT(*) AS variants,COALESCE(SUM(stock_qty),0) AS units,SUM(CASE WHEN stock_qty<=low_stock_level AND stock_qty>0 THEN 1 ELSE 0 END) AS low,SUM(CASE WHEN stock_qty=0 THEN 1 ELSE 0 END) AS out FROM inventory_products").first();await sendMessage(env,chat,"📦 Product & Stock\\nVariants: "+(r?.variants||0)+"\\nUnits in stock: "+(r?.units||0)+"\\nLow stock: "+(r?.low||0)+"\\nOut of stock: "+(r?.out||0),{reply_markup:{inline_keyboard:[[{text:"➕ Add product variation",callback_data:"product:add"}],[{text:"📋 View products",callback_data:"product:list"},{text:"⚠️ Low stock",callback_data:"product:low"}],[{text:"🏠 Main menu",callback_data:"menu:home"}]]}});return;}
  if(data==="product:add"){await promptFlow(env,chat,id,"product_name","👚 Product name?");return;}
  if(data==="product:list"||data==="product:low"){await ensureInventoryTable(env);const sql=data==="product:low"?"SELECT * FROM inventory_products WHERE stock_qty<=low_stock_level ORDER BY stock_qty,name LIMIT 20":"SELECT * FROM inventory_products ORDER BY name,color,size LIMIT 20";const r=await env.DB.prepare(sql).all();const rows=r.results||[];await sendMessage(env,chat,rows.length?"📦 Product variations\\n"+rows.map(p=>"• "+p.name+" · "+(p.color||"—")+" / "+(p.size||"—")+"\\n  SKU "+p.sku+" · Stock "+p.stock_qty+" · Price "+p.selling_price).join("\\n"):"No products recorded yet.",{reply_markup:{inline_keyboard:[[{text:"➕ Add product variation",callback_data:"product:add"}],[{text:"↩ Products menu",callback_data:"menu:products"}]]}});return;}
  if(data==="menu:customers"){await sendMessage(env,chat,"👥 Customers",{reply_markup:{inline_keyboard:[[{text:"➕ Add customer",callback_data:"customer:add"},{text:"📋 View customers",callback_data:"customer:list"}],[{text:"🏠 Main menu",callback_data:"menu:home"}]]}});return;}
  if(data==="customer:add"){await promptFlow(env,chat,id,"customer_name","👤 Customer name?");return;}
  if(data==="customer:list"){await listCustomers(env,chat);return;}
  if(data==="menu:orders"){await sendMessage(env,chat,"🛍 Orders",{reply_markup:{inline_keyboard:[[{text:"➕ Create order",callback_data:"order:add"},{text:"📋 View orders",callback_data:"order:list"}],[{text:"🏠 Main menu",callback_data:"menu:home"}]]}});return;}
  if(data==="order:add"){const n=await env.DB.prepare("SELECT COUNT(*) AS n FROM customers").first();if(!Number(n?.n)){await sendMessage(env,chat,"Add a customer first.",{reply_markup:{inline_keyboard:[[{text:"➕ Add customer",callback_data:"customer:add"}]]}});return;}await promptFlow(env,chat,id,"order_customer","👤 Enter exact customer name or ID.");return;}
  if(data==="order:list"){await listOrders(env,chat);return;}
  if(data==="menu:payments"){await beginPayment(env,chat);return;}
  if(data==="menu:deliveries"){await beginDelivery(env,chat);return;}
  if(data==="menu:search"){await promptFlow(env,chat,id,"search_query","🔎 Enter customer name, phone, product or order ID.");return;}
  if(data.startsWith("payorder:")){
    const oid=data.slice(9),o=await env.DB.prepare("SELECT id,total,COALESCE((SELECT SUM(amount) FROM payments WHERE order_id=orders.id),0) AS paid FROM orders WHERE id=?").bind(oid).first();
    if(!o)return sendMessage(env,chat,"Order not found.");const due=Number(o.total)-Number(o.paid);if(due<=0)return sendMessage(env,chat,"This order is fully paid.");
    await promptFlow(env,chat,id,"payment_amount","Order "+oid+"\nRemaining: "+due+"\n\nPayment amount?",{orderId:oid,remaining:due});return;
  }
  if(data.startsWith("delorder:")){
    const oid=data.slice(9);await setFlow(env,id,chat,"delivery_status",{orderId:oid});
    await sendMessage(env,chat,"Choose delivery status:",{reply_markup:{inline_keyboard:[[{text:"Preparing",callback_data:"delstatus:Preparing"},{text:"Ready",callback_data:"delstatus:Ready"}],[{text:"Shipped",callback_data:"delstatus:Shipped"},{text:"Delivered",callback_data:"delstatus:Delivered"}],[{text:"Cancelled",callback_data:"delstatus:Cancelled"}]]}});return;
  }
  if(data.startsWith("delstatus:")){
    const f=await getFlow(env,id);if(!f?.data?.orderId)return;await promptFlow(env,chat,id,"delivery_tracking","📦 Enter tracking number (or - to skip).",{orderId:f.data.orderId,status:data.slice(10)});return;
  }
}
const connectPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Somi Store Telegram</title><style>body{font:16px system-ui;background:#fff7fb;color:#29202a;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;padding:28px;border-radius:18px;max-width:420px;width:calc(100% - 56px);box-shadow:0 8px 32px #5b17401a}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:10px;margin-top:12px;font:inherit}input{border:1px solid #ddd}button{border:0;background:#e94b91;color:white;font-weight:700;cursor:pointer}#result{white-space:pre-wrap;margin-top:16px}</style></head><body><main class="card"><h2>🌸 Connect KuuzBot</h2><p>Enter your existing TELEGRAM_WEBHOOK_SECRET from your Cloudflare Worker settings. It stays in this browser and is sent securely to your development Worker.</p><input id="secret" type="password" autocomplete="off" placeholder="Webhook secret"><button id="connect">Connect Telegram</button><div id="result" role="status"></div></main><script>document.getElementById('connect').addEventListener('click',async()=>{const secret=document.getElementById('secret').value;const result=document.getElementById('result');if(!secret){result.textContent='Please enter the webhook secret.';return;}result.textContent='Connecting…';try{const r=await fetch('/setup-webhook',{method:'POST',headers:{'X-Setup-Secret':secret}});const d=await r.json();result.textContent=d.ok?'✅ Telegram webhook connected! Open Telegram and send /start to @KuuzBot.':('❌ '+(d.error||'Connection failed'));if(d.ok)document.getElementById('secret').value='';}catch(e){result.textContent='Connection failed. Please try again.';}});</script></main></body></html>`;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ok:true,service:"somi-store-assistant",mode:"development"});
    if (url.pathname === "/api/workspace" && request.method === "OPTIONS") return apiJson(request, { ok: true });
    if (url.pathname === "/api/workspace" && (request.method === "GET" || request.method === "PUT")) {
      const supplied = request.headers.get("x-somi-pin") || "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || supplied !== env.TELEGRAM_WEBHOOK_SECRET) return apiJson(request, {error:"Incorrect shared access PIN. Use the existing TELEGRAM_WEBHOOK_SECRET."},401);
      try {
        if (request.method === "GET") { const workspace = await readWorkspace(env); if (workspace.customerCount === 0 && workspace.orderCount === 0 && workspace.productCount === 0) return apiJson(request, { data: null, updatedAt: 0, customerCount: 0, orderCount: 0, productCount: 0 }); return apiJson(request, workspace); }
        const body = await request.json();
        const result = await writeWorkspace(env, body?.data);
        return apiJson(request, {ok:true,updatedAt:result.updatedAt || Date.now(),customerCount:result.customerCount,orderCount:result.orderCount});
      } catch(error) { console.error("Workspace API error:",error?.message||"unknown"); return apiJson(request, {error:error?.message||"Workspace request failed"},400); }
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