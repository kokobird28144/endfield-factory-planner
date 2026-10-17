// recipes.js —— 配方数据层：合并只读主配方与临时配方，建立索引、固/液判定与图标兜底。
import { api } from "./api.js";

const LIQUID_PREFIX = "item_liquid_";
const GAS_PREFIX = "item_gas_";

// 灌装配方判定用：灌装机设施 id；「能进一步做成成品」的容器（蓝铁瓶 / 赤铜瓶）。
const FILLING_FACILITY_ID = "filling_powder_mc_1";
const FILLING_KEEP_BOTTLE_IDS = new Set(["item_iron_bottle", "item_copper_bottle"]); // 蓝铁瓶、赤铜瓶
// 拆解配方判定用：拆解机设施 id（拆瓶回收，属于底层杂项，与灌装一并隐藏）。
const DISMANTLER_FACILITY_ID = "dismantler_1";

// 转化机的运转恒定消耗合并到实际配方卡片，不再要求用户另建消耗节点。
const FACILITY_FIXED_INPUT = {
  transmuter_1: { item_id: "item_liquid_xiranite", name_cn: "液化息壤", qty: 6, rate_per_min: 6, fixed: true },
  transmuter_2: { item_id: "item_gas_xiranite", name_cn: "息壤气", qty: 6, rate_per_min: 6, fixed: true },
};
// 高效配方复用原转化机分类，但内部保留独立 facility_id，以维持比例运转开销及旧方案兼容。
const EFFICIENT_FACILITY_VARIANTS = {
  transmuter_1: { id: "transmuter_1_efficient" },
  transmuter_2: { id: "transmuter_2_efficient" },
};
const FACILITY_PROPORTIONAL_INPUT = {
  transmuter_1_efficient: { item_id: "item_liquid_xiranite", name_cn: "液化息壤", qty: 6, rate_per_min: 6, proportional: true },
  transmuter_2_efficient: { item_id: "item_gas_xiranite", name_cn: "息壤气", qty: 6, rate_per_min: 6, proportional: true },
};
const STANDALONE_OVERHEAD_RECIPES = new Set([
  "液气转化机·消耗液化息壤",
  "固气转化机·消耗息壤气",
]);

function baseKeyForMain(r) {
  return `m:${r.page_item_id || ""}|${r.recipe_name || ""}|${r.facility_id || ""}`;
}
function keyForMain(r) {
  return `${baseKeyForMain(r)}|${r.signature || recipeSignature(r)}`;
}
function keyForTemp(r) {
  return `t:${r.id}`;
}

function recipeSignature(r) {
  const side = (ports) => (ports || [])
    .map((p) => `${p.item_id || ""}:${Number(p.rate_per_min) || 0}`)
    .join(",");
  return `${side(r.inputs)}=>${side(r.outputs)}`;
}

class RecipeStore {
  constructor() {
    this.recipes = [];          // 规范化后的配方数组
    this.byKey = new Map();      // 完整 key -> recipe
    this.byBaseKey = new Map();  // 旧版无签名 key -> 同组最后一个 recipe
    this.producers = new Map();  // item_id -> [recipe...]（输出含该物品）
    this.itemMeta = new Map();   // item_id -> { name_cn, state }
    this.facilities = [];        // [{id, name}]
    this.tempRaw = [];           // 临时配方原始数组（用于编辑器回填）
    this.mainRaw = [];           // 主配方原始数组（重建时复用）
    this.specialRaw = [];        // 特殊配方原始数组（与主配方分离，长久有效）
  }

  async init() {
    const [main, special, temp] = await Promise.all([
      api.getRecipes(),
      api.getSpecialRecipes().catch(() => []),
      api.getTempRecipes(),
    ]);
    this._build(main || [], special || [], temp || []);
  }

  async reloadTemp() {
    const temp = await api.getTempRecipes();
    // 主配方与特殊配方在内存中已缓存原始数组，重建时直接复用
    this._build(this.mainRaw, this.specialRaw, temp || []);
  }

