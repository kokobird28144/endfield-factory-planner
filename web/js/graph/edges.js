import { recipes } from "../recipes.js";
import { normalizeFlowRule, flowRuleLabel } from "../flowRules.js";
import { fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const edgesMethods = {
  _enableSelfConnections(editor) {
    const finishDrag = editor.dragEnd.bind(editor);
    editor.dragEnd = (event) => {
      const target = event.type === "touchend"
        ? document.elementFromPoint(editor.mouse_x, editor.mouse_y) : event.target;
      const input = target?.closest?.(".input");
      const output = editor.ele_selected;
      const sourceNode = output?.closest?.(".drawflow-node");
      const targetNode = input?.closest(".drawflow-node");
      if (!this.readOnly && editor.editor_mode === "edit" && editor.connection &&
          output?.classList.contains("output") && sourceNode && sourceNode === targetNode) {
        const outputClass = [...output.classList].find((name) => /^output_\d+$/.test(name));
        const inputClass = [...input.classList].find((name) => /^input_\d+$/.test(name));
        if (outputClass && inputClass) {
          // Drawflow's public API supports self edges, but its dragEnd rejects them.
          // Remove the preview and route creation through the normal validation event.
          editor.connection_ele?.remove();
          editor.connection_ele = null;
          editor.connection = false;
          try {
            const id = sourceNode.id.replace("node-", "");
            editor.addConnection(id, id, outputClass, inputClass);
          } finally {
            finishDrag(event);
          }
          return;
        }
      }
      finishDrag(event);
    };
  },

  _alignPorts(id) {
    const nodeEl = this.container.querySelector(`#node-${id}`);
    if (!nodeEl) return;
    const align = (rowSel, attr, dotPrefix) => {
      nodeEl.querySelectorAll(rowSel).forEach((row) => {
        const idx = parseInt(row.getAttribute(attr), 10);
        const dot = nodeEl.querySelector(`.${dotPrefix}_${idx + 1}`);
        if (!dot) return;
        let center = row.offsetHeight / 2;
        for (let el = row; el && el !== nodeEl; el = el.offsetParent) center += el.offsetTop;
        dot.style.top = `${center - dot.offsetHeight / 2}px`;
        const nameEl = row.querySelector(".p-name");
        if (nameEl) dot.title = nameEl.textContent.trim();
      });
    };
    align(".port-row.in[data-pin]", "data-pin", "input");
    align(".port-row.out[data-pout]", "data-pout", "output");
    try { this.editor.updateConnectionNodes("node-" + id); } catch { /* 无连线时忽略 */ }
    // Drawflow 的端点重对齐会写回贝塞尔路径；同一帧立即还原折线，避免加载/撤销后闪回曲线。
    if (!this._batchDepth && this.lastResult) this._refreshEdges(this.lastResult, { nodeIds: [String(id)] });
  },

  _syncFlowItems(createdInfo = null) {
    if (this._flowItemMutation) return true;
    const edges = this._collectEdges();
    const changedIds = new Set();
    const conflictedMergers = new Set();
    const conflictedPortals = new Set();
    for (const state of this.state.values()) {
      if (state.type !== "portal_in" && state.type !== "portal_out") continue;
      const connected = !!this._portalPartner(state);
      if (state.portal_connected !== connected) {
        state.portal_connected = connected;
        changedIds.add(state.id);
      }
    }
    const itemAtOutput = (nodeId, portIndex) => {
      const state = this.state.get(String(nodeId));
      const port = state && state.outputPorts && state.outputPorts[portIndex];
      return port && port.item_id ? port.item_id : null;
    };
    const itemAtInput = (nodeId, portIndex) => {
      const state = this.state.get(String(nodeId));
      const port = state && state.inputPorts && state.inputPorts[portIndex];
      return port && port.item_id ? port.item_id : null;
    };

    for (let pass = 0; pass < this.state.size + 2; pass++) {
      let changed = false;
      conflictedMergers.clear();
      conflictedPortals.clear();
      for (const [id, state] of this.state) {
        if (state.type !== "merger") continue;
        const candidates = new Set();
        if (state.item_id) candidates.add(state.item_id);
        for (const edge of edges) {
          if (edge.to === id) {
            const item = itemAtOutput(edge.from, edge.fromPort);
            if (item) candidates.add(item);
          }
          if (edge.from === id) {
            const item = itemAtInput(edge.to, edge.toPort);
            if (item) candidates.add(item);
          }
        }
        if (candidates.size > 1) conflictedMergers.add(id);
        else if (!state.item_id && candidates.size === 1) {
          state.item_id = [...candidates][0];
          this._computePorts(state);
          changedIds.add(id);
          changed = true;
        }
      }

      const portalGroups = new Map();
      for (const state of this.state.values()) {
        if ((state.type !== "portal_in" && state.type !== "portal_out") || !state.pair_id) continue;
        if (!portalGroups.has(state.pair_id)) portalGroups.set(state.pair_id, []);
        portalGroups.get(state.pair_id).push(state);
      }
      for (const group of portalGroups.values()) {
        const candidates = new Set(group.map((state) => state.item_id).filter(Boolean));
        for (const state of group) {
          for (const edge of edges) {
            if (state.type === "portal_in" && edge.to === state.id) {
              const item = itemAtOutput(edge.from, edge.fromPort);
              if (item) candidates.add(item);
            }
            if (state.type === "portal_out" && edge.from === state.id) {
              const item = itemAtInput(edge.to, edge.toPort);
              if (item) candidates.add(item);
            }
          }
        }
        if (candidates.size > 1) {
          group.forEach((state) => conflictedPortals.add(state.id));
        } else if (candidates.size === 1) {
          const itemId = [...candidates][0];
          for (const state of group) {
            if (state.item_id === itemId) continue;
            state.item_id = itemId;
            this._computePorts(state);
            changedIds.add(state.id);
            changed = true;
          }
        }
      }

      for (const [id, state] of this.state) {
        if (state.type !== "source") continue;
        const outputs = this._normalizeSourceOutputs(state);
        outputs.forEach((output, outputIndex) => {
          if (output.item_id) return;
          for (const edge of edges) {
            if (edge.from !== id || edge.fromPort !== outputIndex) continue;
            const item = itemAtInput(edge.to, edge.toPort);
            if (!item) continue;
            output.item_id = item;
            this._updateSourceLabel(state);
            this._computePorts(state);
            changedIds.add(id);
            changed = true;
            break;
          }
        });
      }
      if (!changed) break;
    }

    let invalid = false;
    if (createdInfo) {
      const from = String(createdInfo.output_id);
      const to = String(createdInfo.input_id);
      const fromPort = parseInt(String(createdInfo.output_class).split("_")[1], 10) - 1;
      const toPort = parseInt(String(createdInfo.input_class).split("_")[1], 10) - 1;
      const sourceItem = itemAtOutput(from, fromPort);
      const targetItem = itemAtInput(to, toPort);
      const mergerConflict = conflictedMergers.has(from) || conflictedMergers.has(to);
      const portalConflict = conflictedPortals.has(from) || conflictedPortals.has(to);
      const touchesConflict = mergerConflict || portalConflict;
      const itemMismatch = sourceItem && targetItem && sourceItem !== targetItem;
      invalid = touchesConflict || itemMismatch;
      if (invalid) {
        this._flowItemMutation = true;
        try {
          this.editor.removeSingleConnection(from, to, createdInfo.output_class, createdInfo.input_class);
        } finally {
          this._flowItemMutation = false;
        }
        const message = portalConflict
          ? "一对传送门只能传送同一种物料，已取消该连线"
          : (mergerConflict
            ? "汇流分配器只能连接同一种物料，已取消该连线"
            : `物料不匹配：上游输出“${recipes.itemName(sourceItem)}”，下游需要“${recipes.itemName(targetItem)}”，已取消该连线`);
        this.onToast(message, "err");
      }
    }

    for (const id of changedIds) this._rerenderContent(id);
    return !invalid;
  },

  _syncSourceItem() {
    this._syncFlowItems();
  },

  _edgeId(from, fromPort, to, toPort) {
    return `${from}.output_${fromPort + 1}->${to}.input_${toPort + 1}`;
  },

  _initializeConnectionRule(info) {
    const from = String(info.output_id);
    const to = String(info.input_id);
    const fromPort = parseInt(info.output_class.split("_")[1], 10) - 1;
    const toPort = parseInt(info.input_class.split("_")[1], 10) - 1;
    const edgeId = this._edgeId(from, fromPort, to, toPort);
    if (this._edgeRules.has(edgeId)) return;
    const target = this.state.get(to);
    if (!target) return;
    this._computePorts(target);
    const input = target.inputPorts[toPort];
    if (!input) return;
    this._edgeRules.set(edgeId, normalizeFlowRule({ mode: "weight", weight: 1 }));
  },

  _collectEdges() {
    // 只读内部图数据即可；editor.export() 会深拷贝整张图，在重算和历史快照中代价很高。
    const data = this.editor && this.editor.drawflow && this.editor.drawflow.drawflow.Home.data;
    const edges = [];
    if (!data) return edges;
    for (const id in data) {
      const nd = data[id];
      const outs = nd.outputs || {};
      for (const outName in outs) {
        const fromPort = parseInt(outName.split("_")[1], 10) - 1;
        for (const conn of outs[outName].connections) {
          const to = String(conn.node);
          const toPort = parseInt(String(conn.output).split("_")[1], 10) - 1;
          const eid = `${id}.${outName}->${to}.${conn.output}`;
          const w = this._edgeWeights.get(eid);
          const style = this._edgeStyles.get(eid) || {};
          const edge = { id: eid, from: String(id), fromPort, to, toPort,
            ...normalizeFlowRule({ ...this._edgeRules.get(eid), weight: Number.isFinite(w) ? w : 1 }) };
          if (style.color) edge.color = style.color;
          if (Number.isFinite(style.width)) edge.width = style.width;
          edges.push(edge);
        }
      }
    }
    return edges;
  },

  _selectedEdgeId() {
    const connection = this._selectedConnection;
    if (!connection) return "";
    const fromPort = parseInt(connection.outputClass.split("_")[1], 10) - 1;
    const toPort = parseInt(connection.inputClass.split("_")[1], 10) - 1;
    return this._edgeId(connection.from, fromPort, connection.to, toPort);
  },

  getSelectedConnection() {
    const id = this._selectedEdgeId();
    if (!id || !this._selectedConnection) return null;
    const style = this._edgeStyles.get(id) || {};
    const fromState = this.state.get(this._selectedConnection.from);
    const toState = this.state.get(this._selectedConnection.to);
    return {
      id,
      from: this._selectedConnection.from,
      to: this._selectedConnection.to,
      fromLabel: fromState ? fromState.label : this._selectedConnection.from,
      toLabel: toState ? toState.label : this._selectedConnection.to,
      color: style.color || "",
      width: Number.isFinite(style.width) ? style.width : 2.4,
      customWidth: Number.isFinite(style.width),
    };
  },

  setSelectedConnectionStyle(patch, commit = true) {
    const id = this._selectedEdgeId();
    if (!id || this.readOnly) return false;
    const current = this._edgeStyles.get(id) || {};
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, "color")) {
      const color = String(patch.color || "").trim();
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) return false;
      if (color) next.color = color;
      else delete next.color;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "width")) {
      if (patch.width == null || patch.width === "") delete next.width;
      else {
        const width = Number(patch.width);
        if (!Number.isFinite(width)) return false;
        next.width = Math.max(1, Math.min(12, width));
      }
    }
    if (next.color || Number.isFinite(next.width)) this._edgeStyles.set(id, next);
    else this._edgeStyles.delete(id);
    if (commit) {
      if (this._edgeStyleFrame) {
        cancelAnimationFrame(this._edgeStyleFrame);
        this._edgeStyleFrame = 0;
      }
      this._applySelectedConnectionStyle();
      this.onConnectionSelect(this.getSelectedConnection());
      this._scheduleHistoryCommit();
    } else if (!this._edgeStyleFrame) {
      this._edgeStyleFrame = requestAnimationFrame(() => {
        this._edgeStyleFrame = 0;
        this._applySelectedConnectionStyle();
      });
    }
    return true;
  },

  _applySelectedConnectionStyle() {
    const id = this._selectedEdgeId();
    const selector = this._connectionSelector(this._selectedConnection);
    if (!id || !selector) return;
    const style = this._edgeStyles.get(id) || {};
    this.container.querySelectorAll(selector).forEach((element) => {
      element.classList.toggle("flow-custom-color", !!style.color);
      element.classList.toggle("flow-custom-width", Number.isFinite(style.width));
      if (style.color) element.style.setProperty("--edge-custom-color", style.color);
      else element.style.removeProperty("--edge-custom-color");
      if (Number.isFinite(style.width)) element.style.setProperty("--edge-custom-width", `${style.width}px`);
      else element.style.removeProperty("--edge-custom-width");
    });
  },

  _connectionSelector(connection) {
    if (!connection) return "";
    return `.connection.node_out_node-${connection.from}.node_in_node-${connection.to}.` +
      `${connection.outputClass}.${connection.inputClass}`;
  },

  _connectionExists(from, to, outputClass, inputClass) {
    const data = this.editor && this.editor.drawflow.drawflow.Home.data;
    const output = data && data[String(from)] && data[String(from)].outputs[outputClass];
    return !!(output && output.connections.some((item) =>
      String(item.node) === String(to) && item.output === inputClass));
  },

  _removeConnectionHandles() {
    this.container.querySelectorAll(".edge-retarget-handle").forEach((element) => element.remove());
    this.container.querySelectorAll(".connection.edge-retarget-selected").forEach((element) =>
      element.classList.remove("edge-retarget-selected"));
  },

  _refreshSelectedConnectionHandles() {
    this._removeConnectionHandles();
    if (this.readOnly || this._edgeRetargetDrag || !this._selectedConnection) return;
    const svg = this.container.querySelector(this._connectionSelector(this._selectedConnection));
    const path = svg && svg.querySelector(".main-path");
    if (!svg || !path) return;
    // Drawflow 的连线默认在节点下层；选中后临时提升整条 SVG，避免端点手柄被卡片遮住。
    svg.classList.add("edge-retarget-selected");
    let start, end;
    try {
      const length = path.getTotalLength();
      start = path.getPointAtLength(0);
      end = path.getPointAtLength(length);
    } catch {
      return;
    }
    const NS = "http://www.w3.org/2000/svg";
    [["from", start], ["to", end]].forEach(([side, point]) => {
      const handle = document.createElementNS(NS, "circle");
      handle.setAttribute("class", `edge-retarget-handle edge-retarget-${side}`);
      handle.setAttribute("cx", point.x);
      handle.setAttribute("cy", point.y);
      handle.setAttribute("r", "5");
      handle.dataset.side = side;
      const title = document.createElementNS(NS, "title");
      title.textContent = side === "from" ? "拖动更改上游端点" : "拖动更改下游端点";
      handle.appendChild(title);
      handle.addEventListener("pointerdown", (event) => this._startEdgeRetarget(event, side));
      svg.appendChild(handle);
    });
  },

  _canvasPoint(clientX, clientY) {
    const rect = this.editor.precanvas.getBoundingClientRect();
    const zoom = Number(this.editor.zoom) || 1;
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  },

  _startEdgeRetarget(event, side) {
    if (this.readOnly || event.button !== 0 || !this._selectedConnection) return;
    event.preventDefault();
    event.stopPropagation();
    const connection = { ...this._selectedConnection };
    const svg = this.container.querySelector(this._connectionSelector(connection));
    const mainPath = svg && svg.querySelector(".main-path");
    if (!mainPath) return;
    let start, end;
    try {
      const length = mainPath.getTotalLength();
      start = mainPath.getPointAtLength(0);
      end = mainPath.getPointAtLength(length);
    } catch {
      return;
    }
    const NS = "http://www.w3.org/2000/svg";
    const preview = document.createElementNS(NS, "svg");
    preview.setAttribute("class", "edge-retarget-preview");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", "edge-retarget-preview-path");
    preview.appendChild(path);
    this.editor.precanvas.appendChild(preview);
    this._removeConnectionHandles();
    this._edgeRetargetDrag = {
      side, connection, preview, path,
      fixed: side === "from" ? end : start,
      candidate: null,
    };
    this.container.classList.add("edge-retargeting");
    this._updateEdgeRetarget(event);
  },

  _retargetPortAt(clientX, clientY, side) {
    const element = document.elementFromPoint(clientX, clientY);
    const selector = side === "from" ? ".output" : ".input";
    const portEl = element && element.closest ? element.closest(selector) : null;
    const nodeEl = portEl && portEl.closest(".drawflow-node");
    if (!portEl || !nodeEl) return null;
    const match = [...portEl.classList].find((name) => name.startsWith(side === "from" ? "output_" : "input_"));
    const index = match ? parseInt(match.split("_")[1], 10) - 1 : -1;
    if (index < 0) return null;
    return { element: portEl, nodeId: nodeEl.id.replace("node-", ""), index, className: match };
  },

  _validateRetargetCandidate(drag, candidate) {
    if (!candidate) return { valid: false, reason: "请拖到对应的端点上" };
    const old = drag.connection;
    const from = drag.side === "from" ? candidate.nodeId : old.from;
    const to = drag.side === "to" ? candidate.nodeId : old.to;
    const outputClass = drag.side === "from" ? candidate.className : old.outputClass;
    const inputClass = drag.side === "to" ? candidate.className : old.inputClass;
    if (from === old.from && to === old.to && outputClass === old.outputClass && inputClass === old.inputClass) {
      return { valid: false, unchanged: true };
    }
    if (this._connectionExists(from, to, outputClass, inputClass)) {
      return { valid: false, reason: "该连接已经存在" };
    }
    const fromState = this.state.get(String(from));
    const toState = this.state.get(String(to));
    const fromIndex = parseInt(outputClass.split("_")[1], 10) - 1;
    const toIndex = parseInt(inputClass.split("_")[1], 10) - 1;
    const outputItem = fromState && fromState.outputPorts[fromIndex] && fromState.outputPorts[fromIndex].item_id;
    const inputItem = toState && toState.inputPorts[toIndex] && toState.inputPorts[toIndex].item_id;
    if (outputItem && inputItem && outputItem !== inputItem) {
      return { valid: false, reason: "两个端点的物料不同" };
    }
    return { valid: true, from, to, outputClass, inputClass };
  },

  _updateEdgeRetarget(event) {
    const drag = this._edgeRetargetDrag;
    if (!drag) return;
    const point = this._canvasPoint(event.clientX, event.clientY);
    const start = drag.side === "from" ? point : drag.fixed;
    const end = drag.side === "to" ? point : drag.fixed;
    const midX = (start.x + end.x) / 2;
    drag.path.setAttribute("d", `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`);

    if (drag.candidate) drag.candidate.element.classList.remove("edge-retarget-valid", "edge-retarget-invalid");
    const candidate = this._retargetPortAt(event.clientX, event.clientY, drag.side);
    const validation = this._validateRetargetCandidate(drag, candidate);
    if (candidate) candidate.element.classList.add(validation.valid ? "edge-retarget-valid" : "edge-retarget-invalid");
    drag.candidate = candidate;
    drag.validation = validation;
  },

  _finishEdgeRetarget(event) {
    const drag = this._edgeRetargetDrag;
    if (!drag) return;
    this._updateEdgeRetarget(event);
    const candidate = drag.candidate;
    const validation = drag.validation || this._validateRetargetCandidate(drag, candidate);
    this._cleanupEdgeRetargetDrag();
    if (!validation.valid) {
      if (validation.reason) this.onToast(validation.reason, "err");
      this._refreshSelectedConnectionHandles();
      return;
    }
    this._commitEdgeRetarget(drag.connection, validation);
  },

  _cleanupEdgeRetargetDrag() {
    const drag = this._edgeRetargetDrag;
    if (drag && drag.candidate) drag.candidate.element.classList.remove("edge-retarget-valid", "edge-retarget-invalid");
    if (drag && drag.preview) drag.preview.remove();
    this._edgeRetargetDrag = null;
    this.container.classList.remove("edge-retargeting");
  },

  _cancelEdgeRetarget() {
    if (!this._edgeRetargetDrag) return;
    this._cleanupEdgeRetargetDrag();
    this._refreshSelectedConnectionHandles();
  },

  _commitEdgeRetarget(old, next) {
    const oldFromPort = parseInt(old.outputClass.split("_")[1], 10) - 1;
    const oldToPort = parseInt(old.inputClass.split("_")[1], 10) - 1;
    const newFromPort = parseInt(next.outputClass.split("_")[1], 10) - 1;
    const newToPort = parseInt(next.inputClass.split("_")[1], 10) - 1;
    const oldKey = this._edgeId(old.from, oldFromPort, old.to, oldToPort);
    const newKey = this._edgeId(next.from, newFromPort, next.to, newToPort);
    const weight = this._edgeWeights.has(oldKey) ? this._edgeWeights.get(oldKey) : 1;
    const rule = this._edgeRules.get(oldKey);
    const edgeStyle = this._edgeStyles.get(oldKey);
    let added = false;
    this._edgeRetargetMutation = true;
    try {
      this.editor.addConnection(next.from, next.to, next.outputClass, next.inputClass);
      added = this._connectionExists(next.from, next.to, next.outputClass, next.inputClass);
      if (!added) throw new Error("无法创建新的连接");
      const removed = this.editor.removeSingleConnection(old.from, old.to, old.outputClass, old.inputClass);
      if (!removed) {
        this.editor.removeSingleConnection(next.from, next.to, next.outputClass, next.inputClass);
        throw new Error("原连接未能替换");
      }
      this._edgeWeights.delete(oldKey);
      if (weight !== 1) this._edgeWeights.set(newKey, weight);
      this._edgeRules.delete(oldKey);
      if (rule) this._edgeRules.set(newKey, { ...rule });
      this._edgeStyles.delete(oldKey);
      if (edgeStyle) this._edgeStyles.set(newKey, { ...edgeStyle });
    } catch (error) {
      if (added && this._connectionExists(next.from, next.to, next.outputClass, next.inputClass)) {
        this.editor.removeSingleConnection(next.from, next.to, next.outputClass, next.inputClass);
      }
      this.onToast(error.message || "更改连接失败", "err");
      return;
    } finally {
      this._edgeRetargetMutation = false;
    }
    this._selectedConnection = null;
    this.editor.connection_selected = null;
    this._removeConnectionHandles();
    this.onConnectionSelect(null);
    this._syncFlowItems();
    this.recompute();
    this._scheduleHistoryCommit();
    this.onToast("连接已更改，原分配设置和外观已保留", "ok");
  },

  _removePortalLink() {
    if (this._portalLinkEl) this._portalLinkEl.remove();
    this._portalLinkEl = null;
  },

  _refreshPortalLink() {
    this._removePortalLink();
    const state = this.selectedId && this.state.get(String(this.selectedId));
    if (!state || (state.type !== "portal_in" && state.type !== "portal_out")) return;
    const partner = this._portalPartner(state);
    if (!partner || !this.editor || !this.editor.precanvas) return;
    const input = state.type === "portal_in" ? state : partner;
    const output = state.type === "portal_out" ? state : partner;
    const inputEl = this.container.querySelector(`#node-${input.id}`);
    const outputEl = this.container.querySelector(`#node-${output.id}`);
    if (!inputEl || !outputEl) return;
    const inputData = this.editor.drawflow.drawflow.Home.data[input.id];
    const outputData = this.editor.drawflow.drawflow.Home.data[output.id];
    if (!inputData || !outputData) return;
    const x1 = Number(inputData.pos_x) + inputEl.offsetWidth;
    const y1 = Number(inputData.pos_y) + inputEl.offsetHeight / 2;
    const x2 = Number(outputData.pos_x);
    const y2 = Number(outputData.pos_y) + outputEl.offsetHeight / 2;
    const midX = (x1 + x2) / 2;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "portal-pair-link");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`);
    svg.appendChild(path);
    this.editor.precanvas.appendChild(svg);
    this._portalLinkEl = svg;
  },

  _scheduleEdgeRefresh(scope = null) {
    if (!scope || scope.full) this._edgeRefreshFull = true;
    else for (const id of scope.nodeIds || []) this._edgeRefreshNodeIds.add(String(id));
    if (this._edgeRefreshFrame) return;
    this._edgeRefreshFrame = requestAnimationFrame(() => {
      this._edgeRefreshFrame = 0;
      const full = this._edgeRefreshFull;
      const nodeIds = full ? null : [...this._edgeRefreshNodeIds];
      this._edgeRefreshFull = false;
      this._edgeRefreshNodeIds.clear();
      if (this.lastResult && (full || (nodeIds && nodeIds.length))) {
        this._refreshEdges(this.lastResult, full ? null : { nodeIds });
      }
      this._refreshPortalLink();
    });
  },

  _scheduleConnectionRouting() {
    const editor = this.editor;
    if (editor && (editor.connection || editor.drag_point)) return;
    if (this._groupDrag) {
      this._scheduleEdgeRefresh({ nodeIds: this._groupDrag.nodes.map((node) => node.id) });
      return;
    }
    if (this.container.classList.contains("node-dragging") && this._dragNodeId) {
      this._scheduleEdgeRefresh({ nodeIds: [this._dragNodeId] });
    }
  },

  _ensureEdgeRefreshIndex() {
    if (this._edgeRefreshIndexSource === this._lastEdges) return;
    this._edgeRefreshIndexSource = this._lastEdges;
    this._edgeRefreshById = new Map();
    this._edgeRefreshByNode = new Map();
    for (const edge of this._lastEdges) {
      this._edgeRefreshById.set(edge.id, edge);
      for (const nodeId of [String(edge.from), String(edge.to)]) {
        if (!this._edgeRefreshByNode.has(nodeId)) this._edgeRefreshByNode.set(nodeId, new Set());
        this._edgeRefreshByNode.get(nodeId).add(edge.id);
      }
    }
  },

  _edgeSelector(edge) {
    return this._connectionSelector({
      from: edge.from,
      to: edge.to,
      outputClass: `output_${edge.fromPort + 1}`,
      inputClass: `input_${edge.toPort + 1}`,
    });
  },

  _applyEdgeVisual(element, edge, edgeResult) {
    element.classList.toggle("flow-liquid", edgeResult.state === "liquid");
    element.classList.toggle("flow-gas", edgeResult.state === "gas");
    element.classList.toggle("flow-warn", edgeResult.warn);
    const edgeStyle = this._edgeStyles.get(edge.id) || {};
    element.classList.toggle("flow-custom-color", !!edgeStyle.color);
    element.classList.toggle("flow-custom-width", Number.isFinite(edgeStyle.width));
    if (edgeStyle.color) element.style.setProperty("--edge-custom-color", edgeStyle.color);
    else element.style.removeProperty("--edge-custom-color");
    if (Number.isFinite(edgeStyle.width)) element.style.setProperty("--edge-custom-width", `${edgeStyle.width}px`);
    else element.style.removeProperty("--edge-custom-width");
    this._orthogonalizeEdge(element, edge);
    this._labelEdge(element, edgeResult, edge);
  },

  _refreshEdges(result, scope = null) {
    const c = this.container;
    if (!c || !result) return;
    if (!scope && this._edgeRefreshFrame) {
      cancelAnimationFrame(this._edgeRefreshFrame);
      this._edgeRefreshFrame = 0;
      this._edgeRefreshFull = false;
      this._edgeRefreshNodeIds.clear();
    }
    this._ensureEdgeRefreshIndex();
    if (scope && scope.nodeIds) {
      const edgeIds = new Set();
      for (const nodeId of scope.nodeIds) {
        const related = this._edgeRefreshByNode.get(String(nodeId));
        if (related) for (const edgeId of related) edgeIds.add(edgeId);
      }
      for (const edgeId of edgeIds) {
        const edge = this._edgeRefreshById.get(edgeId);
        const edgeResult = result.edges.get(edgeId);
        if (!edge || !edgeResult) continue;
        c.querySelectorAll(this._edgeSelector(edge)).forEach((element) =>
          this._applyEdgeVisual(element, edge, edgeResult));
      }
      this._refreshSelectedConnectionHandles();
      return;
    }

    const elementsById = new Map();
    c.querySelectorAll(".connection").forEach((element) => {
      const classes = [...element.classList];
      const fromClass = classes.find((name) => name.startsWith("node_out_node-"));
      const toClass = classes.find((name) => name.startsWith("node_in_node-"));
      const outputClass = classes.find((name) => /^output_\d+$/.test(name));
      const inputClass = classes.find((name) => /^input_\d+$/.test(name));
      if (!fromClass || !toClass || !outputClass || !inputClass) return;
      const id = `${fromClass.slice("node_out_node-".length)}.${outputClass}->${toClass.slice("node_in_node-".length)}.${inputClass}`;
      if (!elementsById.has(id)) elementsById.set(id, []);
      elementsById.get(id).push(element);
    });
    for (const edge of this._lastEdges) {
      const edgeResult = result.edges.get(edge.id);
      if (!edgeResult) continue;
      for (const element of elementsById.get(edge.id) || []) this._applyEdgeVisual(element, edge, edgeResult);
    }
    this._refreshSelectedConnectionHandles();
  },

  _orthogonalizeEdge(svgEl, edge) {
    const path = svgEl.querySelector(".main-path");
    if (!path) return;
    let start, end;
    try {
      const length = path.getTotalLength();
      start = path.getPointAtLength(0);
      end = path.getPointAtLength(length);
    } catch {
      return;
    }
    if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return;

    if (end.x >= start.x + 48) {
      const midX = (start.x + end.x) / 2;
      path.setAttribute("d", `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`);
      return;
    }

    const fromEl = edge ? this.container.querySelector(`#node-${edge.from}`) : null;
    const toEl = edge ? this.container.querySelector(`#node-${edge.to}`) : null;
    if (fromEl && edge.from === edge.to) {
      const canvasRect = this.editor.precanvas.getBoundingClientRect();
      const rect = fromEl.getBoundingClientRect();
      const zoom = Number(this.editor.zoom) || 1;
      const left = (rect.left - canvasRect.left) / zoom;
      const right = (rect.right - canvasRect.left) / zoom;
      const bottom = (rect.bottom - canvasRect.top) / zoom;
      const clearance = 32 + 12 * (edge.fromPort + edge.toPort);
      const outX = Math.max(right, start.x) + clearance;
      const inX = Math.min(left, end.x) - clearance;
      path.setAttribute("d", `M ${start.x} ${start.y} H ${outX} V ${bottom + clearance} H ${inX} V ${end.y} H ${end.x}`);
      return;
    }
    const fromTop = fromEl ? fromEl.offsetTop : start.y;
    const fromBottom = fromEl ? fromEl.offsetTop + fromEl.offsetHeight : start.y;
    const toTop = toEl ? toEl.offsetTop : end.y;
    const toBottom = toEl ? toEl.offsetTop + toEl.offsetHeight : end.y;
    let laneY;
    if (fromBottom + 12 <= toTop) {
      // 源卡片在上、目标卡片在下：走两者之间的水平通道。
      laneY = (fromBottom + toTop) / 2;
    } else if (toBottom + 12 <= fromTop) {
      // 目标卡片在上、源卡片在下：同样走两者之间的水平通道。
      laneY = (toBottom + fromTop) / 2;
    } else {
      // 纵向重叠时没有安全的中间通道，选择距离端口更近的外侧，避免穿过卡片。
      const top = Math.min(fromTop, toTop) - 28;
      const bottom = Math.max(fromBottom, toBottom) + 28;
      laneY = Math.abs(start.y - top) + Math.abs(end.y - top)
        <= Math.abs(start.y - bottom) + Math.abs(end.y - bottom) ? top : bottom;
    }
    const outX = start.x + 28;
    const inX = end.x - 28;
    path.setAttribute("d", `M ${start.x} ${start.y} H ${outX} V ${laneY} H ${inX} V ${end.y} H ${end.x}`);
  },

  _labelEdge(svgEl, er, edge) {
    const path = svgEl.querySelector(".main-path");
    if (!path) return;
    const NS = "http://www.w3.org/2000/svg";
    let label = svgEl.querySelector("text.flow-label");
    if (!Number.isFinite(er.rate)) {
      if (label) label.remove();
      return;
    }
    if (!label) {
      label = document.createElementNS(NS, "text");
      label.setAttribute("class", "flow-label");
      label.setAttribute("text-anchor", "middle");
      svgEl.appendChild(label);
    }
    label.dataset.edgeId = edge.id;
    if (!label._wired) {
      label._wired = true;
      // 点击标签弹出路径分配编辑框
      label.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._openEdgeWeightEditor(label.dataset.edgeId, ev.clientX, ev.clientY);
      });
    }
    try {
      const pt = path.getPointAtLength(path.getTotalLength() / 2);
      label.setAttribute("x", pt.x);
      label.setAttribute("y", pt.y - 7);
    } catch { /* 路径未就绪时忽略 */ }
    const rule = normalizeFlowRule(er);
    const showRule = this.showEdgeWeight && (rule.mode !== "weight" || rule.weight !== 1);
    label.textContent = showRule ? `${flowRuleLabel(rule, fmt)} · 实际 ${fmt(er.rate)}/分` : fmt(er.rate);
    if (er.shortfall > 0.01) label.textContent += ` · 缺 ${fmt(er.shortfall)}/分`;
    let title = label.querySelector("title");
    if (!title) { title = document.createElementNS(NS, "title"); label.appendChild(title); }
    title.textContent = `${flowRuleLabel(rule, fmt)}；实际 ${fmt(er.rate)}/分。点击编辑分配模式。` +
      (this.lastResult?.flowConverged === false ? "分配未收敛，请检查回流或冲突设置。" : "");
    label.classList.toggle("warn", !!er.warn);
  },

  _openEdgeWeightEditor(edgeId, x, y) {
    if (this.readOnly) return;
    this._closeEdgeEditor();
    const edge = this._collectEdges().find((item) => item.id === edgeId);
    if (!edge) return;
    const rule = normalizeFlowRule(edge);
    const box = document.createElement("div");
    box.className = "edge-weight-editor";
    box.innerHTML =
      `<div class="ewe-title">路径流量分配</div>` +
      `<label class="ewe-row">分配模式<select class="ewe-input" name="mode"><option value="weight">权重模式</option><option value="fixed">固定数值模式</option><option value="priority">优先级模式</option></select></label>` +
      `<label class="ewe-row" data-mode="weight">权重<input name="weight" type="number" min="0" step="any" class="ewe-input" required></label>` +
      `<label class="ewe-row" data-mode="fixed">目标流量（/分钟）<input name="fixedRate" type="number" min="0" step="any" class="ewe-input" required></label>` +
      `<label class="ewe-row" data-mode="priority">优先级（1 最高）<input name="priority" type="number" min="1" step="1" max="9007199254740991" class="ewe-input" required></label>` +
      `<label class="ewe-row" data-mode="priority">流量上限（/分钟，可选）<input name="maxRate" type="number" min="0" step="any" class="ewe-input" placeholder="留空不限，0 停止分流"></label>` +
      `<div class="ewe-hint"></div><div class="ewe-error" role="alert"></div>` +
      `<div class="ewe-actions"><button type="button" class="btn" data-action="cancel">取消</button><button type="button" class="btn btn-primary" data-action="save">应用</button></div>`;
    document.body.appendChild(box);
    const field = (name) => box.querySelector(`[name="${name}"]`);
    for (const key of ["mode", "weight", "fixedRate", "priority", "maxRate"]) field(key).value = rule[key] == null ? "" : String(rule[key]);
    const update = () => {
      box.querySelectorAll("[data-mode]").forEach((row) => {
        row.hidden = row.dataset.mode !== field("mode").value;
        row.querySelector("input").disabled = row.hidden;
      });
      box.querySelector(".ewe-hint").textContent = {
        weight: "固定和优先分配后，剩余流量按权重比例分配。权重 0 停止分流。",
        fixed: "先分固定目标；供给不足时按目标比例缩减，并显示缺口。",
        priority: "按等级满足下游剩余需求，同级按需求比例分配。产物箱、汇流器和传送口无需求上限，建议设置限流。",
      }[field("mode").value];
      box.style.left = Math.max(8, Math.min(x, window.innerWidth - box.offsetWidth - 8)) + "px";
      box.style.top = Math.max(8, Math.min(y, window.innerHeight - box.offsetHeight - 8)) + "px";
    };
    field("mode").addEventListener("change", update);
    update();
    this._edgeEditorEl = box;

    const commit = () => {
      // 迟到的 blur/外部点击回调只能提交它自己所属的编辑框，不能覆盖后来打开的其他连线编辑框。
      if (this._edgeEditorEl !== box) return;
      for (const input of box.querySelectorAll("input:not(:disabled)")) {
        if (!input.checkValidity()) {
          box.querySelector(".ewe-error").textContent = "请输入有效的非负数；优先级必须为正整数。";
          input.reportValidity();
          return;
        }
      }
      if (!this._collectEdges().some((item) => item.id === edgeId)) { this._closeEdgeEditor(); return; }
      const next = normalizeFlowRule(Object.fromEntries(["mode", "weight", "fixedRate", "priority", "maxRate"].map((key) => [key, field(key).value])));
      if (next.weight === 1) this._edgeWeights.delete(edgeId);
      else this._edgeWeights.set(edgeId, next.weight);
      this._edgeRules.set(edgeId, next);
      this._closeEdgeEditor();
      this.recompute();
      this._scheduleHistoryCommit();
    };
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape" && this._edgeEditorEl === box) {
        ev.preventDefault();
        this._closeEdgeEditor();
      }
    });
    box.querySelector('[data-action="save"]').addEventListener("click", commit);
    box.querySelector('[data-action="cancel"]').addEventListener("click", () => this._closeEdgeEditor());
    this._edgeEditorCloser = (ev) => {
      if (this._edgeEditorEl === box && !box.contains(ev.target)) commit();
    };
    document.addEventListener("mousedown", this._edgeEditorCloser, true);
    field("mode").focus();
  },

  _closeEdgeEditor() {
    if (this._edgeEditorEl) { this._edgeEditorEl.remove(); this._edgeEditorEl = null; }
    if (this._edgeEditorCloser) { document.removeEventListener("mousedown", this._edgeEditorCloser, true); this._edgeEditorCloser = null; }
  }
};
