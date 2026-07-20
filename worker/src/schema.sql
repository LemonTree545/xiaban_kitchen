-- 菜系
CREATE TABLE IF NOT EXISTS cuisines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 菜品
CREATE TABLE IF NOT EXISTS dishes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cuisine TEXT DEFAULT '家常菜',
  category TEXT DEFAULT '荤菜',
  description TEXT DEFAULT '',
  price INTEGER DEFAULT 15,
  image TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  portions TEXT DEFAULT '{}',
  ingredients TEXT DEFAULT '[]',
  weekly INTEGER DEFAULT 1,
  tutorial_difficulty TEXT DEFAULT '简单',
  tutorial_time TEXT DEFAULT '10分钟',
  tutorial_steps TEXT DEFAULT '[]',
  tutorial_tips TEXT DEFAULT '',
  tutorial_pairing TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 净菜
CREATE TABLE IF NOT EXISTS veggies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT '根茎类',
  description TEXT DEFAULT '',
  price_per_gram REAL DEFAULT 0.01,
  presets TEXT DEFAULT '[100,200,300]',
  image TEXT DEFAULT '',
  weekly INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 小区/楼幢/单元
CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 订单
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  wx_name TEXT DEFAULT '',
  address TEXT NOT NULL,
  delivery_time TEXT NOT NULL,
  package_type TEXT DEFAULT 'a',
  items_json TEXT DEFAULT '[]',
  veg_items_json TEXT DEFAULT '[]',
  dish_price REAL DEFAULT 0,
  veg_price REAL DEFAULT 0,
  package_fee REAL DEFAULT 0,
  total REAL DEFAULT 0,
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending_payment',
  paid INTEGER DEFAULT 0,
  needs_review INTEGER DEFAULT 0,
  idempotency_key TEXT NOT NULL DEFAULT '',
  lookup_token_hash TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  payment_submitted_at TEXT,
  paid_confirmed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
  ON orders(idempotency_key) WHERE idempotency_key <> '';
CREATE INDEX IF NOT EXISTS idx_orders_status_expires_at
  ON orders(status, expires_at);

-- 客户
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  wx_name TEXT DEFAULT '',
  address TEXT DEFAULT '',
  preferences TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  first_order_time TEXT DEFAULT '',
  order_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 系统设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 初始化默认数据
INSERT OR IGNORE INTO settings (key, value) VALUES ('weekly_dishes', '[]');
INSERT OR IGNORE INTO settings (key, value) VALUES ('weekly_veggies', '[]');

-- 默认菜系
INSERT OR IGNORE INTO cuisines (name) VALUES ('川菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('湘菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('粤菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('鲁菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('苏菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('浙菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('闽菜');
INSERT OR IGNORE INTO cuisines (name) VALUES ('家常菜');

-- 默认小区数据
INSERT OR IGNORE INTO communities (id, data_json) VALUES (1, '[{"id":"xuyang","name":"徐阳花园小区","buildings":[{"id":"xy_b1","name":"1幢","units":[{"id":"xy_b1_u1","name":"1单元","rooms":["101","102","201","202","301","302"]}]}]},{"id":"zhongjing1","name":"众泾水岸花园一期","buildings":[{"id":"zj1_b1","name":"1幢","units":[{"id":"zj1_b1_u1","name":"1单元","rooms":["101","102","201","202"]}]}]},{"id":"zhongjing2","name":"众泾水岸花园二期","buildings":[{"id":"zj2_b1","name":"1幢","units":[{"id":"zj2_b1_u1","name":"1单元","rooms":["101","102","201","202"]}]}]}]');
