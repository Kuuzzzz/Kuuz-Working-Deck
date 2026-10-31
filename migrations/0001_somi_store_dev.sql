-- Somi Store shared database foundation.
-- Apply only to a NEW development D1 database; never run against production without review.
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer_id TEXT, product TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  customer_status TEXT NOT NULL DEFAULT 'Order received', owner_status TEXT NOT NULL DEFAULT 'Not started',
  delivery_method TEXT, tracking_number TEXT, order_date TEXT, delivery_date TEXT, color TEXT, size TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, amount REAL NOT NULL CHECK (amount > 0),
  method TEXT, reference TEXT, paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, notes TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id TEXT PRIMARY KEY, display_name TEXT, language TEXT NOT NULL DEFAULT 'en',
  role TEXT NOT NULL CHECK (role IN ('owner','staff')), is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS bot_sessions (
  telegram_user_id TEXT PRIMARY KEY, state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_telegram_id TEXT, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, details_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_logs(created_at);
