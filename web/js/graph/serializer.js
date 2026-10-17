import { recipes } from "../recipes.js";
import { normalizeFlowRule } from "../flowRules.js";
import { normalizePortOrder } from "./portOrder.js";
import { compute, parseSpeed, fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const serializerMethods = {
  _deepClone(value) {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  },

  captureSnapshot() {
    return {
      nodes: this._deepClone(this.serializeNodes()),
      edges: this._deepClone(this.serializeEdges()),
      boards: this._deepClone(this.serializeBoards()),
      viewport: {
        x: Number(this.editor.canvas_x) || 0,
        y: Number(this.editor.canvas_y) || 0,
        zoom: Number(this.editor.zoom) || 1,
      },
    };
  },

  restoreSnapshot(snapshot) {
    const data = snapshot || { nodes: [], edges: [], boards: [], viewport: null };
    this.loadFromNodesEdges(data.nodes || [], data.edges || [], data.boards || []);
    const viewport = data.viewport;
    if (!viewport) return;
    requestAnimationFrame(() => {
      const zoom = Number(viewport.zoom) || 1;
      this.editor.canvas_x = Number(viewport.x) || 0;
      this.editor.canvas_y = Number(viewport.y) || 0;
      this.editor.zoom = zoom;
      this.editor.precanvas.style.transform =
        `translate(${this.editor.canvas_x}px, ${this.editor.canvas_y}px) scale(${zoom})`;
      this._scheduleGridSync();
      this._refreshPortalLink();
    });
  },

  _buildComponent(ids, name, includedBoards = []) {
    const idSet = new Set(ids);
    const allEdges = this._collectEdges();
    const internalNodes = ids.map((id) => this._serializeNode(id)).filter(Boolean);
    const internalEdges = allEdges.filter((e) => idSet.has(e.from) && idSet.has(e.to));

    const extIn = new Map();  // item -> rate（内部净缺口，需外部供给）
    const extOut = new Map(); // item -> rate（内部净盈余，输出到外部）
    const sub = compute({ nodes: internalNodes.map(this._toModelNode.bind(this)), edges: internalEdges });
    for (const it of sub.balance.items) {
      if (it.net < -1e-6) extIn.set(it.item_id, -it.net);
      else if (it.net > 1e-6) extOut.set(it.item_id, it.net);
    }

    return {
      name: name || "未命名组件",
      external_inputs: [...extIn.entries()].map(([item_id, rate]) => ({ item_id, rate })),
      external_outputs: [...extOut.entries()].map(([item_id, rate]) => ({ item_id, rate })),
      internal: { nodes: internalNodes, edges: internalEdges, boards: includedBoards.map((board) => Object.assign({}, board)) },
    };
  },

  _boardsForNodeSelection(ids) {
    const nodes = ids.map((id) => this._serializeNode(id)).filter(Boolean);
    return this.serializeBoards().filter((board) => nodes.some((node) => {
      const x = Number(node.x) || 0;
      const y = Number(node.y) || 0;
      return x >= board.x && x <= board.x + board.width && y >= board.y && y <= board.y + board.height;
    }));
  },

  buildComponentFromSelection(name) {
    const ids = this.getMultiSelected();
    if (ids.length < 1) throw new Error("请先用 Shift 框选或 Ctrl 点选至少一台机器");
    return this._buildComponent(ids, name, this._boardsForNodeSelection(ids));
  },

  buildComponentFromAll(name) {
    const ids = [...this.state.entries()]
      .filter(([, state]) => !state.boundary)
      .map(([id]) => id);
    if (ids.length < 1) throw new Error("画布上没有任何内部节点");
    return this._buildComponent(ids, name, this.serializeBoards());
  },

  _toModelNode(sn) {
    // 将序列化节点转为 engine 模型节点（用于内部净产消估算）
    const st = this._reviveState(sn);
    this._computePorts(st);
    return { id: sn.id, type: st.type, speed: st.speed, auto_slow: st.auto_slow, pair_id: st.pair_id || null, inputPorts: st.inputPorts, outputPorts: st.outputPorts };
  },

  _serializeNode(id, graphData = null) {
    const st = this.state.get(id);
    if (!st) return null;
    const data = graphData || (this.editor && this.editor.drawflow && this.editor.drawflow.drawflow.Home.data) || {};
    const nd = data[id];
    const x = nd ? nd.pos_x : 0;
    const y = nd ? nd.pos_y : 0;
    const base = { id, type: st.type, label: st.label, x, y, speed: st.speed, auto_slow: !!st.auto_slow };
    const portOrder = normalizePortOrder(st.port_order);
    if (portOrder.length) base.port_order = portOrder;
    if (Number.isFinite(Number(st.card_width)) && Number(st.card_width) > 0) base.card_width = Number(st.card_width);
    if (st.custom_label) base.custom_label = true;
    if (st.marker_color) base.marker_color = st.marker_color;
    if (st.boundary) base.boundary = st.boundary;
    if (st.type === "machine") base.recipe_ref = recipes.makeRef(st.recipe);
    else if (st.type === "source") {
      const outputs = this._normalizeSourceOutputs(st);
      base.source_item = st.source_item;
      base.source_rate = st.source_rate;
      base.source_outputs = outputs.map((output) => ({ item_id: output.item_id, rate: output.rate }));
      base.source_collapsed = !!st.source_collapsed;
    }
    else if (st.type === "sink") {
      base.box_kind = st.box_kind || "final";
      if (Array.isArray(st.sink_inputs)) {
        base.sink_inputs = st.sink_inputs.map((port) => ({ item_id: port.item_id, rate: Number(port.rate) || 0 }));
      }
    }
    else if (st.type === "merger") base.item_id = st.item_id || "";
    else if (st.type === "portal_in" || st.type === "portal_out") {
      base.pair_id = st.pair_id;
      base.item_id = st.item_id || "";
    }
    else if (st.type === "blackbox") { base.component_id = st.component_id; base.box = st.box; }
    base.ports = {
      inputs: (st.inputPorts || []).map((p) => p.item_id),
      outputs: (st.outputPorts || []).map((p) => p.item_id),
    };
    return base;
  },

  serializeNodes() {
    const data = (this.editor && this.editor.drawflow && this.editor.drawflow.drawflow.Home.data) || {};
    return [...this.state.keys()].map((id) => this._serializeNode(id, data)).filter(Boolean);
  },

  serializeEdges() { return this._collectEdges(); },

  serializeInternal() {
    const nodes = this.serializeNodes().filter((node) => !node.boundary);
    const ids = new Set(nodes.map((node) => String(node.id)));
    const edges = this.serializeEdges().filter((edge) => ids.has(String(edge.from)) && ids.has(String(edge.to)));
    return { nodes, edges, boards: this.serializeBoards() };
  },

  _reviveState(sn) {
    const st = {
      id: sn.id, type: sn.type, label: sn.label, speed: sn.speed || "1",
      auto_slow: !!sn.auto_slow, boundary: sn.boundary || null, custom_label: !!sn.custom_label,
      card_width: Number.isFinite(Number(sn.card_width)) && Number(sn.card_width) > 0 ? Number(sn.card_width) : null,
      port_order: normalizePortOrder(sn.port_order),
      marker_color: NODE_MARKER_COLORS.some((color) => color.id === sn.marker_color) ? sn.marker_color : "",
    };
    if (sn.type === "machine") { st.recipe = recipes.resolveRef(sn.recipe_ref); st.recipeKey = st.recipe && st.recipe.key; }
    else if (sn.type === "source") {
      st.source_item = sn.source_item || "";
      st.source_rate = sn.source_rate || "0";
      st.source_outputs = Array.isArray(sn.source_outputs)
        ? sn.source_outputs.map((output) => ({ item_id: output.item_id || "", rate: output.rate == null ? "30" : String(output.rate) }))
        : [{ item_id: st.source_item, rate: st.source_rate }];
      st.source_collapsed = !!sn.source_collapsed;
    }
    else if (sn.type === "sink") {
      st.box_kind = sn.box_kind || "final";
      st.sink_inputs = Array.isArray(sn.sink_inputs)
        ? sn.sink_inputs.map((port) => ({ item_id: port.item_id || null, rate: Number(port.rate) || 0 }))
        : null;
    }
    else if (sn.type === "merger") {
      st.item_id = sn.item_id || (sn.ports && (sn.ports.inputs[0] || sn.ports.outputs[0])) || "";
    }
    else if (sn.type === "portal_in" || sn.type === "portal_out") {
      st.pair_id = sn.pair_id || this._newPortalPairId();
      st.item_id = sn.item_id || (sn.ports && (sn.ports.inputs[0] || sn.ports.outputs[0])) || "";
      st.portal_connected = false;
    }
    else if (sn.type === "blackbox") { st.box = sn.box; st.component_id = sn.component_id; }
    return st;
  },

  loadFromNodesEdges(nodes, edges, boards = []) {
    const restoreReadOnly = this.readOnly;
    const restoreHistoryMuted = this._historyMuted;
    this._historyMuted = true;
    this.setReadOnly(false);
    this._beginBatch();
    try {
      this.clear(true);
      for (const raw of Array.isArray(boards) ? boards : []) {
        const board = this._normalizeBoard(raw || {});
        this.boards.set(board.id, board);
        this._renderBoard(board);
      }
      const idMap = new Map(); // 旧 id -> 新 id
      for (const sn of nodes) {
        const st = this._reviveState(sn);
        if (st.type === "machine" && !st.recipe) continue; // 配方已失效则跳过
        let newId;
        if (st.type === "machine") newId = this.addRecipeNode(st.recipe, sn.x, sn.y);
        else if (st.type === "source") {
          newId = this._register(st, 0, st.source_outputs.length, sn.x, sn.y,
            st.boundary ? "node-boundary node-boundary-input" : "node-source");
        }
        else if (st.type === "sink") {
          newId = st.boundary
            ? this._register(st, st.sink_inputs ? st.sink_inputs.length : 0, 0, sn.x, sn.y, "node-boundary node-boundary-output")
            : this.addSink(sn.x, sn.y);
        }
        else if (st.type === "merger") newId = this._register(st, 1, 1, sn.x, sn.y, "node-merger");
        else if (st.type === "portal_in") newId = this._register(st, 1, 0, sn.x, sn.y, "node-portal-in");
        else if (st.type === "portal_out") newId = this._register(st, 0, 1, sn.x, sn.y, "node-portal-out");
        else if (st.type === "blackbox") newId = this.addBlackbox(st.box, sn.x, sn.y);
        if (newId) {
          const ns = this.state.get(newId);
          ns.speed = st.speed;
          ns.auto_slow = st.auto_slow;
          ns.card_width = st.card_width;
          ns.port_order = st.port_order;
          ns.custom_label = !!st.custom_label;
          ns.label = ns.type === "machine" && !ns.custom_label
            ? this._defaultNodeLabel(ns)
            : (st.label || ns.label);
          ns.marker_color = st.marker_color || "";
          if (ns.type === "source") ns.source_collapsed = !!st.source_collapsed;
          this._rerenderContent(newId);
          idMap.set(sn.id, newId);
        }
      }
      for (const e of edges) {
        const from = idMap.get(e.from);
        const to = idMap.get(e.to);
        if (!from || !to) continue;
        try {
          this.editor.addConnection(from, to, `output_${e.fromPort + 1}`, `input_${e.toPort + 1}`);
          // 还原连线权重（id 因节点重编号而变化，按新 id 存入）
          const w = normalizeFlowRule(e).weight;
          const edgeId = this._edgeId(from, e.fromPort, to, e.toPort);
          this._edgeRules.set(edgeId, normalizeFlowRule(e));
          if (Number.isFinite(w) && w >= 0 && w !== 1) this._edgeWeights.set(edgeId, w);
          const color = typeof e.color === "string" && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : "";
          const widthValue = e.width == null || e.width === "" ? Number.NaN : Number(e.width);
          const width = Number.isFinite(widthValue) ? Math.max(1, Math.min(12, widthValue)) : null;
          if (color || width != null) this._edgeStyles.set(edgeId, {
            ...(color ? { color } : {}),
            ...(width != null ? { width } : {}),
          });
        } catch { /* 端口不匹配则跳过 */ }
      }
      this._syncFlowItems();
      this._batchRecomputePending = true;
    } finally {
      this._endBatch();
      this.setReadOnly(restoreReadOnly);
      this._historyMuted = restoreHistoryMuted;
    }
  }
};
