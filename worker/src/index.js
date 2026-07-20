const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const ORDER_STATUSES = new Set([
  'pending_payment', 'payment_submitted', 'payment_check',
  'confirmed', 'preparing', 'delivering', 'done', 'cancelled', 'expired'
]);
const ORDER_TRANSITIONS = {
  pending_payment: new Set(['payment_submitted', 'cancelled', 'expired']),
  payment_submitted: new Set(['payment_check', 'confirmed', 'cancelled']),
  payment_check: new Set(['confirmed', 'cancelled']),
  confirmed: new Set(['preparing', 'cancelled']),
  preparing: new Set(['delivering', 'cancelled']),
  delivering: new Set(['done']),
  done: new Set(), cancelled: new Set(), expired: new Set()
};
const PACKAGES = {
  a: { min: 1, max: 3, fee: 10 },
  b: { min: 4, max: 6, fee: 25 },
  c: { min: 10, max: 12, fee: 60 }
};

export function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    throw new ValidationError('成品菜数量必须为1至20份');
  }
  return quantity;
}

export function normalizeVegGrams(value) {
  const grams = Number(value);
  if (!Number.isInteger(grams) || grams < 50 || grams > 2000) {
    throw new ValidationError('净菜重量必须在50至2000克之间');
  }
  if (grams % 50 !== 0) throw new ValidationError('净菜重量必须按50克递增');
  return grams;
}

export function dishUnitPrice(price, portion) {
  const multiplier = portion === '小' ? 0.7 : portion === '大' ? 1.3 : 1;
  return Math.round(Number(price) * multiplier);
}

export function canTransition(from, to) {
  return Boolean(ORDER_TRANSITIONS[from]?.has(to));
}

export async function hashLookupToken(token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(bytes));
}

export function deriveLookupToken(idempotencyKey, secret) {
  return sign(`order:${idempotencyKey}`, secret);
}

export default {
  fetch(request, env) {
    return createApp(env)(request);
  }
};

export function createApp(env) {
  return async function app(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/public/menu' && request.method === 'GET') {
        return json(await publicMenu(env.DB), 200, cors);
      }

      if (url.pathname === '/api/public/orders' && request.method === 'POST') {
        const key = request.headers.get('X-Idempotency-Key') || '';
        const order = await createOrder(env, await requestJson(request), key);
        return json(order, 201, cors);
      }

      const publicOrderMatch = url.pathname.match(/^\/api\/public\/orders\/([^/]+)$/);
      if (publicOrderMatch && request.method === 'GET') {
        return json(await getPublicOrder(env.DB, decodeURIComponent(publicOrderMatch[1]), request.headers.get('X-Order-Token')), 200, cors);
      }

      const paymentNoticeMatch = url.pathname.match(/^\/api\/public\/orders\/([^/]+)\/payment-submitted$/);
      if (paymentNoticeMatch && request.method === 'POST') {
        return json(await submitPaymentNotice(env.DB, decodeURIComponent(paymentNoticeMatch[1]), request.headers.get('X-Order-Token')), 200, cors);
      }

      if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        const { password } = await requestJson(request);
        if (!constantTimeEqual(String(password || ''), String(env.ADMIN_PASSWORD || ''))) {
          return json({ error: '管理密码错误' }, 401, cors);
        }
        if (!env.ADMIN_SESSION_SECRET) {
          return json({ error: '服务端会话密钥未配置' }, 500, cors);
        }
        const expiresAt = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
        const token = await createSession({ role: 'admin', exp: Math.floor(expiresAt / 1000) }, env.ADMIN_SESSION_SECRET);
        return json({ token, expiresAt }, 200, cors);
      }

      if (url.pathname.startsWith('/api/admin/')) {
        const session = await adminSession(request, env);
        if (!session) return json({ error: '请先登录管理后台' }, 401, cors);

        if (url.pathname === '/api/admin/data' && request.method === 'GET') {
          return json(await adminData(env.DB), 200, cors);
        }
        if (url.pathname === '/api/admin/data' && request.method === 'POST') {
          await saveAdminCatalog(env.DB, await requestJson(request));
          return json({ ok: true }, 200, cors);
        }
        if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
          await expireDueOrders(env.DB);
          const rows = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
          return json(rows.results.map(formatOrder), 200, cors);
        }
        if (url.pathname.startsWith('/api/admin/orders/')) {
          const id = decodeURIComponent(url.pathname.split('/')[4] || '');
          if (!id) return json({ error: '订单不存在' }, 404, cors);
          if (request.method === 'PATCH') {
            const updated = await updateOrder(env.DB, id, await requestJson(request));
            return json(updated, 200, cors);
          }
          if (request.method === 'DELETE') {
            await env.DB.prepare('DELETE FROM orders WHERE id=?').bind(id).run();
            return json({ ok: true }, 200, cors);
          }
        }
      }

      return json({ error: '接口不存在' }, 404, cors);
    } catch (error) {
      const status = error instanceof AuthError ? 401
        : error instanceof NotFoundError ? 404
          : error instanceof ValidationError ? 422
            : 500;
      const message = status === 500 ? '服务暂时不可用，请稍后重试' : error.message;
      return json({ error: message }, status, cors);
    }
  };
}

