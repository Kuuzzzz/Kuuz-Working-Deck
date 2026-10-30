-- Somi Store shared workspace.
-- The Worker also creates this table lazily on first authenticated request.
CREATE TABLE IF NOT EXISTS somi_store_workspace (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
