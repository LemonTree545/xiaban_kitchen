import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors());

// ==================== AUTH ====================
app.post('/api/auth', async (c) => {
  const { password } = await c.req.json();
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key='password'").first();
  return c.json({ ok: row && row.value === password });
});

// ==================== SETTINGS ====================
app.get('/api/settings', async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all();
  const s = {};
  rows.results.forEach(r => s[r.key] = r.value);
  return c.json(s);
});

app.put('/api/settings/password', async (c) => {
  const { password } = await c.req.json();
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('password', ?) ON CONFLICT(key) DO UPDATE SET value=?").bind(password, password).run();
  return c.json({ ok: true });
});

// ==================== CUISINES ====================
app.get('/api/cuisines', async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM cuisines ORDER BY id").all();
  return c.json(rows.results.map(r => r.name));
});

app.post('/api/cuisines', async (c) => {
  const { name } = await c.req.json();
  await c.env.DB.prepare("INSERT OR IGNORE INTO cuisines (name) VALUES (?)").bind(name).run();
  return c.json({ ok: true });
});

app.put('/api/cuisines/:id', async (c) => {
  const id = c.req.param('id');
  const { name } = await c.req.json();
  await c.env.DB.prepare("UPDATE cuisines SET name=? WHERE id=?").bind(name, id).run();
  return c.json({ ok: true });
});

app.delete('/api/cuisines/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("DELETE FROM cuisines WHERE id=?").bind(id).run();
  return c.json({ ok: true });
});

// ==================== DISHES ====================
app.get('/api/dishes', async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM dishes ORDER BY id").all();
  const dishes = rows.results.map(formatDish);
  return c.json(dishes);
});