  _build(mainArr, specialArr, tempArr) {
    this.recipes = [];
    this.byKey.clear();
    this.byBaseKey.clear();
    this.producers.clear();
    this.itemMeta.clear();
    this.tempRaw = tempArr.slice();
    this.mainRaw = mainArr.slice();
    this.specialRaw = specialArr.slice();

    const facSet = new Map();
    const addRecipe = (raw, temporary, special) => {
      const rec = this._normalize(raw, temporary, special);
      this.recipes.push(rec);
      this.byKey.set(rec.key, rec);
      this.byBaseKey.set(rec.baseKey, rec);
      if (rec.catalog_facility_id && !facSet.has(rec.catalog_facility_id)) {
        facSet.set(rec.catalog_facility_id, rec.catalog_facility_name_cn || rec.catalog_facility_id);
      }
      for (const p of rec.outputs) {
        if (!this.producers.has(p.item_id)) this.producers.set(p.item_id, []);
        this.producers.get(p.item_id).push(rec);
      }
      // 记录物品元数据（名称 + 固/液状态）
      for (const p of [...rec.inputs, ...rec.outputs]) {
        this._registerItem(p);
      }
    };

    mainArr.forEach((r) => {
      addRecipe(r, false, false);
      const efficient = EFFICIENT_FACILITY_VARIANTS[r.facility_id];
      if (efficient) {
        addRecipe({
          ...r,
          recipe_name: `${r.recipe_name}（高效）`,
          facility_id: efficient.id,
          facility_name_cn: r.facility_name_cn || r.facility_id,
          catalog_facility_id: r.facility_id,
          catalog_facility_name_cn: r.facility_name_cn || r.facility_id,
          section: "高效转化配方",
          efficient: true,
        }, false, false);
      }
    });
    // 特殊配方：非临时（长久有效），但打上 special 标记以便与主配方区分显示
    specialArr.forEach((r) => addRecipe(r, false, true));
    tempArr.forEach((r) => addRecipe(r, true, false));

    // recipe_name 是配方引用的一部分，不能为了显示而改写。对所有同名配方生成“输入 → 输出”展示名，
    // 把真正有区别的物料放在标题开头；即使重复项跨 page_item_id、设施或来自临时配方，也能一眼分辨。
    const sameNameGroups = new Map();
    const actualInputsOf = (rec) => rec.inputs.filter((port) => !port.fixed && !port.proportional);
    const sideName = (ports, empty) => ports.length ? ports.map((port) => port.name_cn).join(" + ") : empty;
    const routeName = (rec) => `${sideName(actualInputsOf(rec), "无输入")} → ${sideName(rec.outputs, "无输出")}`;
    const rateRoute = (rec) => {
      const side = (ports, empty) => ports.length
        ? ports.map((port) => `${port.name_cn} ${port.rate_per_min}/分`).join(" + ")
        : empty;
      return `${side(actualInputsOf(rec), "无输入")} → ${side(rec.outputs, "无输出")}`;
    };
    for (const rec of this.recipes) {
      rec.displayName = rec.recipe_name;
      rec.duplicateName = false;
      if (rec.overheadOnly) continue;
      if (!sameNameGroups.has(rec.recipe_name)) sameNameGroups.set(rec.recipe_name, []);
      sameNameGroups.get(rec.recipe_name).push(rec);
    }
    for (const group of sameNameGroups.values()) {
      if (group.length < 2) continue;
      const routeCounts = new Map();
      for (const rec of group) routeCounts.set(routeName(rec), (routeCounts.get(routeName(rec)) || 0) + 1);
      const routeFacilityCounts = new Map();
      for (const rec of group) {
        const key = `${routeName(rec)}\n${rec.facility_name_cn || rec.facility_id}`;
        routeFacilityCounts.set(key, (routeFacilityCounts.get(key) || 0) + 1);
      }
      for (const rec of group) {
        const route = routeName(rec);
        const facility = rec.facility_name_cn || rec.facility_id || "未知设施";
        const routeFacilityKey = `${route}\n${facility}`;
        rec.duplicateName = true;
        rec.displayName = routeCounts.get(route) === 1
          ? route
          : (routeFacilityCounts.get(routeFacilityKey) === 1
            ? `${route}（${facility}）`
            : `${rateRoute(rec)}（${facility}）`);
      }
    }

    this.facilities = [...facSet.entries()].map(([id, name]) => ({ id, name }));
  }

