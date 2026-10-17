// ui.js —— 界面装配：配方目录/元件/组件库、检查器、产消表、方案管理、黑盒组合、导出。
import { api } from "./api.js";
import { flowRuleLabel } from "./flowRules.js";
import { recipes } from "./recipes.js";
import { graph } from "./graph.js";
import { fmt, WARN_TOLERANCE } from "./engine.js";
import { recipeEditor } from "./recipeEditor.js";
import { toPlan, fromPlan, toDynExport } from "./topology.js";
import { esc, iconImg } from "./dom.js";
import { initShell, updateShell, updateInspector, renderPlanManager as renderPlanManagerShell } from "./shell/index.js";
import { cloneValue, withBoundaryNodes, applyBoxToParentFrame } from "./componentNav.js";
import { dialog } from "./dialog.js";
import { initFontSettings } from "./fontSettings.js";
import { initSidebarResize } from "./sidebarResize.js";
import { choosePlanIcon, normalizePlanIcon } from "./planIcon.js";
import { openSupplyScan } from "./supplyScan.js";
import { downloadJson, selectJson, exportBackup, importBackup } from "./backup.js";
import { validateBackup } from "./browserStorage.js";
import { isPages } from "./storageMode.js";


const CURRENT_PLAN_COOKIE = "zmd_current_plan_id";
const READ_ONLY_MESSAGE = "当前为查看模式，请先点击“编辑内部”";

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!entry) return "";
  try { return decodeURIComponent(entry.slice(prefix.length)); }
  catch { return ""; }
}

