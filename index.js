// 下班厨房 API Worker — 零依赖纯 JS
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // AUTH
      if (path === '/api/auth' && method === 'POST') {
        const { password } = await request.json();
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key='password'").first();
        return json({ ok: row && row.value === password });
      }

      // DATA — full state sync
      if (path === '/api/data' && method === 'GET') {
        const [cuisines, dishes, veggies, settings, communities, orders, customers] = await Promise.all([
          env.DB.prepare("SELECT * FROM cuisines ORDER BY id").all(),
          env.DB.prepare("SELECT * FROM dishes ORDER BY id").all(),
          env.DB.prepare("SELECT * FROM veggies ORDER BY id").all(),
          env.DB.prepare("SELECT key, value FROM settings").all(),
          env.DB.prepare("SELECT data_json FROM communities ORDER BY id LIMIT 1").first(),
          env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all(),
          env.DB.prepare("SELECT * FROM customers ORDER BY created_at DESC").all(),
        ]);
        const s = {}; settings.results.forEach(function(r){ s[r.key] = r.value; });
        return json({
          cuisines: cuisines.results.map(function(r){ return r.name; }),
          dishes: dishes.results.map(fmtDish),
          veggies: veggies.results.map(fmtVeg),
          communities: communities ? JSON.parse(communities.data_json) : [],
          orders: orders.results.map(fmtOrder),
          customers: customers.results,
          settings: s,
        });
      }

      if (path === '/api/data' && method === 'POST') {
        const data = await request.json();
        if (data.communities) { await env.DB.prepare("DELETE FROM communities").run(); await env.DB.prepare("INSERT INTO communities (data_json) VALUES (?)").bind(JSON.stringify(data.communities)).run(); }
        if (data.dishes) { await env.DB.prepare("DELETE FROM dishes").run(); for (var i=0; i<data.dishes.length; i++) { var d=data.dishes[i]; await env.DB.prepare("INSERT OR REPLACE INTO dishes (id, name, cuisine, category, description, price, image, tags, portions, ingredients, weekly) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(d.id, d.name, d.cuisine||'家常菜', d.cat||'荤菜', d.desc||'', d.price||15, d.image||'', JSON.stringify(d.tags||[]), JSON.stringify(d.portions||{}), JSON.stringify(d.ingredients||[]), d.weekly?1:0).run(); } }
        if (data.veggies) { await env.DB.prepare("DELETE FROM veggies").run(); for (var i2=0; i2<data.veggies.length; i2++) { var v=data.veggies[i2]; await env.DB.prepare("INSERT OR REPLACE INTO veggies (id, name, category, description, price_per_gram, presets, image, weekly) VALUES (?,?,?,?,?,?,?,?)").bind(v.id, v.name, v.cat||'根茎类', v.desc||'', v.pricePerGram||0.01, JSON.stringify(v.presets||[100,200,300]), v.image||'', v.weekly?1:0).run(); } }
        if (data.orders) { await env.DB.prepare("DELETE FROM orders").run(); for (var i3=0; i3<data.orders.length; i3++) { var o=data.orders[i3]; await env.DB.prepare("INSERT OR REPLACE INTO orders (id, customer_name, wx_name, address, delivery_time, package_type, items_json, veg_items_json, dish_price, veg_price, package_fee, total, note, status, paid, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(o.id, o.customer||'', o.wxName||'', o.address||o.room||'', o.deliveryTime||o.date||'', o.pkg||'a', JSON.stringify(o.items||[]), JSON.stringify(o.vegItems||[]), o.dishPrice||0, o.vegPrice||0, o.pkgFee||0, o.total||0, o.note||'', o.status||'confirmed', o.time||'', o.paid?1:0).run(); } }
        if (data.customers) { await env.DB.prepare("DELETE FROM customers").run(); for (var i4=0; i4<data.customers.length; i4++) { var c=data.customers[i4]; await env.DB.prepare("INSERT OR REPLACE INTO customers (id, name, wx_name, address, first_order_time, order_count, preferences, notes) VALUES (?,?,?,?,?,?,?,?)").bind(c.id, c.name, c.wxName||'', c.address||c.room||'', c.firstOrder||'', c.orderCount||0, c.preferences||'', c.notes||'').run(); } }
        if (data.cuisines) { await env.DB.prepare("DELETE FROM cuisines").run(); for (var i5=0; i5<data.cuisines.length; i5++) { await env.DB.prepare("INSERT INTO cuisines (name) VALUES (?)").bind(data.cuisines[i5]).run(); } }
        if (data.settings) { var keys=Object.keys(data.settings); for (var i6=0; i6<keys.length; i6++) { var k=keys[i6], val=String(data.settings[k]); await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?").bind(k, val, val).run(); } }
        return json({ ok: true });
      }

      // ORDERS — individual CRUD
      if (path === '/api/orders' && method === 'GET') {
        var rows = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
        return json(rows.results.map(fmtOrder));
      }
      if (path === '/api/orders' && method === 'POST') {
        var o = await request.json();
        var oid = o.id || ('ORD' + Date.now().toString(36).toUpperCase());
        await env.DB.prepare("INSERT OR REPLACE INTO orders (id, customer_name, wx_name, address, delivery_time, package_type, items_json, veg_items_json, dish_price, veg_price, package_fee, total, note, status, paid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(oid, o.customer||'', o.wxName||'', o.address||'', o.deliveryTime||'', o.pkg||'a', JSON.stringify(o.items||[]), JSON.stringify(o.vegItems||[]), o.dishPrice||0, o.vegPrice||0, o.pkgFee||0, o.total||0, o.note||'', o.status||'confirmed', o.paid?1:0).run();
        // Upsert customer
        var ex = await env.DB.prepare("SELECT id FROM customers WHERE name=? AND address=?").bind(o.customer||'', o.address||'').first();
        if (ex) { await env.DB.prepare("UPDATE customers SET wx_name=?, order_count=order_count+1 WHERE id=?").bind(o.wxName||'', ex.id).run(); }
        else { await env.DB.prepare("INSERT INTO customers (id, name, wx_name, address, first_order_time, order_count) VALUES (?,?,?,?,datetime('now'),1)").bind('C' + Date.now().toString(36), o.customer||'', o.wxName||'', o.address||'').run(); }
        return json({ ok: true, id: oid });
      }
      if (path.startsWith('/api/orders/') && method === 'PUT') {
        var uid = path.split('/')[3];
        var { status } = await request.json();
        await env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status, uid).run();
        return json({ ok: true });
      }
      if (path.startsWith('/api/orders/') && method === 'DELETE') {
        await env.DB.prepare("DELETE FROM orders WHERE id=?").bind(path.split('/')[3]).run();
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
  });
}

function fmtDish(r) { return { id:r.id, name:r.name, cuisine:r.cuisine, cat:r.category, desc:r.description, price:r.price, image:r.image, tags:JSON.parse(r.tags||'[]'), portions:JSON.parse(r.portions||'{}'), ingredients:JSON.parse(r.ingredients||'[]'), weekly:r.weekly===1, tutorial:r.tutorial_steps?{difficulty:r.tutorial_difficulty,time:r.tutorial_time,steps:JSON.parse(r.tutorial_steps||'[]'),tips:r.tutorial_tips,pairing:r.tutorial_pairing}:null }; }
function fmtVeg(r) { return { id:r.id, name:r.name, cat:r.category, desc:r.description, pricePerGram:r.price_per_gram, presets:JSON.parse(r.presets||'[100,200,300]'), image:r.image, weekly:r.weekly===1 }; }
function fmtOrder(r) { return { id:r.id, pkg:r.package_type, pkgName:r.package_type==='a'?'单餐快送':r.package_type==='b'?'囤菜套餐':'周餐计划', pkgFee:r.package_fee, customer:r.customer_name, wxName:r.wx_name, address:r.address, deliveryTime:r.delivery_time, room:r.address, date:r.delivery_time, items:JSON.parse(r.items_json||'[]'), vegItems:JSON.parse(r.veg_items_json||'[]'), dishPrice:r.dish_price, vegPrice:r.veg_price, total:r.total, note:r.note, status:r.status, time:r.created_at, ts:new Date(r.created_at).getTime(), paid:r.paid===1 }; }