  _normalize(raw, temporary, special) {
    const norm = (p) => ({
      item_id: p.item_id,
      name_cn: p.name_cn || p.item_id,
      qty: Number(p.qty) || 0,
      rate_per_min: Number(p.rate_per_min) || 0,
      state: p.state || null, // 可选：临时配方显式覆盖固/液
      fixed: !!p.fixed, // 恒定消耗端口：运转时按固定速率消耗，不随机器速度缩放（类似耗电）
      proportional: !!p.proportional, // 比例运转消耗：与普通配方输入一样按实际有效速度线性缩放
    });
    const inputs = Array.isArray(raw.inputs) ? raw.inputs.map(norm) : [];
    const outputs = Array.isArray(raw.outputs) ? raw.outputs.map(norm) : [];
    const rec = {
      temporary,
      special: !!special,
      _raw: raw,
      page_item_id: raw.page_item_id || (outputs[0] && outputs[0].item_id) || "",
      page_name_cn: raw.page_name_cn || (outputs[0] && outputs[0].name_cn) || raw.recipe_name || "",
      section: raw.section || "合成表",
      recipe_name: raw.recipe_name || "未命名配方",
      facility_id: raw.facility_id || "",
      facility_name_cn: raw.facility_name_cn || raw.facility_id || "",
      catalog_facility_id: raw.catalog_facility_id || raw.facility_id || "",
      catalog_facility_name_cn: raw.catalog_facility_name_cn || raw.facility_name_cn || raw.facility_id || "",
      time_sec: Number(raw.time_sec) || 0,
      inputs,
      outputs,
    };
    rec.efficient = !!raw.efficient || !!FACILITY_PROPORTIONAL_INPUT[rec.facility_id];
    rec.overheadOnly = !!special && STANDALONE_OVERHEAD_RECIPES.has(rec.recipe_name);
    const proportionalInput = FACILITY_PROPORTIONAL_INPUT[rec.facility_id];
    if (!rec.overheadOnly && proportionalInput && !rec.inputs.some((p) => p.proportional)) {
      rec.inputs.push(norm(proportionalInput));
    }
    // 高效配方签名包含比例开销；普通配方签名仍不包含自动合并的固定开销，以兼容旧方案。
    rec.signature = recipeSignature(rec);
    rec.baseKey = temporary ? keyForTemp(raw) : baseKeyForMain(rec);
    // 运行时 key 必须包含签名；否则同名、同设施但不同原料的变体会在 Map 中互相覆盖。
    rec.key = temporary ? rec.baseKey : keyForMain(rec);
    const fixedInput = FACILITY_FIXED_INPUT[rec.facility_id];
    if (!rec.overheadOnly && fixedInput && !rec.inputs.some((p) => p.fixed)) {
      rec.inputs.push(norm(fixedInput));
    }
    // 灌装配方标记：灌装机设施，或名称含「灌装」。
    rec.filling = rec.facility_id === FILLING_FACILITY_ID || rec.recipe_name.includes("灌装");
    // 例外保留：灌装配方中，用蓝铁瓶 / 赤铜瓶灌装的（可进一步做成成品），默认也显示。
    rec.fillingKeep = rec.filling && inputs.some((p) => FILLING_KEEP_BOTTLE_IDS.has(p.item_id));
    // 拆解配方标记：拆解机设施（拆瓶回收，与灌装一并默认隐藏）。
    rec.dismantle = rec.facility_id === DISMANTLER_FACILITY_ID;
    return rec;
  }

  _registerItem(p) {
    let meta = this.itemMeta.get(p.item_id);
    if (!meta) {
      meta = { name_cn: p.name_cn || p.item_id, state: null };
      this.itemMeta.set(p.item_id, meta);
    }
    if (p.name_cn && meta.name_cn === p.item_id) meta.name_cn = p.name_cn;
    if (p.state && !meta.state) meta.state = p.state; // 显式覆盖优先
  }

  // -- 查询 --
  getAll() { return this.recipes.filter((rec) => !rec.overheadOnly); }
  getByKey(key) {
    return this.byKey.get(key) || this.byBaseKey.get(key) || null;
  }
  producersOf(itemId) { return this.producers.get(itemId) || []; }
  consumersOf(itemId) { return this.getAll().filter((rec) => rec.inputs.some((p) => p.item_id === itemId)); }
  getFacilities() { return this.facilities; }

  itemName(itemId) {
    const m = this.itemMeta.get(itemId);
    return (m && m.name_cn) || itemId;
  }

  // 物料形态：显式覆盖 > item_id 前缀规则（气体 / 液体 / 固体）。
  itemState(itemId) {
    const m = this.itemMeta.get(itemId);
    if (m && m.state) return m.state;
    const id = String(itemId || "");
    if (id.startsWith(GAS_PREFIX)) return "gas";
    if (id.startsWith(LIQUID_PREFIX)) return "liquid";
    return "solid";
  }

  // 通过 recipe_ref 找回配方：新方案用签名精确区分变体；旧方案仍按三元组兼容加载。
  resolveRef(ref) {
    if (!ref) return null;
    if (ref.temp_id) return this.byKey.get(`t:${ref.temp_id}`) || null;
    const baseKey = `m:${ref.page_item_id || ""}|${ref.recipe_name || ""}|${ref.facility_id || ""}`;
    if (ref.recipe_signature) {
      const exact = this.byKey.get(`${baseKey}|${ref.recipe_signature}`);
      if (exact) return exact;
      // 配方数据演进后，旧签名可能已失效；仅当同一三元组唯一时才升级，
      // 避免把有多个变体的旧引用悄然指向错误配方。
      const candidates = this.recipes.filter((rec) => !rec.temporary && rec.baseKey === baseKey);
      return candidates.length === 1 ? candidates[0] : null;
    }
    // 旧方案没有签名：保持旧版“同组三元组取最后一条”的兼容行为。
    const rec = this.byBaseKey.get(baseKey);
    return rec && !rec.temporary ? rec : null;
  }

  // 生成 recipe_ref（供序列化）；签名防止同三元组配方被后写变体覆盖。
  makeRef(rec) {
    if (!rec) return null;
    if (rec.temporary) return { temp_id: rec._raw.id, recipe_name: rec.recipe_name };
    return {
      page_item_id: rec.page_item_id,
      recipe_name: rec.recipe_name,
      facility_id: rec.facility_id,
      recipe_signature: rec.signature,
    };
  }
}

export const recipes = new RecipeStore();