function writeCookie(name, value) {
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function deleteCookie(name) {
  document.cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/; SameSite=Lax`;
}

class UI {
  constructor() {
    this.facilityFilter = "";
    this.searchText = "";
    this.showAllFilling = false; // 是否显示全部灌装配方（默认只保留蓝铁瓶/赤铜瓶灌装）
    this.currentSel = null;
    this.currentEdge = null;
    this.currentPlanId = null;
    this.currentPlanIcon = "";
    this._pendingComponent = null;
    this.editingComponent = null; // 当前内部视图上下文；null 表示普通方案画布
    this._canvasStack = [];
    this._recentKeys = this._loadRecent();
    this.snapToGrid = this._loadSnapToGrid();
    this.showCardDemand = this._loadBooleanSetting("zmd_show_card_demand", true);
    this.showEdgeWeight = this._loadBooleanSetting("zmd_show_edge_weight", true);
    this._planLoadRequest = 0;
    this._planManagerRequest = 0;
    this.planView = "list";
    try { if (localStorage.getItem("zmd_plan_view") === "grid") this.planView = "grid"; } catch { /* 默认列表。 */ }
  }

  init() {
    initShell(this._shellActions());
    initSidebarResize();
    this._bindModals();
    this._bindStaticActions();
    this._bindGlobalShortcuts();
    this._bindCanvasTools();
    this._bindPlanManager();

    graph.onSelect = (st) => {
      this.currentSel = st;
      if (st) this.currentEdge = null;
      this.renderInspector();
    };
    graph.onConnectionSelect = (edge) => {
      this.currentEdge = edge;
      if (edge) this.currentSel = null;
      this.renderInspector();
    };
    graph.onToast = (text, cls) => this.toast(text, cls);
    graph.onOpenBlackbox = (st) => this.openBlackboxInternal(st);
    graph.onGroupBlackbox = () => this.openBlackboxModal();
    graph.onHistoryChange = ({ canUndo, canRedo }) => {
      const undoButton = document.getElementById("btnUndo");
      const redoButton = document.getElementById("btnRedo");
      if (undoButton) undoButton.disabled = !canUndo;
      if (redoButton) redoButton.disabled = !canRedo;
    };
    graph.onChange = (res) => {
      this.updateWarnBadge(res);
      if (this.currentSel) this.renderInspector();
      if (!document.getElementById("prodTableModal").hidden) this.renderProdTable();
    };

    recipeEditor.init({ onSaved: () => this.renderCatalog() });

    this.renderFacilityChips();
    this.renderCatalog();
    this.renderComponents();
    this._restoreCurrentPlan();
  }

  _shellActions() {
    return {
      topbar: {
        openSupplyScan,
        chooseIcon: () => this.changeCurrentPlanIcon(),
        newPlan: () => this.newPlan(),
        openPlans: () => this.openPlanManager(),
        savePlan: () => this.savePlan(),
        batchRecipes: () => recipeEditor.open(),
        openProduction: () => this.openProdTable(),
        groupBlackbox: () => this.openBlackboxModal(),
        exportPng: () => this.exportPng(),
        exportDyn: () => this.exportDyn(),
        exportPlan: () => this.exportPlanJson(),
        importPlan: () => this.importPlanJson(),
        exportBackup: () => this.exportAllData(),
        importBackup: () => this.importAllData(),
        openPalette: () => document.dispatchEvent(new CustomEvent("zmd-open-palette")),
      },
      catalog: {
        setCatalogSearch: (value) => { this.searchText = value.trim().toLowerCase(); this.renderCatalog(); },
        setFacilityFilter: (value) => { this.facilityFilter = value; this.renderCatalog(); },
        setShowAllFilling: (value) => { this.showAllFilling = !!value; this.renderCatalog(); },
        useRecipe: (recipe) => {
          if (this._canEditCanvas()) this._useRecipe(recipe);
        },
        addElement: (kind) => {
          if (!this._canEditCanvas()) return;
          if (kind === "source") graph.addSource();
          else if (kind === "sink") graph.addSink();
          else if (kind === "merger") graph.addMerger();
          else if (kind === "portal") graph.addPortalPair();
        },
        addComponent: (component) => {
          if (this._canEditCanvas()) graph.addBlackbox(component);
        },
        editComponent: (component) => this.openComponentForEdit(component),
        deleteComponent: async (component) => {
          if (!await dialog.confirm(`删除组件「${component.name || "未命名组件"}」？`, { title: "删除组件", danger: true })) return;
          try { await api.deleteComponent(component.id); await this.renderComponents({ refresh: true }); }
          catch (err) { this.toast("删除失败：" + err.message, "err"); }
        },
      },
      inspector: {
        rename: (value, commit) => {
          if (this.currentSel) graph.setNodeLabel(this.currentSel.id, value, commit);
        },
        setEdgeStyle: (patch, commit) => graph.setSelectedConnectionStyle(patch, commit),
        activate: (action, data) => {
          const node = this.currentSel;
          if (!node) return;
          if (action === "delete") graph.removeNode(node.id);
          else if (action === "open-internal") this.openBlackboxInternal(node);
          else if (action === "portal-repair") graph.repairPortalPair(node.id);
          else if (action === "source-output-add") graph.addSourceOutput(node.id);
          else if (action === "source-output-remove") graph.removeSourceOutput(node.id, Number(data.index));
          else if (action === "focus-node") graph.focusNode(data.nodeId);
        },
      },
      balance: {
        focusItem: (itemId) => {
          if (!graph.focusItem(itemId)) this.toast("画布中没有使用该物品的节点", "err");
        },
      },
      planManager: {
        chooseIcon: (id) => this.changeSavedPlanIcon(id),
        open: (id) => this.loadPlan(id),
        rename: (id, name) => this.renamePlan(id, name),
        duplicate: (id, name) => this.duplicatePlan(id, name),
        delete: (id, name) => this.deletePlanFromManager(id, name),
      },
    };
  }

  _syncCatalogShell() {
    const visibleRecipes = recipes.getAll().filter((recipe) => this._matches(recipe));
    const recentRecipes = !this.searchText && !this.facilityFilter
      ? this._recentKeys.map((key) => recipes.getByKey(key)).filter(Boolean)
      : [];
    updateShell({
      catalog: {
        facilities: recipes.getFacilities(),
        allRecipes: recipes.getAll(),
        visibleRecipes,
        recentRecipes,
        facilityFilter: this.facilityFilter,
        searchText: this.searchText,
        showAllFilling: this.showAllFilling,
        components: this._components || [],
      },
    });
  }

  // ---------------- 通用 ----------------
  _setPlanIcon(itemId) {
    this.currentPlanIcon = normalizePlanIcon(itemId);
    updateShell({ planIcon: this.currentPlanIcon });
  }

  async changeCurrentPlanIcon() {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    const selected = await choosePlanIcon(this.currentPlanIcon);
    if (selected !== null) this._setPlanIcon(selected);
  }

  async changeSavedPlanIcon(id) {
    const selected = await choosePlanIcon(this._plans?.find(plan => plan.id === id)?.icon_item_id);
    if (selected === null) return;
    try {
      const plan = await api.getPlan(id);
      plan.meta = { ...plan.meta, icon_item_id: selected };
      await api.updatePlan(id, plan);
      if (this.currentPlanId === id) this._setPlanIcon(selected);
      await this.openPlanManager();
      this.toast("方案图标已更新", "ok");
    } catch (err) { this.toast("更换图标失败：" + err.message, "err"); }
  }

  toast(text, cls) {
    const el = document.getElementById("toast");
    el.textContent = text;
    el.className = "toast" + (cls ? " " + cls : "");
    el.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.hidden = true; }, 2400);
  }

  _bindModals() {
    document.querySelectorAll("[data-close]").forEach((el) => {
      el.addEventListener("click", () => { document.getElementById(el.getAttribute("data-close")).hidden = true; });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") document.querySelectorAll(".modal").forEach((m) => { m.hidden = true; });
    });
  }

  _bindStaticActions() {
    const bind = (id, handler) => document.getElementById(id)?.addEventListener("click", handler);
    bind("btnConfirmBlackbox", () => this.confirmBlackbox());
    bind("btnSaveComponent", () => this.saveComponent());
    bind("btnBeginInternalEdit", () => this.beginInternalEdit());
    bind("btnExitComponentEdit", () => this.exitComponentEdit());
  }

  _bindGlobalShortcuts() {
    document.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== "KeyS") return;
      event.preventDefault();
      if (document.querySelector(".modal:not([hidden])")) return;
      event.stopPropagation();
      this.savePlan();
    }, true);
  }

  _canEditCanvas() {
    if (!graph.readOnly) return true;
    this.toast(READ_ONLY_MESSAGE, "err");
    return false;
  }

  _bindCanvasTools() {
    initFontSettings(graph);
    document.getElementById("btnZoomIn").addEventListener("click", () => graph.zoomIn());
    document.getElementById("btnZoomOut").addEventListener("click", () => graph.zoomOut());
    document.getElementById("btnZoomReset").addEventListener("click", () => graph.zoomReset());
    document.getElementById("btnUndo")?.addEventListener("click", () => graph.undo());
    document.getElementById("btnRedo")?.addEventListener("click", () => graph.redo());
    document.getElementById("btnAddBoard").addEventListener("click", () => {
      if (graph.readOnly) { this.toast(READ_ONLY_MESSAGE, "err"); return; }
      graph.addBoard();
    });

    const snapButton = document.getElementById("btnSnapGrid");
    const applySnapState = () => {
      graph.setSnapToGrid(this.snapToGrid);
      snapButton.classList.toggle("active", this.snapToGrid);
      snapButton.setAttribute("aria-pressed", String(this.snapToGrid));
      snapButton.title = `对齐到网格：${this.snapToGrid ? "已开启" : "已关闭"}`;
    };
    applySnapState();
    snapButton.addEventListener("click", () => {
      this.snapToGrid = !this.snapToGrid;
      this._saveSnapToGrid();
      applySnapState();
      this.toast(`对齐到网格已${this.snapToGrid ? "开启" : "关闭"}`);
    });

    const applyDisplayOptions = () => {
      graph.setDisplayOptions({
        showCardDemand: this.showCardDemand,
        showEdgeWeight: this.showEdgeWeight,
      });
      const demandButton = document.getElementById("btnShowDemand");
      demandButton.classList.toggle("active", this.showCardDemand);
      demandButton.setAttribute("aria-pressed", String(this.showCardDemand));
      demandButton.title = `卡片需求数字：已${this.showCardDemand ? "显示" : "隐藏"}`;
      const weightButton = document.getElementById("btnShowWeight");
      weightButton.classList.toggle("active", this.showEdgeWeight);
      weightButton.setAttribute("aria-pressed", String(this.showEdgeWeight));
      weightButton.title = `路径分配设置：已${this.showEdgeWeight ? "显示" : "隐藏"}`;
    };
    applyDisplayOptions();
    document.getElementById("btnShowDemand").addEventListener("click", () => {
      this.showCardDemand = !this.showCardDemand;
      this._saveBooleanSetting("zmd_show_card_demand", this.showCardDemand);
      applyDisplayOptions();
      this.toast(`卡片需求数字已${this.showCardDemand ? "显示" : "隐藏"}`);
    });
    document.getElementById("btnShowWeight").addEventListener("click", () => {
      this.showEdgeWeight = !this.showEdgeWeight;
      this._saveBooleanSetting("zmd_show_edge_weight", this.showEdgeWeight);
      applyDisplayOptions();
      this.toast(`路径分配设置已${this.showEdgeWeight ? "显示" : "隐藏"}`);
    });

    document.getElementById("btnClear").addEventListener("click", async () => {
      if (graph.readOnly) { this.toast(READ_ONLY_MESSAGE, "err"); return; }
      if (await dialog.confirm("确定清空当前画布？未保存的内容将丢失。", { title: "清空画布", danger: true })) graph.clear();
    });
  }

  // ---------------- 配方目录 ----------------
  renderFacilityChips() {
    this._syncCatalogShell();
  }

  _matches(rec) {
    // 默认隐藏灌装配方（保留可进一步做成成品的蓝铁瓶/赤铜瓶灌装）与拆解配方，同一开关控制
    if (!this.showAllFilling && ((rec.filling && !rec.fillingKeep) || rec.dismantle)) return false;
    if (this.facilityFilter && rec.catalog_facility_id !== this.facilityFilter) return false;
    if (!this.searchText) return true;
    // 多关键词：空格分隔，全部命中才算匹配
    const terms = this.searchText.split(/\s+/).filter(Boolean);
    return terms.every((t) => this._matchTerm(rec, t));
  }

  _matchTerm(rec, t) {
    if (rec.recipe_name.toLowerCase().includes(t)) return true;
    if ((rec.page_name_cn || "").toLowerCase().includes(t)) return true;
    if ((rec.facility_name_cn || "").toLowerCase().includes(t)) return true;
    for (const p of [...rec.inputs, ...rec.outputs]) {
      if ((p.name_cn || "").toLowerCase().includes(t) || (p.item_id || "").toLowerCase().includes(t)) return true;
    }
    return false;
  }

  // ---- 最近使用（localStorage 持久化） ----
  _loadRecent() {
    try { return JSON.parse(localStorage.getItem("zmd_recent_recipes") || "[]"); }
    catch { return []; }
  }
  _recordRecent(key) {
    if (!key) return;
    this._recentKeys = [key, ...this._recentKeys.filter((k) => k !== key)].slice(0, 8);
    try { localStorage.setItem("zmd_recent_recipes", JSON.stringify(this._recentKeys)); } catch { /* 忽略存储失败 */ }
  }
  _loadSnapToGrid() {
    try { return localStorage.getItem("zmd_snap_to_grid") === "1"; }
    catch { return false; }
  }
  _saveSnapToGrid() {
    try { localStorage.setItem("zmd_snap_to_grid", this.snapToGrid ? "1" : "0"); }
    catch { /* 忽略存储失败 */ }
  }
  _loadBooleanSetting(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value === "1";
    } catch { return fallback; }
  }
  _saveBooleanSetting(key, value) {
    try { localStorage.setItem(key, value ? "1" : "0"); }
    catch { /* 忽略存储失败 */ }
  }
  _useRecipe(rec) {
    if (!rec) return;
    this._recordRecent(rec.key);
    graph.addRecipeNode(rec);
    this.renderCatalog();
  }

  renderCatalog() {
    this._syncCatalogShell();
  }

  // ---------------- 组件库 ----------------
  async renderComponents({ refresh = false } = {}) {
    if (!refresh && Array.isArray(this._components)) {
      this._syncCatalogShell();
      return;
    }
    try { this._components = await api.listComponents(); }
    catch { this._components = []; }
    this._syncCatalogShell();
  }

  // ---------------- 内部视图（进入 → 查看/编辑 → 保存 → 返回） ----------------
  _clone(value) {
    return cloneValue(value);
  }

  _pushCanvasFrame(targetNodeId = null) {
    this._canvasStack.push({
      snapshot: graph.captureSnapshot(),
      currentPlanId: this.currentPlanId,
      planName: document.getElementById("planName").value,
      context: this.editingComponent,
      targetNodeId: targetNodeId == null ? null : String(targetNodeId),
    });
  }

  _internalSignature(name) {
    const internal = graph.serializeInternal();
    return JSON.stringify({ name, nodes: internal.nodes, edges: internal.edges, boards: internal.boards });
  }

  _withBoundaryNodes(context, internal) {
    return withBoundaryNodes(context, internal);
  }

  _loadInternalContext(context, internal) {
    const augmented = this._withBoundaryNodes(context, internal);
    graph.setReadOnly(false);
    graph.loadFromNodesEdges(augmented.nodes, augmented.edges, augmented.boards);
    this.editingComponent = context;
    graph.setReadOnly(context.mode === "view");
    graph.resetHistory();
    context.baseline = this._internalSignature(context.name);
    this.currentSel = null;
    this._updateComponentEditBar();
  }

  // 组件库入口默认直接编辑；父画布会进入导航栈，返回时完整恢复。
  openComponentForEdit(comp) {
    this._pushCanvasFrame(null);
    const internal = comp.internal || { nodes: [], edges: [] };
    this._loadInternalContext({
      kind: "library",
      id: comp.id,
      name: comp.name || "未命名组件",
      originalBox: this._clone(comp),
      mode: "edit",
    }, internal);
    this.toast(`正在编辑组件「${comp.name || "未命名组件"}」`, "ok");
  }

  // 方案节点入口默认只读查看，避免误改；用户可在顶部明确切换到编辑。
  openBlackboxInternal(st) {
    const internal = st && st.box && st.box.internal || { nodes: [], edges: [] };
    this._pushCanvasFrame(st.id);
    this._loadInternalContext({
      kind: "instance",
      id: st.component_id || null,
      name: st.box.name || st.label || "未命名模块",
      originalBox: this._clone(st.box),
      mode: "view",
    }, internal);
    this.toast(`已进入「${st.box.name || st.label}」内部`, "ok");
  }

  beginInternalEdit() {
    if (!this.editingComponent || this.editingComponent.mode === "edit") return;
    this.editingComponent.mode = "edit";
    graph.setReadOnly(false);
    this._updateComponentEditBar();
  }

  _buildSavedBox(name) {
    const context = this.editingComponent;
    const original = this._clone(context.originalBox || {});
    const productionModule = original.component_kind === "production" ||
      (Array.isArray(original.embedded_inputs) && original.embedded_inputs.length > 0);
    let box;
    if (productionModule) {
      // 系统折叠生产保留明确的输入/输出契约，避免同物品既输入又输出时被净额算法覆盖。
      box = original;
      box.name = name;
      box.internal = graph.serializeInternal();
    } else {
      box = graph.buildComponentFromAll(name);
      box.id = original.id;
      if (original.embedded_inputs) box.embedded_inputs = original.embedded_inputs;
    }
    return box;
  }

  _applyBoxToParentFrame(frame, box) {
    return applyBoxToParentFrame(frame, box);
  }

  async saveComponent() {
    const context = this.editingComponent;
    if (!context || context.mode !== "edit") return;
    const name = document.getElementById("componentEditName").value.trim() || "未命名组件";
    let box;
    try { box = this._buildSavedBox(name); }
    catch (err) { this.toast(err.message, "err"); return; }

    try {
      if (context.kind === "library") {
        await api.updateComponent(context.id, box);
        await this.renderComponents({ refresh: true });
      } else {
        const disconnected = this._applyBoxToParentFrame(this._canvasStack.at(-1), box);
        if (disconnected) this.toast(`内部接口已更新，父画布有 ${disconnected} 条失效连线被移除`, "err");
      }
      context.name = name;
      context.originalBox = this._clone(box);
      context.baseline = this._internalSignature(name);
      this._updateComponentEditBar();
      this.toast(`「${name}」内部结构已保存`, "ok");
    } catch (err) {
      this.toast("保存失败：" + err.message, "err");
    }
  }

  async exitComponentEdit() {
    const context = this.editingComponent;
    if (!context) return;
    const currentName = document.getElementById("componentEditName").value.trim() || "未命名组件";
    const dirty = context.mode === "edit" && this._internalSignature(currentName) !== context.baseline;
    if (dirty && !await dialog.confirm("内部结构有未保存的修改，确定放弃并返回上一级？", { title: "放弃修改", danger: true })) return;
    const frame = this._canvasStack.pop();
    if (!frame) return;
    graph.setReadOnly(false);
    graph.restoreSnapshot(frame.snapshot);
    graph.resetHistory();
    this.editingComponent = frame.context || null;
    this.currentPlanId = frame.currentPlanId;
    document.getElementById("planName").value = frame.planName || "未命名方案";
    if (this.editingComponent) graph.setReadOnly(this.editingComponent.mode === "view");
    this.currentSel = null;
    this._updateComponentEditBar();
    this.toast("已返回上一级画布", "ok");
  }

  _updateComponentEditBar() {
    const bar = document.getElementById("componentEditBar");
    if (!bar) return;
    const context = this.editingComponent;
    bar.hidden = !context;
    if (!context) return;
    const input = document.getElementById("componentEditName");
    input.value = context.name;
    input.disabled = context.mode === "view";
    document.getElementById("componentBreadcrumb").textContent =
      `${this._canvasStack.length > 1 ? "内部模块" : "方案"} › ${context.name}`;
    const badge = document.getElementById("internalModeBadge");
    badge.textContent = context.mode === "view" ? "查看" : "编辑";
    badge.classList.toggle("editing", context.mode === "edit");
    document.getElementById("btnBeginInternalEdit").hidden = context.mode === "edit";
    document.getElementById("btnSaveComponent").hidden = context.mode !== "edit";
  }

  // ---------------- 检查器 ----------------
  renderInspector() {
    const node = this.currentSel;
    if (this.currentEdge) {
      updateInspector({ type: "connection", ...this.currentEdge }, this._edgeInspectorHtml(this.currentEdge));
      return;
    }
    const lastResult = graph.getLastResult();
    const result = node && lastResult ? lastResult.nodes.get(node.id) : null;
    updateInspector(node, node ? this._inspectorHtml(node, result) : "");
  }

  _edgeInspectorHtml(edge) {
    const color = edge.color || "#f5b301";
    const width = Number.isFinite(Number(edge.width)) ? Number(edge.width) : 2.4;
    return `<div class="insp-head"><span class="ih-icon edge-inspector-icon">↝</span>` +
      `<div><div class="ih-title">连线外观</div><div class="ih-sub">${esc(edge.fromLabel)} → ${esc(edge.toLabel)}</div></div></div>` +
      `<div class="insp-block"><h4>颜色</h4><div class="edge-color-controls">` +
      `<input type="color" value="${esc(color)}" data-role="edge-color" aria-label="连线颜色">` +
      `<button class="btn btn-secondary btn-small" data-act="edge-color-default">按物料自动着色</button></div>` +
      `<div class="edge-color-presets">${["#f5b301", "#3b82f6", "#22c55e", "#ef4444", "#a78bfa", "#f8fafc"].map((value) =>
        `<button type="button" data-act="edge-color-preset" data-color="${value}" style="--preset-color:${value}" title="${value}"></button>`
      ).join("")}</div></div>` +
      `<div class="insp-block"><h4>粗细</h4><div class="edge-width-controls">` +
      `<input type="range" min="1" max="12" step="0.5" value="${width}" data-role="edge-width">` +
      `<output>${fmt(width)} px</output></div>` +
      `<button class="btn btn-secondary btn-small" data-act="edge-width-default">恢复默认粗细</button></div>`;
  }

  _inspectorHtml(st, res) {
    const eff = res ? fmt(res.effectiveSpeed) : "–";
    let head = "";
    let blocks = "";

    if (st.boundary) {
      const isInput = st.boundary === "input";
      const ports = isInput ? (st.source_outputs || []) : (st.sink_inputs || []);
      head = `<div class="insp-head"><span class="ih-icon boundary-icon">${isInput ? "▶" : "▣"}</span>` +
        `<div><div class="ih-title">${isInput ? "模块输入" : "模块输出"}</div>` +
        `<div class="ih-sub">固定边界卡片，随模块接口自动生成</div></div></div>`;
      blocks += `<div class="insp-block"><h4>${isInput ? "输入物品" : "输出物品"}</h4>` +
        (ports.length ? ports.map((port) =>
          `<div class="insp-row"><span class="k">${esc(recipes.itemName(port.item_id))}</span>` +
          `<span class="v">${fmt(port.rate)} /分</span></div>`
        ).join("") : '<div class="muted">没有对外端口</div>') + `</div>`;
    } else if (st.type === "machine") {
      const rec = st.recipe;
      const headItem = (rec.outputs[0] && rec.outputs[0].item_id) || (rec.inputs[0] && rec.inputs[0].item_id);
      const kindSub = rec.temporary ? " · 临时" : (rec.special ? " · 特殊" : "");
      const recipeSub = rec.duplicateName ? `${rec.recipe_name} · ` : "";
      head = `<div class="insp-head">${iconImg(headItem, "ih-icon")}` +
        `<div><div class="ih-title">${esc(st.label || rec.displayName || rec.recipe_name)}</div><div class="ih-sub">${esc(recipeSub + rec.facility_name_cn)} · ${fmt(rec.time_sec)}s${kindSub}</div></div></div>`;
      blocks += `<div class="insp-block"><h4>运行</h4>` +
        `<div class="insp-row"><span class="k">设定速度</span><span class="v">${esc(st.speed)}×</span></div>` +
        `<div class="insp-row"><span class="k">自动降速</span><span class="v">${st.auto_slow ? "开" : "关"}</span></div>` +
        `<div class="insp-row"><span class="k">有效速度</span><span class="v ${res && res.effectiveSpeed < parseFloat(st.speed || 1) - 1e-6 ? "warn" : "ok"}">${eff}×</span></div></div>`;
      blocks += this._ioBlock(res);
    } else if (st.type === "source") {
      const outputs = Array.isArray(st.source_outputs)
        ? st.source_outputs
        : [{ item_id: st.source_item || "", rate: st.source_rate || "0" }];
      const firstItem = outputs.find((output) => output.item_id);
      head = `<div class="insp-head">${iconImg(firstItem ? firstItem.item_id : "", "ih-icon")}` +
        `<div><div class="ih-title">${esc(st.label || "固定源")}</div><div class="ih-sub">${outputs.length} 路输出 · 空端点连接后自动识别物品</div></div></div>`;
      const rows = outputs.map((output, i) => {
        const prod = res && res.outputs[i] ? fmt(res.outputs[i].production) : fmt(Number(output.rate) || 0);
        const itemName = output.item_id ? esc(recipes.itemName(output.item_id)) : "空端点（等待连接）";
        return `<div class="insp-source-output"><div class="insp-source-output-head">` +
          `<span>输出 ${i + 1}</span><button class="insp-icon-btn danger" type="button" data-act="source-output-remove" data-index="${i}" title="删除此输出">删除</button></div>` +
          `<div class="insp-row"><span class="k">产物</span><span class="v ${output.item_id ? "" : "muted"}">${itemName}</span></div>` +
          `<div class="insp-row"><span class="k">速率</span><span class="v">${prod} /分</span></div></div>`;
      }).join("");
      blocks += `<div class="insp-block"><div class="insp-block-title"><h4>输出</h4>` +
        `<button class="btn btn-small" type="button" data-act="source-output-add">＋ 添加输出</button></div>` +
        `${rows || '<div class="muted">暂无输出</div>'}</div>`;
    } else if (st.type === "sink") {
      const sinkTitle = st.label || "最终产物箱";
      head = `<div class="insp-head"><span class="ih-icon sink-icon">▣</span>` +
        `<div><div class="ih-title">${esc(sinkTitle)}</div><div class="ih-sub">${sinkTitle.includes("丢弃") ? "收集可直接排出的副产物" : "收集该模块最终产出"}</div></div></div>`;
      const rows = (res && res.inflow.length)
        ? res.inflow.map((x) => `<div class="insp-row"><span class="k">${esc(recipes.itemName(x.item_id))}</span><span class="v ok">${fmt(x.rate)} /分</span></div>`).join("")
        : '<div class="muted">暂无流入</div>';
      blocks += `<div class="insp-block"><h4>累计流入</h4>${rows}</div>`;
    } else if (st.type === "merger") {
      const itemName = st.item_id ? recipes.itemName(st.item_id) : "尚未确定";
      const throughput = res ? (res.throughput || 0) : 0;
      const demand = res && res.outputs[0] ? res.outputs[0].demand : 0;
      head = `<div class="insp-head"><span class="ih-icon merger-inspector-icon">⇄</span>` +
        `<div><div class="ih-title">${esc(st.label || "汇流分配器")}</div>` +
        `<div class="ih-sub">汇合相同物料，并按路径模式分配</div></div></div>`;
      blocks += `<div class="insp-block"><h4>当前状态</h4>` +
        `<div class="insp-row"><span class="k">物料</span><span class="v ${st.item_id ? "ok" : "muted"}">${esc(itemName)}</span></div>` +
        `<div class="insp-row"><span class="k">汇入总量</span><span class="v">${fmt(throughput)} /分</span></div>` +
        `<div class="insp-row"><span class="k">下游需求</span><span class="v">${fmt(demand)} /分</span></div></div>` +
        `<div class="insp-block"><div class="muted">同一输出先分固定目标，再按优先级分配，剩余按权重分配；点击连线流量数字可设置模式和上限。</div></div>`;
    } else if (st.type === "portal_in" || st.type === "portal_out") {
      const isInput = st.type === "portal_in";
      const itemName = st.item_id ? recipes.itemName(st.item_id) : "尚未确定";
      const rate = isInput
        ? (res && res.inputs[0] ? res.inputs[0].supply : 0)
        : (res && res.outputs[0] ? res.outputs[0].production : 0);
      head = `<div class="insp-head"><span class="ih-icon portal-inspector-icon">${isInput ? "↘" : "↗"}</span>` +
        `<div><div class="ih-title">${esc(st.label || (isInput ? "传送门入口" : "传送门出口"))}</div>` +
        `<div class="ih-sub">${isInput ? "接收输入并传送" : "输出配对入口的物料"}</div></div></div>`;
      blocks += `<div class="insp-block"><h4>传送状态</h4>` +
        `<div class="insp-row"><span class="k">物料</span><span class="v ${st.item_id ? "ok" : "muted"}">${esc(itemName)}</span></div>` +
        `<div class="insp-row"><span class="k">${isInput ? "传入" : "传出"}</span><span class="v">${fmt(rate)} /分</span></div>` +
        `<div class="insp-row"><span class="k">配对</span><span class="v ${st.portal_connected ? "ok" : "warn"}">${st.portal_connected ? "已连接" : "连接已删除"}</span></div></div>`;
      if (!st.portal_connected && !graph.readOnly) {
        blocks += `<button class="btn btn-primary btn-block" data-act="portal-repair">重新创建配对卡片</button>`;
      }
    } else if (st.type === "blackbox") {
      const foldedProcess = st.box.component_kind === "production";
      const internalCount = st.box.internal && Array.isArray(st.box.internal.nodes) ? st.box.internal.nodes.length : 0;
      const blackboxSub = foldedProcess
        ? `折叠生产 · ${internalCount} 台机器 · ${(st.box.external_inputs || []).length} 种外部输入`
        : `组件 · ${internalCount} 台机器`;
      head = `<div class="insp-head"><span class="ih-icon blackbox-icon">◧</span>` +
        `<div><div class="ih-title">${esc(st.label || st.box.name)}</div><div class="ih-sub">${esc(blackboxSub)}</div></div></div>`;
      if (!foldedProcess) {
        blocks += `<div class="insp-block"><h4>运行</h4>` +
          `<div class="insp-row"><span class="k">设定速度</span><span class="v">${esc(st.speed)}×</span></div>` +
          `<div class="insp-row"><span class="k">有效速度</span><span class="v">${eff}×</span></div></div>`;
      }
      blocks += `<button class="btn btn-primary btn-block" data-act="open-internal">` +
        `${internalCount ? "查看内部结构" : "打开空内部画布"}</button>`;
      blocks += this._ioBlock(res);
    }

    const nameBlock = st.boundary ? "" :
      `<div class="insp-block"><h4>卡片名称</h4>` +
      `<input class="input" data-role="card-name" type="text" maxlength="80" ` +
      `value="${esc(st.label || "")}" placeholder="留空恢复默认名称" spellcheck="false" ${graph.readOnly ? "disabled" : ""} />` +
      `<div class="muted insp-field-hint">仅修改当前卡片显示名称，不改变配方和计算。</div></div>`;
    blocks += this._connectionBlock(st.id);
    const deleteButton = graph.readOnly || st.boundary
      ? ""
      : `<button class="btn btn-danger btn-block" data-act="delete">删除节点</button>`;
    return head + nameBlock + blocks + deleteButton;
  }

  _connectionBlock(nodeId) {
    const connections = graph.getConnectedEdges(nodeId);
    const renderGroup = (direction, title, arrow) => {
      const items = connections.filter((connection) => connection.direction === direction);
      if (!items.length) return "";
      return `<div class="insp-connection-group"><div class="insp-connection-title">${title}<span>${items.length}</span></div>` +
        items.map((connection) => {
          const itemName = connection.itemId ? recipes.itemName(connection.itemId) : "物料未确定";
          const portText = direction === "in"
            ? `对方输出 ${connection.fromPort + 1} → 本卡输入 ${connection.toPort + 1}`
            : `本卡输出 ${connection.fromPort + 1} → 对方输入 ${connection.toPort + 1}`;
          const weightText = `<span class="insp-connection-weight">${esc(flowRuleLabel(connection, fmt))}</span>`;
          return `<button class="insp-connection ${connection.warn ? "warn" : ""}" type="button" data-act="focus-node" data-node-id="${esc(connection.peerId)}" title="点击定位相连卡片">` +
            `<span class="insp-connection-arrow">${arrow}</span>` +
            `<span class="insp-connection-main"><span class="insp-connection-peer">${esc(connection.peerLabel)}</span>` +
            `<span class="insp-connection-meta">${esc(itemName)} · ${fmt(connection.rate)} /分 · ${portText}</span></span>` +
            weightText + `</button>`;
        }).join("") + `</div>`;
    };
    const groups = renderGroup("in", "流入连线", "←") + renderGroup("out", "流出连线", "→");
    return `<div class="insp-block insp-connections"><h4>相连连线</h4>` +
      (groups || '<div class="muted">当前卡片没有连线</div>') + `</div>`;
  }

  _ioBlock(res) {
    if (!res) return "";
    let html = "";
    if (res.inputs && res.inputs.length) {
      html += `<div class="insp-block"><h4>输入（供给/需求）</h4>` +
        res.inputs.map((p) =>
          `<div class="insp-row"><span class="k">${esc(recipes.itemName(p.item_id))}</span>` +
          `<span class="v ${p.warn ? "warn" : "ok"}">${fmt(p.supply)} / ${fmt(p.required)}</span></div>`
        ).join("") + `</div>`;
    }
    if (res.outputs && res.outputs.length) {
      html += `<div class="insp-block"><h4>输出（产出/下游需求）</h4>` +
        res.outputs.map((p) =>
          `<div class="insp-row"><span class="k">${esc(recipes.itemName(p.item_id))}</span>` +
          `<span class="v ${p.warn ? "warn" : ""}">${fmt(p.production)} / ${fmt(p.demand)}</span></div>`
        ).join("") + `</div>`;
    }
    return html;
  }

  updateWarnBadge(res) {
    updateShell({ lastResult: res || null, warnCount: res ? res.warnCount : 0 });
  }

  // ---------------- 产消表 ----------------
  openProdTable() { this.renderProdTable(); document.getElementById("prodTableModal").hidden = false; }

  renderProdTable() {
    const res = graph.getLastResult();
    const bal = res ? res.balance : { items: [], finalOutputs: [] };

    const foT = document.getElementById("finalOutputTable");
    foT.querySelector("thead").innerHTML = '<tr><th>物品</th><th class="num">速率 /分</th></tr>';
    foT.querySelector("tbody").innerHTML = bal.finalOutputs.length
      ? bal.finalOutputs.map((x) =>
          `<tr><td><span class="item-cell">${iconImg(x.item_id, "")}${esc(recipes.itemName(x.item_id))}</span></td><td class="num">${fmt(x.rate)}</td></tr>`
        ).join("")
      : '<tr><td colspan="2" class="muted">尚无最终产物箱产出</td></tr>';

    const pT = document.getElementById("prodTable");
    pT.querySelector("thead").innerHTML =
      '<tr><th>物品</th><th class="num">产出</th><th class="num">消耗</th><th class="num">最终产出</th><th class="num">净值</th></tr>';
    pT.querySelector("tbody").innerHTML = bal.items.length
      ? bal.items.map((it) =>
          `<tr class="${it.net < -WARN_TOLERANCE - 1e-6 ? "deficit" : ""}"><td><span class="item-cell">${iconImg(it.item_id, "")}${esc(recipes.itemName(it.item_id))}</span></td>` +
          `<td class="num">${fmt(it.produced)}</td><td class="num">${fmt(it.consumed)}</td>` +
          `<td class="num">${fmt(it.finalOutput)}</td><td class="num">${fmt(it.net)}</td></tr>`
        ).join("")
      : '<tr><td colspan="5" class="muted">画布为空</td></tr>';
  }

  // ---------------- 方案管理 ----------------
  exportPlanJson() {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    downloadJson(toPlan(this._meta(), graph.serializeNodes(), graph.serializeEdges(), graph.serializeBoards()), `${this._meta().name}.json`);
  }

  importPlanJson() {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    selectJson(async plan => {
      if (!plan || !Array.isArray(plan.nodes) || !Array.isArray(plan.edges) ||
          plan.nodes.some(node => !node || typeof node !== "object") ||
          plan.edges.some(edge => !edge || typeof edge !== "object")) throw new Error("方案格式不正确");
      fromPlan(plan);
      plan.meta = { ...plan.meta };
      delete plan.meta.id;
      delete plan.id;
      const saved = await api.createPlan(plan);
      await this.openPlanManager();
      this.toast(`已导入「${saved.meta?.name || "未命名方案"}」，可从方案列表打开`, "ok");
    }, error => this.toast("导入失败：" + error.message, "err"));
  }

  async exportAllData() {
    try {
      downloadJson(await exportBackup(), "endfield-factory-backup.json");
      this.toast("已导出已保存数据；当前画布的修改请先保存方案", "ok");
    } catch (error) { this.toast("备份失败：" + error.message, "err"); }
  }

  importAllData() {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    selectJson(async data => {
      validateBackup(data);
      const suffix = isPages ? "" : "本地模式逐文件写入，失败时可能已导入部分数据，可重新导入。";
      if (!await dialog.confirm(`将合并 ${data.plans.length} 个方案、${data.components.length} 个组件和 ${data.tempRecipes.length} 条临时配方；相同 ID 的已保存内容会被覆盖。建议先导出当前完整备份。当前画布不变。${suffix}`, { title: "导入完整备份", danger: true })) return;
      await importBackup(data);
      await recipes.reloadTemp();
      this.renderFacilityChips();
      this.renderCatalog();
      await this.renderComponents({ refresh: true });
      this.toast("备份已导入，可从方案列表打开", "ok");
    }, error => this.toast("导入失败：" + error.message, "err"));
  }

  _rememberCurrentPlan(id) {
    if (id) writeCookie(CURRENT_PLAN_COOKIE, String(id));
    else deleteCookie(CURRENT_PLAN_COOKIE);
  }

  async _restoreCurrentPlan() {
    const id = readCookie(CURRENT_PLAN_COOKIE);
    if (!id) return;
    await this.loadPlan(id, { restoring: true });
  }

  async newPlan() {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    if (graph.hasContent() && !await dialog.confirm("新建方案会清空当前画布，确定？", { title: "新建方案", danger: true })) return;
    graph.setReadOnly(false);
    graph.clear();
    graph.resetHistory();
    this.currentPlanId = null;
    this._rememberCurrentPlan(null);
    this.editingComponent = null;
    this._canvasStack = [];
    this._updateComponentEditBar();
    document.getElementById("planName").value = "未命名方案";
    this._setPlanIcon("");
    this.toast("已新建空白方案");
  }

  _meta() {
    return { id: this.currentPlanId || undefined, name: document.getElementById("planName").value.trim() || "未命名方案", icon_item_id: this.currentPlanIcon };
  }

  async savePlan() {
    if (this.editingComponent) { this.toast("正在编辑组件，请点「保存组件」写回，或先退出编辑", "err"); return; }
    const plan = toPlan(this._meta(), graph.serializeNodes(), graph.serializeEdges(), graph.serializeBoards());
    try {
      let saved;
      if (this.currentPlanId) saved = await api.updatePlan(this.currentPlanId, plan);
      else saved = await api.createPlan(plan);
      this.currentPlanId = (saved.meta && saved.meta.id) || saved.id || this.currentPlanId;
      this._rememberCurrentPlan(this.currentPlanId);
      this.toast("方案已保存", "ok");
    } catch (err) {
      this.toast("保存失败：" + err.message, "err");
    }
  }

  async loadPlan(id, { restoring = false } = {}) {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    const requestId = ++this._planLoadRequest;
    try {
      const plan = await api.getPlan(id);
      if (requestId !== this._planLoadRequest) return;
      const { meta, nodes, edges, boards } = fromPlan(plan);
      this.editingComponent = null;
      this._canvasStack = [];
      graph.setReadOnly(false);
      this._updateComponentEditBar();
      graph.loadFromNodesEdges(nodes, edges, boards);
      graph.resetHistory();
      this.currentPlanId = meta.id || id;
      this._rememberCurrentPlan(this.currentPlanId);
      document.getElementById("planName").value = meta.name || "未命名方案";
      this._setPlanIcon(meta.icon_item_id);
      document.getElementById("planManagerModal").hidden = true;
      this.toast(restoring ? "已恢复上次方案" : "方案已载入", "ok");
    } catch (err) {
      if (requestId !== this._planLoadRequest) return;
      if (restoring) {
        this._rememberCurrentPlan(null);
        this.toast("上次方案无法恢复，已打开空白画布", "err");
      } else {
        this.toast("载入失败：" + err.message, "err");
      }
    }
  }

  // ---------------- 方案管理页面 ----------------
  _bindPlanManager() {
    for (const [view, id] of [["grid", "btnPlanViewGrid"], ["list", "btnPlanViewList"]]) {
      document.getElementById(id).addEventListener("click", () => {
        this.planView = view;
        try { localStorage.setItem("zmd_plan_view", view); } catch { /* 本次仍生效。 */ }
        this._syncPlanView();
        this.renderPlanManager();
      });
    }
    this._syncPlanView();
    const search = document.getElementById("planManagerSearch");
    if (search) {
      search.addEventListener("input", () => {
        this._planSearch = search.value.trim().toLowerCase();
        this.renderPlanManager();
      });
    }
    const refresh = document.getElementById("btnPlanManagerRefresh");
    if (refresh) refresh.addEventListener("click", () => this.openPlanManager());
  }

  async openPlanManager() {
    if (this.editingComponent) { this.toast("请先返回方案画布", "err"); return; }
    const requestId = ++this._planManagerRequest;
    const search = document.getElementById("planManagerSearch");
    if (search) search.value = "";
    this._planSearch = "";
    this._plans = [];
    document.getElementById("planManagerModal").hidden = false;
    renderPlanManagerShell({ plans: [], loading: true, error: "", searchText: "", currentPlanId: this.currentPlanId, formatTime: (value) => this._fmtTime(value) });
    try {
      const plans = await api.listPlans();
      if (requestId !== this._planManagerRequest) return;
      this._plans = plans.sort((a, b) => {
        const time = (plan) => Date.parse(plan.updated_at || plan.created_at || "") || 0;
        return time(b) - time(a) || String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
      });
      this.renderPlanManager();
    } catch (err) {
      if (requestId !== this._planManagerRequest) return;
      renderPlanManagerShell({ plans: [], loading: false, error: err.message, searchText: "", currentPlanId: this.currentPlanId });
    }
  }

  renderPlanManager() {
    if (!Array.isArray(this._plans)) return;
    const keyword = this._planSearch || "";
    const visibleCount = this._plans.filter((plan) => !keyword || String(plan.name || plan.id).toLowerCase().includes(keyword)).length;
    const countElement = document.getElementById("planManagerCount");
    if (countElement) countElement.textContent = keyword ? `${visibleCount} / ${this._plans.length} 个` : `${this._plans.length} 个`;
    renderPlanManagerShell({ plans: this._plans, loading: false, error: "", searchText: keyword, currentPlanId: this.currentPlanId, view: this.planView, formatTime: (value) => this._fmtTime(value) });
  }

  _syncPlanView() {
    document.getElementById("planManagerGrid").classList.toggle("is-list", this.planView === "list");
    document.getElementById("btnPlanViewGrid").setAttribute("aria-pressed", String(this.planView === "grid"));
    document.getElementById("btnPlanViewList").setAttribute("aria-pressed", String(this.planView === "list"));
  }

  _fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async renamePlan(id, oldName) {
    const name = await dialog.prompt("重命名方案：", { title: "重命名方案", defaultValue: oldName });
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      const plan = await api.getPlan(id);
      plan.meta = plan.meta || {};
      plan.meta.name = trimmed;
      await api.updatePlan(id, plan);
      if (this.currentPlanId === id) document.getElementById("planName").value = trimmed;
      await this.openPlanManager();
      this.toast("已重命名", "ok");
    } catch (err) {
      this.toast("重命名失败：" + err.message, "err");
    }
  }

  async duplicatePlan(id, oldName) {
    try {
      const plan = await api.getPlan(id);
      const copy = JSON.parse(JSON.stringify(plan));
      copy.meta = copy.meta || {};
      delete copy.meta.id;
      delete copy.meta.created_at;
      delete copy.meta.updated_at;
      copy.meta.name = `${oldName} 副本`;
      await api.createPlan(copy);
      await this.openPlanManager();
      this.toast("已创建副本", "ok");
    } catch (err) {
      this.toast("复制失败：" + err.message, "err");
    }
  }

  async deletePlanFromManager(id, name) {
    if (!await dialog.confirm(`删除方案「${name}」？此操作不可恢复。`, { title: "删除方案", danger: true })) return;
    try {
      await api.deletePlan(id);
      if (this.currentPlanId === id) {
        this.currentPlanId = null;
        this._rememberCurrentPlan(null);
      }
      await this.openPlanManager();
      this.toast("已删除", "ok");
    } catch (err) {
      this.toast("删除失败：" + err.message, "err");
    }
  }

  // ---------------- 黑盒组合 ----------------
  openBlackboxModal() {
    if (graph.readOnly) { this.toast(READ_ONLY_MESSAGE, "err"); return; }
    const ids = graph.getMultiSelected();
    if (!ids.length) { this.toast("请先用 Shift 框选或 Ctrl 点选要组合的机器", "err"); return; }
    let comp;
    try { comp = graph.buildComponentFromSelection(""); }
    catch (err) { this.toast(err.message, "err"); return; }
    this._pendingComponent = comp;
    document.getElementById("blackboxName").value = "";
    const inTxt = comp.external_inputs.map((x) => `${recipes.itemName(x.item_id)} ${fmt(x.rate)}/分`).join("、") || "（无）";
    const outTxt = comp.external_outputs.map((x) => `${recipes.itemName(x.item_id)} ${fmt(x.rate)}/分`).join("、") || "（无）";
    document.getElementById("blackboxSummary").innerHTML =
      `包含 <b>${comp.internal.nodes.length}</b> 台机器。<br>对外输入：<b>${esc(inTxt)}</b><br>对外输出：<b>${esc(outTxt)}</b>`;
    document.getElementById("blackboxModal").hidden = false;
  }

  async confirmBlackbox() {
    if (!this._pendingComponent) return;
    const name = document.getElementById("blackboxName").value.trim() || "未命名组件";
    this._pendingComponent.name = name;
    try {
      await api.createComponent(this._pendingComponent);
      await this.renderComponents({ refresh: true });
      graph.clearSelection();
      document.getElementById("blackboxModal").hidden = true;
      this.toast(`已保存组件「${name}」，可在组件库中复用`, "ok");
    } catch (err) {
      this.toast("保存失败：" + err.message, "err");
    }
  }

  // ---------------- 导出画布 PNG ----------------
  async exportPng() {
    const button = document.getElementById("btnExportPng");
    if (button.disabled) return;
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "正在生成…";
    this.toast("正在生成整张画布 PNG…");
    try {
      const result = await graph.renderPng();
      const rawName = (this._meta().name || "工厂产线").trim();
      const safeName = rawName.replace(/[\\/:*?"<>|]+/g, "_").replace(/[. ]+$/g, "") || "工厂产线";
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.toast(`PNG 已导出（${result.width} × ${result.height}）`, "ok");
    } catch (err) {
      this.toast("PNG 导出失败：" + err.message, "err");
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  // ---------------- 导出 zmd_dyn ----------------
  exportDyn() {
    const plan = toDynExport(this._meta(), graph.serializeNodes(), graph.serializeEdges());
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (this._meta().name || "topology") + "_dyn.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast("已导出 zmd_dyn 兼容拓扑", "ok");
  }
}

export const ui = new UI();