async function publicMenu(db) {
  const [cuisines, dishes, veggies, community] = await Promise.all([
    db.prepare('SELECT name FROM cuisines ORDER BY id').all(),
    db.prepare('SELECT * FROM dishes WHERE weekly=1 ORDER BY id').all(),
    db.prepare('SELECT * FROM veggies WHERE weekly=1 ORDER BY id').all(),
    db.prepare('SELECT data_json FROM communities ORDER BY id LIMIT 1').first()
  ]);
  return {
    cuisines: cuisines.results.map(function(row) { return safeText(row.name); }),
    dishes: dishes.results.map(formatDish).filter(Boolean),
    veggies: veggies.results.map(formatVeg).filter(Boolean),
    communities: community ? sanitizeCommunities(parseJson(community.data_json, [])) : []
  };
}

async function adminData(db) {
  await expireDueOrders(db);
  const [menu, orders, customers, settings] = await Promise.all([
    publicMenu(db),
    db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all(),
    db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all(),
    db.prepare("SELECT key, value FROM settings WHERE key IN ('paymentQR_wx','paymentQR_alipay')").all()
  ]);
  const displaySettings = Object.fromEntries(settings.results.map((row) => [row.key, row.value]));
  return { ...menu, orders: orders.results.map(formatOrder), customers: customers.results, settings: displaySettings };
}

async function expireDueOrders(db, now = new Date().toISOString()) {
  await db.prepare("UPDATE orders SET status='expired', updated_at=? WHERE status='pending_payment' AND expires_at IS NOT NULL AND expires_at<=?")
    .bind(now, now).run();
}

