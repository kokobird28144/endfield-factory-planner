// api.js —— 与本地后端交互的薄封装（recipes / temp-recipes / plans / components）
// 所有函数返回 Promise，出错时抛出带可读信息的 Error。

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (err) {
    throw new Error(`网络请求失败：${err.message}`);
  }
  const text = await resp.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!resp.ok) {
    const msg = (data && data.error) ? data.error : `请求失败（${resp.status}）`;
    throw new Error(msg);
  }
  return data;
}

const legacyPlanIcons = new Map();

async function listPlans() {
  const plans = await request("GET", "/api/plans");
  const ids = new Set(plans.map(plan => plan.id));
  for (const id of legacyPlanIcons.keys()) if (!ids.has(id)) legacyPlanIcons.delete(id);
  // An already-running older server may omit icons from summaries even though
  // the complete saved plan contains them. Modern summaries need no extra reads.
  const missing = plans.filter(plan => !Object.hasOwn(plan, "icon_item_id"));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (next < missing.length) {
      const plan = missing[next++];
      const version = plan.updated_at || plan.created_at;
      const cached = legacyPlanIcons.get(plan.id);
      if (version && cached?.version === version) {
        plan.icon_item_id = cached.icon;
        continue;
      }
      try {
        const full = await request("GET", `/api/plans/${encodeURIComponent(plan.id)}`);
        const icon = typeof full?.meta?.icon_item_id === "string" ? full.meta.icon_item_id : "";
        plan.icon_item_id = icon;
        if (version) legacyPlanIcons.set(plan.id, { version, icon });
      } catch { /* Keep this entry usable; retry its icon on the next refresh. */ }
    }
  }));
  return plans;
}

async function writePlan(method, id, plan) {
  legacyPlanIcons.delete(id);
  try { return await request(method, `/api/plans/${encodeURIComponent(id)}`, plan); }
  finally { legacyPlanIcons.delete(id); }
}

export const api = {
  // 只读主配方
  getRecipes: () => request("GET", "/api/recipes"),

  // 只读特殊配方（与主配方分离存放，长久有效）
  getSpecialRecipes: () => request("GET", "/api/special-recipes"),

  // 临时配方（整表读取 / 整表覆盖保存）
  getTempRecipes: () => request("GET", "/api/temp-recipes"),
  saveTempRecipes: (arr) => request("PUT", "/api/temp-recipes", arr),

  // 方案
  listPlans,
  getPlan: (id) => request("GET", `/api/plans/${encodeURIComponent(id)}`),
  createPlan: (plan) => request("POST", "/api/plans", plan),
  updatePlan: (id, plan) => writePlan("PUT", id, plan),
  deletePlan: (id) => writePlan("DELETE", id),

  // 黑盒组件
  listComponents: () => request("GET", "/api/components"),
  getComponent: (id) => request("GET", `/api/components/${encodeURIComponent(id)}`),
  createComponent: (cmp) => request("POST", "/api/components", cmp),
  updateComponent: (id, cmp) => request("PUT", `/api/components/${encodeURIComponent(id)}`, cmp),
  deleteComponent: (id) => request("DELETE", `/api/components/${encodeURIComponent(id)}`),
};
