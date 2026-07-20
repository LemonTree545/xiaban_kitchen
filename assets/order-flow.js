(function (root) {
  const DRAFT_KEY = 'xk_order_draft_v2';
  const RECENT_ORDER_KEY = 'xk_recent_order_v2';
  const portionMultiplier = portion => portion === '小' ? 0.7 : portion === '大' ? 1.3 : 1;
  const clampDishQuantity = value => Math.min(20, Math.max(1, Math.trunc(Number(value) || 1)));
  const normalizeVegGrams = value => {
    const grams = Math.min(2000, Math.max(0, Math.round((Number(value) || 0) / 50) * 50));
    return grams > 0 && grams < 50 ? 50 : grams;
  };
  function calculateCart({ dishes, veggies, sel, selQty, selVeg, packageFee = 0 }) {
    let dishQuantity = 0, dishTotal = 0, vegCount = 0, vegTotal = 0;
    Object.entries(sel || {}).forEach(([id, portion]) => {
      if (!portion || portion === '不选') return;
      const dish = dishes.find(item => item.id === id); if (!dish) return;
      const quantity = clampDishQuantity(selQty?.[id]);
      dishQuantity += quantity;
      dishTotal += Math.round(Number(dish.price) * portionMultiplier(portion)) * quantity;
    });
    Object.entries(selVeg || {}).forEach(([id, value]) => {
      const grams = normalizeVegGrams(value); if (!grams) return;
      const veg = veggies.find(item => item.id === id); if (!veg) return;
      vegCount += 1; vegTotal += grams * Number(veg.pricePerGram);
    });
    const total = Math.round((dishTotal + vegTotal + Number(packageFee || 0)) * 100) / 100;
    return { dishQuantity, dishTotal, vegCount, vegTotal, total };
  }
  const saveJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const loadJson = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  root.XKOrderFlow = {
    clampDishQuantity, normalizeVegGrams, calculateCart,
    createRequestKey: () => crypto.randomUUID(),
    saveDraft: value => saveJson(DRAFT_KEY, value), loadDraft: () => loadJson(DRAFT_KEY),
    clearDraft: () => localStorage.removeItem(DRAFT_KEY),
    saveRecentOrder: value => saveJson(RECENT_ORDER_KEY, value), loadRecentOrder: () => loadJson(RECENT_ORDER_KEY)
  };
})(globalThis);
