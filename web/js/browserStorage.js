const stores = ["plans", "components", "settings"];
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const newId = prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
let connection;

function openDatabase() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(`endfield-factory-planner:${new URL("../", import.meta.url).pathname}`, 1);
    request.onupgradeneeded = () => stores.forEach(name => request.result.createObjectStore(name));
    request.onerror = () => reject(new Error("无法打开浏览器存储：" + request.error.message));
    request.onblocked = () => reject(new Error("请关闭此网站的其他标签页后重试"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
  }).catch(error => { connection = null; throw error; });
  return connection;
}

async function transaction(names, mode, work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let result;
    tx.oncomplete = () => resolve(typeof result === "function" ? result() : result);
    tx.onabort = () => reject(new Error("浏览器存储操作失败：" + (tx.error?.message || "事务已取消")));
    tx.onerror = () => {}; // Abort handles errors; never report success before commit.
    try { result = work(tx); }
    catch (error) { tx.abort(); reject(error); }
  });
}

function normalizeItem(body, prefix, id) {
  if (!object(body)) throw new Error("数据必须是对象");
  const item = structuredClone(body);
  const meta = object(item.meta) ? item.meta : item;
  meta.id = id || (validId(meta.id) ? meta.id : newId(prefix));
  meta.created_at ||= new Date().toISOString();
  meta.updated_at = new Date().toISOString();
  return { item, id: meta.id };
}

function normalizeRecipes(body) {
  if (!Array.isArray(body)) throw new Error("临时配方必须是数组");
  return body.filter(object).map(value => ({ ...value, temporary: true, id: validId(value.id) ? value.id : newId("tmp") }));
}

export async function browserRequest(method, url, body) {
  if (url === "/api/recipes" || url === "/api/special-recipes") {
    const name = url === "/api/recipes" ? "recipes_industrial" : "special_recipes";
    const response = await fetch(new URL(`../recipes/${name}.json`, import.meta.url));
    if (!response.ok) throw new Error(`配方加载失败（${response.status}）`);
    return response.json();
  }
  if (url === "/api/temp-recipes") {
    const value = method === "PUT" ? normalizeRecipes(body) : null;
    return transaction(["settings"], method === "GET" ? "readonly" : "readwrite", tx => {
      const store = tx.objectStore("settings");
      if (method === "PUT") { store.put(value, "temp-recipes"); return value; }
      const request = store.get("temp-recipes");
      return () => request.result || [];
    });
  }
  const match = /^\/api\/(plans|components)(?:\/([^/]+))?$/.exec(url);
  if (!match) throw new Error("未知数据接口");
  const [, name, encodedId] = match;
  const id = encodedId ? decodeURIComponent(encodedId) : undefined;
  if (encodedId && !validId(id)) throw new Error("无效 ID");
  const result = await transaction([name], method === "GET" ? "readonly" : "readwrite", tx => {
    const store = tx.objectStore(name);
    if (method === "GET") {
      const request = id ? store.get(id) : store.getAll();
      return () => request.result;
    }
    if (method === "DELETE" && id) { store.delete(id); return { ok: true, id }; }
    if (method !== "POST" && method !== "PUT") throw new Error("不支持的操作");
    const saved = normalizeItem(body, name === "plans" ? "plan" : "cmp", id);
    store.put(saved.item, saved.id);
    return saved.item;
  });
  if (method === "GET" && id && !result) throw new Error("未找到数据");
  if (method === "GET" && !id && name === "plans") return result.map(plan => {
    const meta = plan.meta || plan;
    return { id: meta.id, name: meta.name || meta.id, icon_item_id: meta.icon_item_id || "",
      created_at: meta.created_at, updated_at: meta.updated_at,
      node_count: Array.isArray(plan.nodes) ? plan.nodes.length : 0,
      edge_count: Array.isArray(plan.edges) ? plan.edges.length : 0 };
  });
  return result;
}

export async function exportBrowserBackup() {
  return transaction(stores, "readonly", tx => {
    const plans = tx.objectStore("plans").getAll();
    const components = tx.objectStore("components").getAll();
    const recipes = tx.objectStore("settings").get("temp-recipes");
    return () => ({ format: "endfield-factory-backup", version: 1,
      exported_at: new Date().toISOString(), plans: plans.result,
      components: components.result, tempRecipes: recipes.result || [] });
  });
}

export function validateBackup(data) {
  if (!object(data) || data.format !== "endfield-factory-backup" || data.version !== 1 ||
      ![data.plans, data.components, data.tempRecipes].every(Array.isArray)) throw new Error("备份格式或版本不正确");
  for (const name of ["plans", "components"]) {
    const ids = new Set();
    for (const item of data[name]) {
      const id = object(item) ? (item.meta?.id || item.id) : null;
      if (!validId(id) || ids.has(id)) throw new Error("备份包含无效或重复 ID");
      if (name === "plans" && (!Array.isArray(item.nodes) || !Array.isArray(item.edges))) throw new Error("方案格式不正确");
      ids.add(id);
    }
  }
  if (data.tempRecipes.some(item => !object(item) || !validId(item.id))) throw new Error("临时配方格式不正确");
  return data;
}

export async function importBrowserBackup(data) {
  validateBackup(data);
  // Merge in one transaction so a quota/write failure cannot leave a partial import.
  return transaction(stores, "readwrite", tx => {
    for (const name of ["plans", "components"]) {
      for (const item of data[name]) tx.objectStore(name).put(item, item.meta?.id || item.id);
    }
    const store = tx.objectStore("settings");
    const request = store.get("temp-recipes");
    request.onsuccess = () => {
      const merged = new Map((request.result || []).map(item => [item.id, item]));
      for (const item of normalizeRecipes(data.tempRecipes)) merged.set(item.id, item);
      store.put([...merged.values()], "temp-recipes");
    };
  });
}