app.post('/api/dishes', async (c) => {
  const d = await c.req.json();
  const id = d.id || ('d' + Date.now().toString(36));
  await c.env.DB.prepare(`INSERT OR REPLACE INTO dishes (id, name, cuisine, category, description, price, image, tags, portions, ingredients, weekly, tutorial_difficulty, tutorial_time, tutorial_steps, tutorial_tips, tutorial_pairing)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, d.name, d.cuisine||'家常菜', d.category||'荤菜', d.description||'', d.price||15, d.image||'',
      JSON.stringify(d.tags||[]), JSON.stringify(d.portions||{}), JSON.stringify(d.ingredients||[]),
      d.weekly?1:0, d.tutorial_difficulty||'简单', d.tutorial_time||'10分钟', JSON.stringify(d.tutorial_steps||[]), d.tutorial_tips||'', d.tutorial_pairing||'').run();
  return c.json({ ok: true, id });
});

app.put('/api/dishes/:id', async (c) => {
  const id = c.req.param('id');
  const d = await c.req.json();
  await c.env.DB.prepare(`UPDATE dishes SET name=?, cuisine=?, category=?, description=?, price=?, image=?, tags=?, portions=?, ingredients=?, weekly=?, tutorial_difficulty=?, tutorial_time=?, tutorial_steps=?, tutorial_tips=?, tutorial_pairing=? WHERE id=?`)
    .bind(d.name, d.cuisine||'家常菜', d.category||'荤菜', d.description||'', d.price||15, d.image||'',
      JSON.stringify(d.tags||[]), JSON.stringify(d.portions||{}), JSON.stringify(d.ingredients||[]),
      d.weekly?1:0, d.tutorial_difficulty||'简单', d.tutorial_time||'10分钟', JSON.stringify(d.tutorial_steps||[]), d.tutorial_tips||'', d.tutorial_pairing||'', id).run();
  return c.json({ ok: true });
});

app.delete('/api/dishes/:id', async (c) => {
  await c.env.DB.prepare("DELETE FROM dishes WHERE id=?").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

function formatOrder(r) {
  return {
    id: r.id, pkg: r.package_type,
    pkgName: r.package_type==='a'?'单餐快送':r.package_type==='b'?'囤菜套餐':'周餐计划',
    pkgFee: r.package_fee, customer: r.customer_name, wxName: r.wx_name,
    address: r.address, deliveryTime: r.delivery_time,
    room: r.address, date: r.delivery_time,
    items: JSON.parse(r.items_json||'[]'), vegItems: JSON.parse(r.veg_items_json||'[]'),
    dishPrice: r.dish_price, vegPrice: r.veg_price,
    total: r.total, note: r.note, status: r.status,
    time: r.created_at, ts: new Date(r.created_at).getTime()
  };
}

function formatDish(r) {
  return {
    id: r.id, name: r.name, cuisine: r.cuisine, cat: r.category, desc: r.description, price: r.price,
    image: r.image, tags: JSON.parse(r.tags||'[]'), portions: JSON.parse(r.portions||'{}'),
    ingredients: JSON.parse(r.ingredients||'[]'), weekly: r.weekly===1,
    tutorial: r.tutorial_steps ? {
      difficulty: r.tutorial_difficulty, time: r.tutorial_time,
      steps: JSON.parse(r.tutorial_steps||'[]'), tips: r.tutorial_tips, pairing: r.tutorial_pairing
    } : null
  };
}

// ==================== VEGGIES ====================
app.get('/api/veggies', async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM veggies ORDER BY id").all();
  const veggies = rows.results.map(r => ({
    id: r.id, name: r.name, cat: r.category, desc: r.description,
    pricePerGram: r.price_per_gram, presets: JSON.parse(r.presets||'[100,200,300]'),
    image: r.image, weekly: r.weekly===1
  }));
  return c.json(veggies);
});

app.post('/api/veggies', async (c) => {
  const v = await c.req.json();
  const id = v.id || ('v' + Date.now().toString(36));
  await c.env.DB.prepare(`INSERT OR REPLACE INTO veggies (id, name, category, description, price_per_gram, presets, image, weekly) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(id, v.name, v.cat||'根茎类', v.desc||'', v.pricePerGram||0.01, JSON.stringify(v.presets||[100,200,300]), v.image||'', v.weekly?1:0).run();
  return c.json({ ok: true, id });
});

app.put('/api/veggies/:id', async (c) => {
  const id = c.req.param('id'); const v = await c.req.json();
  await c.env.DB.prepare(`UPDATE veggies SET name=?, category=?, description=?, price_per_gram=?, presets=?, image=?, weekly=? WHERE id=?`)
    .bind(v.name, v.cat||'根茎类', v.desc||'', v.pricePerGram||0.01, JSON.stringify(v.presets||[100,200,300]), v.image||'', v.weekly?1:0, id).run();
  return c.json({ ok: true });
});

app.delete('/api/veggies/:id', async (c) => {
  await c.env.DB.prepare("DELETE FROM veggies WHERE id=?").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ==================== COMMUNITIES ====================
app.get('/api/communities', async (c) => {
  const row = await c.env.DB.prepare("SELECT data_json FROM communities ORDER BY id LIMIT 1").first();
  return c.json(row ? JSON.parse(row.data_json) : []);
});

app.put('/api/communities', async (c) => {
  const data = await c.req.json();
  await c.env.DB.prepare("DELETE FROM communities").run();
  await c.env.DB.prepare("INSERT INTO communities (data_json) VALUES (?)").bind(JSON.stringify(data)).run();
  return c.json({ ok: true });
});

// ==================== ORDERS ====================
app.get('/api/orders', async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
  const orders = rows.results.map(r => ({
    id: r.id, pkg: r.package_type,
    pkgName: r.package_type==='a'?'单餐快送':r.package_type==='b'?'囤菜套餐':'周餐计划',
    pkgFee: r.package_fee, customer: r.customer_name, wxName: r.wx_name,
    address: r.address, deliveryTime: r.delivery_time,
    date: r.delivery_time, room: r.address,
    items: JSON.parse(r.items_json||'[]'), vegItems: JSON.parse(r.veg_items_json||'[]'),
    dishPrice: r.dish_price, vegPrice: r.veg_price,
    total: r.total, note: r.note, status: r.status,
    time: r.created_at, ts: new Date(r.created_at).getTime()
  }));
  return c.json(orders);
});

app.post('/api/orders', async (c) => {
  const o = await c.req.json();
  const id = o.id || ('ORD' + Date.now().toString(36).toUpperCase());
  await c.env.DB.prepare(`INSERT OR REPLACE INTO orders (id, customer_name, wx_name, address, delivery_time, package_type, items_json, veg_items_json, dish_price, veg_price, package_fee, total, note, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, o.customer||'', o.wxName||'', o.address||'', o.deliveryTime||'', o.pkg||'a',
      JSON.stringify(o.items||[]), JSON.stringify(o.vegItems||[]),
      o.dishPrice||0, o.vegPrice||0, o.pkgFee||0, o.total||0, o.note||'', o.status||'confirmed').run();
  return c.json({ ok: true, id });
});

app.put('/api/orders/:id', async (c) => {
  const id = c.req.param('id'); const { status } = await c.req.json();
  await c.env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status, id).run();
  return c.json({ ok: true });
});

app.delete('/api/orders/:id', async (c) => {
  await c.env.DB.prepare("DELETE FROM orders WHERE id=?").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

// ==================== BATCH SYNC ====================
app.get('/api/data', async (c) => {
  const [cuisines, dishes, veggies, settings, communities, orders, customers] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM cuisines ORDER BY id").all(),
    c.env.DB.prepare("SELECT * FROM dishes ORDER BY id").all(),
    c.env.DB.prepare("SELECT * FROM veggies ORDER BY id").all(),
    c.env.DB.prepare("SELECT key, value FROM settings").all(),
    c.env.DB.prepare("SELECT data_json FROM communities ORDER BY id LIMIT 1").first(),
    c.env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all(),
    c.env.DB.prepare("SELECT * FROM customers ORDER BY created_at DESC").all(),
  ]);
  const s = {}; settings.results.forEach(r => s[r.key] = r.value);
  return c.json({
    cuisines: cuisines.results.map(r => r.name),
    dishes: dishes.results.map(formatDish),
    veggies: veggies.results.map(r => ({
      id: r.id, name: r.name, cat: r.category, desc: r.description,
      pricePerGram: r.price_per_gram, presets: JSON.parse(r.presets||'[100,200,300]'),
      image: r.image, weekly: r.weekly===1
    })),
    communities: communities ? JSON.parse(communities.data_json) : [],
    orders: orders.results.map(formatOrder),
    customers: customers.results,
    settings: s,
  });
});

app.post('/api/data', async (c) => {
  const data = await c.req.json();
  // Sync communities
  if (data.communities) {
    await c.env.DB.prepare("DELETE FROM communities").run();
    await c.env.DB.prepare("INSERT INTO communities (data_json) VALUES (?)").bind(JSON.stringify(data.communities)).run();
  }
  // Sync dishes
  if (data.dishes) {
    await c.env.DB.prepare("DELETE FROM dishes").run();
    for (const d of data.dishes) {
      await c.env.DB.prepare("INSERT OR REPLACE INTO dishes (id, name, cuisine, category, description, price, image, tags, portions, ingredients, weekly) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(d.id, d.name, d.cuisine||'家常菜', d.cat||'荤菜', d.desc||'', d.price||15, d.image||'', JSON.stringify(d.tags||[]), JSON.stringify(d.portions||{}), JSON.stringify(d.ingredients||[]), d.weekly?1:0).run();
    }
  }
  // Sync veggies
  if (data.veggies) {
    await c.env.DB.prepare("DELETE FROM veggies").run();
    for (const v of data.veggies) {
      await c.env.DB.prepare("INSERT OR REPLACE INTO veggies (id, name, category, description, price_per_gram, presets, image, weekly) VALUES (?,?,?,?,?,?,?,?)")
        .bind(v.id, v.name, v.cat||'根茎类', v.desc||'', v.pricePerGram||0.01, JSON.stringify(v.presets||[100,200,300]), v.image||'', v.weekly?1:0).run();
    }
  }
  // Sync orders
  if (data.orders) {
    await c.env.DB.prepare("DELETE FROM orders").run();
    for (const o of data.orders) {
      await c.env.DB.prepare("INSERT OR REPLACE INTO orders (id, customer_name, wx_name, address, delivery_time, package_type, items_json, veg_items_json, dish_price, veg_price, package_fee, total, note, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(o.id, o.customer||'无', o.wxName||'', o.address||o.room||'', o.deliveryTime||o.date||'', o.pkg||'a', JSON.stringify(o.items||[]), JSON.stringify(o.vegItems||[]), o.dishPrice||0, o.vegPrice||0, o.pkgFee||0, o.total||0, o.note||'', o.status||'confirmed', o.time||o.created_at||'').run();
    }
  }
  // Sync customers
  if (data.customers) {
    await c.env.DB.prepare("DELETE FROM customers").run();
    for (const cust of data.customers) {
      await c.env.DB.prepare("INSERT OR REPLACE INTO customers (id, name, wx_name, address, first_order_time, order_count, preferences, notes) VALUES (?,?,?,?,?,?,?,?)")
        .bind(cust.id, cust.name, cust.wxName||'', cust.address||cust.room||'', cust.firstOrder||'', cust.orderCount||0, cust.preferences||'', cust.notes||'').run();
    }
  }
  // Sync cuisines
  if (data.cuisines) {
    await c.env.DB.prepare("DELETE FROM cuisines").run();
    for (const name of data.cuisines) {
      await c.env.DB.prepare("INSERT INTO cuisines (name) VALUES (?)").bind(name).run();
    }
  }
  // Sync settings
  if (data.settings) {
    for (const [key, value] of Object.entries(data.settings)) {
      await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?").bind(key, String(value), String(value)).run();
    }
  }
  return c.json({ ok: true });
});

// ==================== CUSTOMERS ====================
app.get('/api/customers', async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM customers ORDER BY created_at DESC").all();
  return c.json(rows.results);
});

app.post('/api/customers', async (c) => {
  const cust = await c.req.json();
  const id = cust.id || ('C' + Date.now().toString(36));
  // Upsert: if customer with same name+address exists, update
  const existing = await c.env.DB.prepare("SELECT id FROM customers WHERE name=? AND address=?").bind(cust.name, cust.address||'').first();
  if (existing) {
    await c.env.DB.prepare("UPDATE customers SET wx_name=?, order_count=order_count+1 WHERE id=?")
      .bind(cust.wxName||'', existing.id).run();
    return c.json({ ok: true, id: existing.id });
  }
  await c.env.DB.prepare("INSERT INTO customers (id, name, wx_name, address, first_order_time, order_count) VALUES (?,?,?,?,datetime('now'),1)")
    .bind(id, cust.name, cust.wxName||'', cust.address||'').run();
  return c.json({ ok: true, id });
});

export default app;