async function createOrder(env, body, idempotencyKey) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    throw new ValidationError('订单请求标识无效');
  }
  if (!env.ORDER_LOOKUP_SECRET) throw new Error('ORDER_LOOKUP_SECRET 未配置');
  const lookupToken = await deriveLookupToken(idempotencyKey, env.ORDER_LOOKUP_SECRET);
  const lookupTokenHash = await hashLookupToken(lookupToken);
  const existing = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(idempotencyKey).first();
  if (existing) return { ...formatPublicOrder(existing), lookupToken };

  const db = env.DB;
  const packageId = String(body.packageId || '');
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new ValidationError('套餐无效');

  const customer = cleanText(body.customer, 40, '请填写称呼');
  const address = cleanText(body.address, 120, '请完整选择配送地址');
  const deliveryTime = cleanText(body.deliveryTime, 60, '请选择配送时间');
  const wxName = cleanText(body.wxName || '', 50, '微信名过长', true);
  const note = cleanText(body.note || '', 500, '备注过长', true);
  const selections = Array.isArray(body.selections) ? body.selections : [];
  const vegSelections = Array.isArray(body.vegSelections) ? body.vegSelections : [];
  const quantities = selections.map((selection) => normalizeQuantity(selection.quantity ?? 1));
  const totalDishQuantity = quantities.reduce((sum, quantity) => sum + quantity, 0);
  if (totalDishQuantity < pkg.min || totalDishQuantity > pkg.max) {
    throw new ValidationError(`该套餐需选择${pkg.min}-${pkg.max}份成品菜`);
  }

  const [dishRows, vegRows] = await Promise.all([
    db.prepare('SELECT * FROM dishes WHERE weekly=1').all(),
    db.prepare('SELECT * FROM veggies WHERE weekly=1').all()
  ]);
  const dishesById = new Map(dishRows.results.map((dish) => [dish.id, dish]));
  const veggiesById = new Map(vegRows.results.map((veg) => [veg.id, veg]));
  const seenDishIds = new Set();
  let dishPrice = 0;
  const items = selections.map((selection, index) => {
    const id = String(selection.id || '');
    if (seenDishIds.has(id)) throw new ValidationError('菜品不能重复选择，请调整购买份数');
    seenDishIds.add(id);
    const dish = dishesById.get(id);
    if (!dish) throw new ValidationError('所选菜品已下架，请刷新菜单');
    const portion = ['小', '中', '大'].includes(selection.portion) ? selection.portion : '中';
    const quantity = quantities[index];
    const unitPrice = dishUnitPrice(dish.price, portion);
    const price = unitPrice * quantity;
    dishPrice += price;
    return { id, name: dish.name, portion, quantity, unitPrice, price };
  });

  const seenVegIds = new Set();
  let vegPrice = 0;
  const vegItems = vegSelections.map((selection) => {
    const id = String(selection.id || '');
    if (seenVegIds.has(id)) throw new ValidationError('净菜不能重复选择');
    seenVegIds.add(id);
    const veg = veggiesById.get(id);
    if (!veg) throw new ValidationError('所选净菜已下架，请刷新菜单');
    const grams = normalizeVegGrams(selection.grams);
    const price = Math.round(grams * Number(veg.price_per_gram) * 100) / 100;
    vegPrice += price;
    return { id, name: veg.name, grams, cut: cleanText(selection.cut || '块状', 20, '切配方式无效'), price };
  });

  const id = `ORD${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 30 * 60 * 1000).toISOString();
  const total = Math.round((dishPrice + vegPrice + pkg.fee) * 100) / 100;
  const insertResult = await db.prepare('INSERT INTO orders (id, customer_name, wx_name, address, delivery_time, package_type, items_json, veg_items_json, dish_price, veg_price, package_fee, total, note, status, paid, idempotency_key, lookup_token_hash, expires_at, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
    .bind(id, customer, wxName, address, deliveryTime, packageId, JSON.stringify(items), JSON.stringify(vegItems), dishPrice, vegPrice, pkg.fee, total, note, 'pending_payment', 0, idempotencyKey, lookupTokenHash, expiresAt, createdAt, createdAt).run();
  if (insertResult.meta?.changes === 0) {
    const concurrentExisting = await db.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(idempotencyKey).first();
    if (!concurrentExisting) throw new Error('订单创建失败');
    return { ...formatPublicOrder(concurrentExisting), lookupToken };
  }

  const existingCustomer = await db.prepare('SELECT id FROM customers WHERE name=? AND address=?').bind(customer, address).first();
  if (existingCustomer) {
    await db.prepare('UPDATE customers SET wx_name=?, order_count=order_count+1 WHERE id=?').bind(wxName, existingCustomer.id).run();
  } else {
    await db.prepare('INSERT INTO customers (id, name, wx_name, address, first_order_time, order_count) VALUES (?,?,?,?,?,?)')
      .bind(`C${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`, customer, wxName, address, createdAt, 1).run();
  }
  return { id, total, status: 'pending_payment', createdAt, expiresAt, lookupToken };
}

async function requireOrderAccess(row, token) {
  if (!row || !token) throw new AuthError('订单查询凭证无效');
  const actual = await hashLookupToken(token);
  if (!constantTimeEqual(actual, row.lookup_token_hash || '')) throw new AuthError('订单查询凭证无效');
}

async function expireOrderIfNeeded(db, row, now = new Date()) {
  if (row.status === 'pending_payment' && row.expires_at && Date.parse(row.expires_at) <= now.getTime()) {
    const updatedAt = now.toISOString();
    const updateResult = await db.prepare("UPDATE orders SET status='expired', updated_at=? WHERE id=? AND status='pending_payment'")
      .bind(updatedAt, row.id).run();
    if (updateResult.meta?.changes === 0) {
      const current = await db.prepare('SELECT * FROM orders WHERE id=?').bind(row.id).first();
      if (!current) throw new NotFoundError('订单不存在');
      return current;
    }
    return { ...row, status: 'expired', updated_at: updatedAt };
  }
  return row;
}

async function getPublicOrder(db, id, token) {
  let row = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  await requireOrderAccess(row, token);
  row = await expireOrderIfNeeded(db, row);
  const settings = await db.prepare("SELECT key,value FROM settings WHERE key IN ('paymentQR_wx','paymentQR_alipay')").all();
  return { ...formatPublicOrder(row), paymentMethods: Object.fromEntries(settings.results.map((item) => [item.key, item.value])) };
}

async function submitPaymentNotice(db, id, token) {
  let row = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  await requireOrderAccess(row, token);
  row = await expireOrderIfNeeded(db, row);
  if (row.status !== 'pending_payment') {
    throw new ValidationError(row.status === 'expired' ? '订单付款时间已结束，请重新下单' : '订单当前状态不能重复申报付款');
  }
  const now = new Date().toISOString();
  const updateResult = await db.prepare("UPDATE orders SET status='payment_submitted', payment_submitted_at=?, updated_at=? WHERE id=? AND status='pending_payment' AND expires_at>?")
    .bind(now, now, id, now).run();
  if (updateResult.meta?.changes === 0) {
    let current = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    if (!current) throw new NotFoundError('订单不存在');
    current = await expireOrderIfNeeded(db, current, new Date(now));
    throw new ValidationError(current.status === 'expired' ? '订单付款时间已结束，请重新下单' : '订单当前状态不能重复申报付款');
  }
  return formatPublicOrder({ ...row, status: 'payment_submitted', payment_submitted_at: now, updated_at: now });
}

async function updateOrder(db, id, body) {
  let row = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  if (!row) throw new NotFoundError('订单不存在');
  const now = new Date().toISOString();
  let result;

  if (body.action === 'confirm_payment') {
    if (!canTransition(row.status, 'confirmed')) throw new ValidationError('当前订单不能确认收款');
    result = await db.prepare("UPDATE orders SET status='confirmed', paid=1, paid_confirmed_at=?, updated_at=? WHERE id=? AND status=?")
      .bind(now, now, id, row.status).run();
  } else if (body.action === 'mark_payment_check') {
    if (!canTransition(row.status, 'payment_check')) throw new ValidationError('当前订单不能标记为待核实');
    result = await db.prepare("UPDATE orders SET status='payment_check', updated_at=? WHERE id=? AND status=?")
      .bind(now, id, row.status).run();
  } else if (body.action === 'advance') {
    if (!ORDER_STATUSES.has(body.status) || !canTransition(row.status, body.status)) throw new ValidationError('订单状态跳转无效');
    if (body.status === 'preparing' && !(row.paid_confirmed_at || Number(row.paid) === 1)) {
      throw new ValidationError('订单尚未确认收款');
    }
    result = await db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=? AND status=?')
      .bind(body.status, now, id, row.status).run();
  } else if (body.action === 'cancel') {
    if (!canTransition(row.status, 'cancelled')) throw new ValidationError('当前订单不能取消');
    result = await db.prepare("UPDATE orders SET status='cancelled', updated_at=? WHERE id=? AND status=?")
      .bind(now, id, row.status).run();
  } else {
    throw new ValidationError('订单操作无效');
  }

  if (result.meta?.changes === 0) {
    const current = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
    if (!current) throw new NotFoundError('订单不存在');
    throw new ValidationError('订单状态已变化，请刷新后重试');
  }
  row = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  return formatOrder(row);
}

async function saveAdminCatalog(db, data) {
  // ===== PHASE 1: VALIDATE ENTIRE PAYLOAD BEFORE ANY DELETE =====
  var validatedCuisines = [];
  if (Array.isArray(data.cuisines)) {
    for (var ci = 0; ci < data.cuisines.length; ci++) {
      validatedCuisines.push(validateSafeText(data.cuisines[ci], 30, '菜系名称'));
    }
  }

  var validatedDishes = [];
  if (Array.isArray(data.dishes)) {
    for (var di = 0; di < data.dishes.length; di++) {
      var dish = data.dishes[di];
      var dId = String(dish.id || '');
      if (!safeIdCheck(dId)) throw new ValidationError('菜品ID格式无效');
      var dName = validateSafeText(dish.name, 60, '菜品名称');
      var dCuisine = validateSafeText(dish.cuisine || '家常菜', 30, '菜品所属菜系');
      var dCat = validateSafeText(dish.cat || '荤菜', 20, '菜品分类');
      var dDesc = validateSafeText(dish.desc || '', 1000, '菜品描述', true);
      var dPrice = Number.isFinite(Number(dish.price)) ? Number(dish.price) : 0;
      var dImage = validateImageUrl(dish.image || '');
      var dWeekly = dish.weekly ? 1 : 0;

      var dTags = Array.isArray(dish.tags) ? dish.tags : [];
      if (dTags.length > 20) throw new ValidationError('标签数量过多');
      for (var ti = 0; ti < dTags.length; ti++) {
        var tag = dTags[ti];
        if (!tag || typeof tag !== 'object') throw new ValidationError('标签格式无效');
        validateSafeText(String(tag.t || ''), 20, '标签文字');
        validateSafeText(String(tag.c || ''), 30, '标签样式');
      }

      var dIngredients = Array.isArray(dish.ingredients) ? dish.ingredients : [];
      if (dIngredients.length > 30) throw new ValidationError('食材数量过多');
      for (var ii = 0; ii < dIngredients.length; ii++) {
        var ing = dIngredients[ii];
        if (!ing || typeof ing !== 'object') throw new ValidationError('食材格式无效');
        validateSafeText(String(ing.name || ''), 40, '食材名称');
        var g = Number(ing.grams);
        if (!Number.isFinite(g) || g < 0 || g > 10000) throw new ValidationError('食材克数无效');
      }

      var dPortions = dish.portions || {};
      if (typeof dPortions !== 'object') throw new ValidationError('分量设置格式无效');
      for (var pk in dPortions) {
        if (!Object.hasOwn(dPortions, pk)) continue;
        if (['小', '中', '大'].indexOf(pk) === -1) throw new ValidationError('分量类型无效');
        var pv = dPortions[pk];
        if (pv && typeof pv === 'object') {
          validateSafeText(String(pv.label || ''), 20, '分量标签');
        }
      }

      validatedDishes.push({ id: dId, name: dName, cuisine: dCuisine, cat: dCat, desc: dDesc, price: dPrice, image: dImage, tags: dTags, ingredients: dIngredients, portions: dPortions, weekly: dWeekly });
    }
  }

  var validatedVeggies = [];
  if (Array.isArray(data.veggies)) {
    for (var vi = 0; vi < data.veggies.length; vi++) {
      var veg = data.veggies[vi];
      var vId = String(veg.id || '');
      if (!safeIdCheck(vId)) throw new ValidationError('净菜ID格式无效');
      var vName = validateSafeText(veg.name, 60, '净菜名称');
      var vCat = validateSafeText(veg.cat || '根茎类', 20, '净菜分类');
      var vDesc = validateSafeText(veg.desc || '', 500, '净菜描述', true);
      var vPPG = Number(veg.pricePerGram);
      if (!Number.isFinite(vPPG) || vPPG < 0 || vPPG > 100) throw new ValidationError('净菜单价无效');
      var vImage = validateImageUrl(veg.image || '');
      var vWeekly = veg.weekly ? 1 : 0;

      var vPresets = Array.isArray(veg.presets) ? veg.presets : [];
      if (vPresets.length > 20) throw new ValidationError('预设重量数量过多');
      for (var pi = 0; pi < vPresets.length; pi++) {
        var p = Number(vPresets[pi]);
        if (!Number.isInteger(p) || p < 50 || p > 2000) throw new ValidationError('预设重量无效');
      }

      validatedVeggies.push({ id: vId, name: vName, cat: vCat, desc: vDesc, pricePerGram: vPPG, presets: vPresets, image: vImage, weekly: vWeekly });
    }
  }

  var validatedCommunityJson = null;
  if (Array.isArray(data.communities)) {
    validateCommunityData(data.communities);
    validatedCommunityJson = JSON.stringify(data.communities);
  }

  // ===== PHASE 2: ALL VALIDATION PASSED — DELETE AND INSERT =====
  if (Array.isArray(data.cuisines)) {
    await db.prepare('DELETE FROM cuisines').run();
    for (var cj = 0; cj < validatedCuisines.length; cj++) {
      await db.prepare('INSERT INTO cuisines (name) VALUES (?)').bind(validatedCuisines[cj]).run();
    }
  }
  if (Array.isArray(data.dishes)) {
    await db.prepare('DELETE FROM dishes').run();
    for (var dj = 0; dj < validatedDishes.length; dj++) {
      var dd = validatedDishes[dj];
      await db.prepare('INSERT INTO dishes (id, name, cuisine, category, description, price, image, tags, portions, ingredients, weekly) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(dd.id, dd.name, dd.cuisine, dd.cat, dd.desc, dd.price, dd.image, JSON.stringify(dd.tags), JSON.stringify(dd.portions), JSON.stringify(dd.ingredients), dd.weekly).run();
    }
  }
  if (Array.isArray(data.veggies)) {
    await db.prepare('DELETE FROM veggies').run();
    for (var vj = 0; vj < validatedVeggies.length; vj++) {
      var vd = validatedVeggies[vj];
      await db.prepare('INSERT INTO veggies (id, name, category, description, price_per_gram, presets, image, weekly) VALUES (?,?,?,?,?,?,?,?)')
        .bind(vd.id, vd.name, vd.cat, vd.desc, vd.pricePerGram, JSON.stringify(vd.presets), vd.image, vd.weekly).run();
    }
  }
  if (validatedCommunityJson !== null) {
    await db.prepare('DELETE FROM communities').run();
    await db.prepare('INSERT INTO communities (data_json) VALUES (?)').bind(validatedCommunityJson).run();
  }
  if (data.settings && typeof data.settings === 'object') {
    for (var sk = 0; sk < ['paymentQR_wx', 'paymentQR_alipay'].length; sk++) {
      var key = ['paymentQR_wx', 'paymentQR_alipay'][sk];
      if (Object.hasOwn(data.settings, key)) {
        await db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?').bind(key, String(data.settings[key]), String(data.settings[key])).run();
      }
    }
  }
}

async function adminSession(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return verifySession(token, env.ADMIN_SESSION_SECRET);
}

export async function createSession(payload, secret) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifySession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expectedSignature = await sign(encodedPayload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.role !== 'admin' || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function corsHeaders(origin, env) {
  const allowed = new Set([env.APP_ORIGIN, 'http://localhost:8787', 'http://localhost:3000'].filter(Boolean));
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Idempotency-Key,X-Order-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  });
  if (origin && allowed.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function json(data, status, headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

async function requestJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('请求数据格式错误');
  }
}

function formatDish(row) {
  if (!safeIdCheck(row.id)) return null;
  return {
    id: row.id,
    name: safeText(row.name),
    cuisine: safeText(row.cuisine),
    cat: safeText(row.category),
    desc: safeText(row.description),
    price: row.price,
    image: safeImageUrl(row.image),
    tags: parseJson(row.tags, []).map(function(tag) { return { t: safeText(tag.t || ''), c: safeText(tag.c || '') }; }),
    portions: sanitizePortions(parseJson(row.portions, {})),
    ingredients: parseJson(row.ingredients, []).map(function(ing) { return { name: safeText(ing.name || ''), grams: ing.grams || 0 }; }),
    weekly: Number(row.weekly) === 1
  };
}

function formatVeg(row) {
  if (!safeIdCheck(row.id)) return null;
  return {
    id: row.id,
    name: safeText(row.name),
    cat: safeText(row.category),
    desc: safeText(row.description),
    pricePerGram: row.price_per_gram,
    presets: parseJson(row.presets, [100, 200, 300]),
    image: safeImageUrl(row.image),
    weekly: Number(row.weekly) === 1
  };
}

function formatOrder(row) {
  return { id: row.id, pkg: row.package_type, pkgName: packageName(row.package_type), pkgFee: row.package_fee, customer: row.customer_name, wxName: row.wx_name, address: row.address, deliveryTime: row.delivery_time, room: row.address, date: row.delivery_time, items: parseJson(row.items_json, []), vegItems: parseJson(row.veg_items_json, []), dishPrice: row.dish_price, vegPrice: row.veg_price, total: row.total, note: row.note, status: row.status, time: row.created_at, ts: Date.parse(row.created_at) || 0, expiresAt: row.expires_at || '', paymentSubmittedAt: row.payment_submitted_at || '', paidConfirmedAt: row.paid_confirmed_at || '', updatedAt: row.updated_at || row.created_at, paid: Boolean(row.paid_confirmed_at) || Number(row.paid) === 1 };
}

function formatPublicOrder(row) {
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    expiresAt: row.expires_at,
    delivery: {
      customer: row.customer_name,
      address: row.address,
      deliveryTime: row.delivery_time
    },
    items: parseJson(row.items_json, []),
    vegItems: parseJson(row.veg_items_json, []),
    paymentSubmittedAt: row.payment_submitted_at || null
  };
}

function packageName(packageId) {
  return ({ a: '单餐快送', b: '囤菜套餐', c: '周餐计划' })[packageId] || '套餐订单';
}

function cleanText(value, maxLength, message, allowEmpty = false) {
  const text = String(value || '').trim();
  if (!allowEmpty && !text) throw new ValidationError(message);
  if (text.length > maxLength) throw new ValidationError(message);
  if (/[<>]/.test(text)) throw new ValidationError(message);
  return text;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

// ===== OUTPUT SANITIZATION =====
function safeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeText(text) {
  return safeHtml(text)
    .replace(/onerror\b/gi, 'data-x-error').replace(/onload\b/gi, 'data-x-load')
    .replace(/onclick\b/gi, 'data-x-click').replace(/onmouseover\b/gi, 'data-x-mouseover')
    .replace(/onfocus\b/gi, 'data-x-focus').replace(/onblur\b/gi, 'data-x-blur')
    .replace(/onkeydown\b/gi, 'data-x-keydown').replace(/onkeyup\b/gi, 'data-x-keyup')
    .replace(/onsubmit\b/gi, 'data-x-submit').replace(/onchange\b/gi, 'data-x-change')
    .replace(/javascript:/gi, 'x-javascript:');
}
function safeImageUrl(url) {
  if (!url) return '';
  var s = String(url).trim();
  if (!s) return '';
  if (/^(javascript|data|vbscript):/i.test(s)) return '';
  if (/["'<>]/.test(s)) return '';
  if (/^https:\/\//.test(s)) return s;
  if (/^\//.test(s)) return s;
  if (/^data:image\/(jpeg|png|gif|webp);base64,/.test(s)) return s;
  return '';
}
function safeIdCheck(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));
}
function sanitizePortions(portions) {
  if (!portions || typeof portions !== 'object') return {};
  var result = {};
  for (var key in portions) {
    if (!Object.hasOwn(portions, key)) continue;
    var safeKey = safeHtml(key);
    var val = portions[key];
    if (val && typeof val === 'object') {
      result[safeKey] = { meat: Number(val.meat) || 0, veg: Number(val.veg) || 0, label: safeText(val.label || '') };
    }
  }
  return result;
}
function sanitizeCommunities(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function(comm) {
    var c = { id: safeHtml(comm.id), name: safeText(comm.name) };
    if (comm.buildings) {
      c.buildings = comm.buildings.map(function(bld) {
        var b = { id: safeHtml(bld.id), name: safeText(bld.name) };
        if (bld.units) {
          b.units = bld.units.map(function(unit) {
            var u = { id: safeHtml(unit.id), name: safeText(unit.name) };
            if (unit.rooms) {
              u.rooms = unit.rooms.map(function(room) { return safeText(room); });
            }
            return u;
          });
        }
        return b;
      });
    }
    return c;
  });
}

// ===== INPUT VALIDATION =====
function validateSafeText(value, maxLength, fieldName, allowEmpty) {
  var text = String(value || '').trim();
  if (!allowEmpty && !text) throw new ValidationError(fieldName + '不能为空');
  if (text.length > maxLength) throw new ValidationError(fieldName + '过长');
  if (/[<>]/.test(text)) throw new ValidationError(fieldName + '包含非法字符');
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) throw new ValidationError(fieldName + '包含非法控制字符');
  return text;
}
function validateImageUrl(url) {
  if (!url || url === '') return '';
  var s = String(url).trim();
  if (!s) return '';
  if (/^(javascript|data|vbscript):/i.test(s)) throw new ValidationError('图片地址使用了不安全的协议');
  if (/["'<>]/.test(s)) throw new ValidationError('图片地址包含非法字符');
  if (/^https:\/\//.test(s)) return s;
  if (/^\//.test(s)) return s;
  if (/^data:image\/(jpeg|png|gif|webp);base64,/.test(s)) return s;
  throw new ValidationError('图片地址格式不支持');
}
function validateCommunityData(communities) {
  if (!Array.isArray(communities)) throw new ValidationError('小区数据格式无效');
  for (var ci = 0; ci < communities.length; ci++) {
    var comm = communities[ci];
    if (!comm || typeof comm !== 'object') throw new ValidationError('小区格式无效');
    validateSafeText(String(comm.id || ''), 64, '小区ID');
    validateSafeText(String(comm.name || ''), 60, '小区名称');
    if (comm.buildings) {
      if (!Array.isArray(comm.buildings)) throw new ValidationError('楼幢数据格式无效');
      for (var bi = 0; bi < comm.buildings.length; bi++) {
        var bld = comm.buildings[bi];
        if (!bld || typeof bld !== 'object') throw new ValidationError('楼幢格式无效');
        validateSafeText(String(bld.id || ''), 64, '楼幢ID');
        validateSafeText(String(bld.name || ''), 40, '楼幢名称');
        if (bld.units) {
          if (!Array.isArray(bld.units)) throw new ValidationError('单元数据格式无效');
          for (var ui = 0; ui < bld.units.length; ui++) {
            var unit = bld.units[ui];
            if (!unit || typeof unit !== 'object') throw new ValidationError('单元格式无效');
            validateSafeText(String(unit.id || ''), 64, '单元ID');
            validateSafeText(String(unit.name || ''), 40, '单元名称');
            if (unit.rooms) {
              if (!Array.isArray(unit.rooms)) throw new ValidationError('房间数据格式无效');
              for (var ri = 0; ri < unit.rooms.length; ri++) {
                validateSafeText(String(unit.rooms[ri] || ''), 20, '房间号');
              }
            }
          }
        }
      }
    }
  }
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function base64UrlEncode(value) { return bytesToBase64Url(new TextEncoder().encode(value)); }
function base64UrlDecode(value) { return new TextDecoder().decode(base64UrlToBytes(value)); }
function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64UrlToBytes(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  return difference === 0;
}

class AuthError extends Error {}
class NotFoundError extends Error {}
class ValidationError extends Error {}
