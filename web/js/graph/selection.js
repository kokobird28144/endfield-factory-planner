import { recipes } from "../recipes.js";
import { normalizeFlowRule } from "../flowRules.js";
import { compute, parseSpeed, fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const selectionMethods = {
  _startBoxSelection(event, additive) {
    this._cancelBoxSelection();
    const overlay = document.createElement("div");
    overlay.className = "selection-box";
    this.container.appendChild(overlay);
    this.container.classList.add("box-selecting");
    this._boxSelect = {
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      additive: !!additive,
      overlay,
    };
    this._updateBoxSelection(event);
  },

  _updateBoxSelection(event) {
    const box = this._boxSelect;
    if (!box) return;
    box.currentX = event.clientX;
    box.currentY = event.clientY;
    const canvasRect = this.container.getBoundingClientRect();
    const left = Math.min(box.startX, box.currentX) - canvasRect.left;
    const top = Math.min(box.startY, box.currentY) - canvasRect.top;
    box.overlay.style.left = `${left}px`;
    box.overlay.style.top = `${top}px`;
    box.overlay.style.width = `${Math.abs(box.currentX - box.startX)}px`;
    box.overlay.style.height = `${Math.abs(box.currentY - box.startY)}px`;
  },

  _finishBoxSelection(event) {
    const box = this._boxSelect;
    if (!box) return;
    this._updateBoxSelection(event);
    const moved = Math.abs(box.currentX - box.startX) >= 4 || Math.abs(box.currentY - box.startY) >= 4;
    if (moved) {
      if (!box.additive) this._clearMulti();
      const selection = {
        left: Math.min(box.startX, box.currentX),
        right: Math.max(box.startX, box.currentX),
        top: Math.min(box.startY, box.currentY),
        bottom: Math.max(box.startY, box.currentY),
      };
      this.container.querySelectorAll(".drawflow-node").forEach((nodeEl) => {
        const rect = nodeEl.getBoundingClientRect();
        const intersects = rect.right >= selection.left && rect.left <= selection.right
          && rect.bottom >= selection.top && rect.top <= selection.bottom;
        if (!intersects) return;
        const id = nodeEl.id.replace("node-", "");
        this.multi.add(id);
        nodeEl.classList.add("multi-sel");
      });
    }
    this._cancelBoxSelection();
  },

  _cancelBoxSelection() {
    if (!this._boxSelect) return;
    this._boxSelect.overlay.remove();
    this._boxSelect = null;
    this.container.classList.remove("box-selecting");
  },

  _startGroupDrag(primaryId, event) {
    const data = this.editor && this.editor.drawflow
      && this.editor.drawflow.drawflow.Home.data;
    if (!data) return;
    const nodes = [];
    for (const id of this.multi) {
      if (!data[id]) continue;
      nodes.push({ id, x: Number(data[id].pos_x) || 0, y: Number(data[id].pos_y) || 0 });
    }
    if (nodes.length < 2) return;
    this._groupDrag = {
      primaryId,
      startX: event.clientX,
      startY: event.clientY,
      nodes,
      moved: false,
    };
    this.container.classList.add("group-dragging");
  },

  _updateGroupDrag(event) {
    const drag = this._groupDrag;
    if (!drag || !this.editor) return;
    const zoom = Number(this.editor.zoom) || 1;
    const dx = (event.clientX - drag.startX) / zoom;
    const dy = (event.clientY - drag.startY) / zoom;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) drag.moved = true;
    const data = this.editor.drawflow.drawflow.Home.data;
    for (const item of drag.nodes) {
      const node = data[item.id];
      const el = this.container.querySelector(`#node-${item.id}`);
      if (!node || !el) continue;
      const x = item.x + dx;
      const y = item.y + dy;
      node.pos_x = x;
      node.pos_y = y;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      this.editor.updateConnectionNodes(`node-${item.id}`);
    }
    this._scheduleEdgeRefresh({ nodeIds: drag.nodes.map((item) => item.id) });
  },

  _finishGroupDrag() {
    if (!this._groupDrag) return;
    const drag = this._groupDrag;
    const movedIds = drag.nodes.map((item) => item.id);
    this._groupDrag = null;
    this.container.classList.remove("group-dragging");
    if (drag.moved && this.snapToGrid) this._snapNodes(movedIds);
    else for (const id of movedIds) this.editor.updateConnectionNodes(`node-${id}`);
    this._scheduleEdgeRefresh({ nodeIds: movedIds });
    if (drag.moved) this._scheduleHistoryCommit();
  },

  _bindDragSafety() {
    const active = () => {
      const e = this.editor;
      return !!(e && (e.drag || e.drag_point || e.connection || e.editor_selected));
    };
    const remember = (e) => {
      const p = e.touches && e.touches[0] ? e.touches[0] : e;
      if (Number.isFinite(p.clientX) && Number.isFinite(p.clientY)) {
        this._lastPointer = { x: p.clientX, y: p.clientY };
      }
    };
    const resetFlags = () => {
      const e = this.editor;
      if (!e) return;
      if (e.connection && e.ele_selected && e.ele_selected.remove) {
        try { e.ele_selected.remove(); } catch { /* 已移除则忽略 */ }
      }
      e.drag = false;
      e.drag_point = false;
      e.connection = false;
      e.editor_selected = false;
      e.ele_selected = null;
    };
    const finish = (event) => {
      remember(event);
      const needsFinish = active();
      const movedNode = this.container.classList.contains("node-dragging");
      this.container.classList.remove("node-dragging");
      if (needsFinish) {
        try { this.editor.dragEnd(event); }
        catch { resetFlags(); }
      }
      if (needsFinish || movedNode) {
        const nodeIds = this._dragNodeId ? [this._dragNodeId] : [];
        if (nodeIds.length) this._scheduleEdgeRefresh({ nodeIds });
        this._dragNodeId = null;
      }
    };
    const cancel = (event) => {
      this.container.classList.remove("node-dragging");
      if (!active()) return;
      const fallback = event && (event.changedTouches || Number.isFinite(event.clientX))
        ? event
        : new MouseEvent("mouseup", { clientX: this._lastPointer.x, clientY: this._lastPointer.y });
      try { this.editor.dragEnd(fallback); }
      catch { resetFlags(); }
      if (this._dragNodeId) this._scheduleEdgeRefresh({ nodeIds: [this._dragNodeId] });
      this._dragNodeId = null;
    };

    document.addEventListener("mousemove", remember, true);
    document.addEventListener("touchmove", remember, { capture: true, passive: true });
    // Drawflow 只监听画布本身；这里兜底处理在侧栏、顶栏或画布外松手。
    document.addEventListener("mouseup", finish);
    document.addEventListener("touchend", finish);
    document.addEventListener("touchcancel", cancel);
    window.addEventListener("blur", cancel);
  },

  _toggleMulti(id) {
    const el = this.container.querySelector(`#node-${id}`);
    if (this.multi.has(id)) { this.multi.delete(id); el && el.classList.remove("multi-sel"); }
    else { this.multi.add(id); el && el.classList.add("multi-sel"); }
  },

  _clearMulti() {
    for (const id of this.multi) {
      const el = this.container.querySelector(`#node-${id}`);
      el && el.classList.remove("multi-sel");
    }
    this.multi.clear();
  },

  getMultiSelected() { return [...this.multi]; },

  getSelectedNodeIds() {
    const ids = new Set(this.multi);
    if (this.selectedId) ids.add(String(this.selectedId));
    return [...ids].filter((id) => this.state.has(id));
  },

  _clearAllSelection() {
    this.container.querySelectorAll(".drawflow-node.selected, .drawflow-node.multi-sel, .canvas-board.selected").forEach((el) => {
      el.classList.remove("selected", "multi-sel");
    });
    this.multi.clear();
    this.selectedId = null;
    this.selectedBoardId = null;
    if (this.editor) this.editor.node_selected = null;
    this.onSelect(null);
  },

  _selectPastedNodes(ids) {
    this._clearAllSelection();
    if (ids.length === 1) {
      const id = ids[0];
      const el = this.container.querySelector(`#node-${id}`);
      if (el) el.classList.add("selected");
      this.selectedId = id;
      if (this.editor) this.editor.node_selected = el || null;
      this.onSelect(this.state.get(id) || null);
      return;
    }
    for (const id of ids) {
      this.multi.add(id);
      const el = this.container.querySelector(`#node-${id}`);
      if (el) el.classList.add("multi-sel");
    }
  },

  copySelected(notify = true) {
    const ids = this.getSelectedNodeIds().filter((id) => {
      const state = this.state.get(id);
      return state && !state.boundary;
    });
    if (!ids.length) {
      if (notify) this.onToast("请先选择要复制的节点", "err");
      return 0;
    }
    const selected = new Set(ids);
    this._clipboard = this._deepClone({
      nodes: ids.map((id) => this._serializeNode(id)).filter(Boolean),
      edges: this._collectEdges().filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
    });
    this._pasteSerial = 0;
    if (notify) this.onToast(`已复制 ${this._clipboard.nodes.length} 个节点`, "ok");
    return this._clipboard.nodes.length;
  },

  _registerRevived(st, x, y) {
    if (st.type === "machine" && st.recipe) {
      return this._register(st, st.recipe.inputs.length, st.recipe.outputs.length, x, y, "node-machine");
    }
    if (st.type === "source") {
      const outputs = this._normalizeSourceOutputs(st);
      return this._register(st, 0, outputs.length, x, y, "node-source");
    }
    if (st.type === "sink") return this._register(st, 1, 0, x, y, "node-sink");
    if (st.type === "merger") return this._register(st, 1, 1, x, y, "node-merger");
    if (st.type === "portal_in") return this._register(st, 1, 0, x, y, "node-portal-in");
    if (st.type === "portal_out") return this._register(st, 0, 1, x, y, "node-portal-out");
    if (st.type === "blackbox" && st.box) {
      return this._register(st, (st.box.external_inputs || []).length, (st.box.external_outputs || []).length, x, y, "node-blackbox");
    }
    return null;
  },

  _appendNodesEdges(nodes, edges, offset) {
    const idMap = new Map();
    const portalPairMap = new Map();
    const created = [];
    this._beginBatch();
    try {
      for (const sn of nodes) {
        const clone = this._deepClone(sn);
        if ((clone.type === "portal_in" || clone.type === "portal_out") && clone.pair_id) {
          if (!portalPairMap.has(clone.pair_id)) portalPairMap.set(clone.pair_id, this._newPortalPairId());
          clone.pair_id = portalPairMap.get(clone.pair_id);
        }
        const st = this._reviveState(clone);
        const newId = this._registerRevived(st, (Number(sn.x) || 0) + offset, (Number(sn.y) || 0) + offset);
        if (!newId) continue;
        idMap.set(String(sn.id), String(newId));
        created.push(String(newId));
      }
      for (const edge of edges) {
        const from = idMap.get(String(edge.from));
        const to = idMap.get(String(edge.to));
        if (!from || !to) continue;
        try {
          this.editor.addConnection(from, to, `output_${edge.fromPort + 1}`, `input_${edge.toPort + 1}`);
          const edgeId = this._edgeId(from, edge.fromPort, to, edge.toPort);
          this._edgeRules.set(edgeId, normalizeFlowRule(edge));
          const weight = normalizeFlowRule(edge).weight;
          if (Number.isFinite(weight) && weight >= 0 && weight !== 1) this._edgeWeights.set(edgeId, weight);
          const color = typeof edge.color === "string" && /^#[0-9a-f]{6}$/i.test(edge.color) ? edge.color : "";
          const widthValue = edge.width == null || edge.width === "" ? Number.NaN : Number(edge.width);
          const width = Number.isFinite(widthValue) ? Math.max(1, Math.min(12, widthValue)) : null;
          if (color || width != null) this._edgeStyles.set(edgeId, {
            ...(color ? { color } : {}),
            ...(width != null ? { width } : {}),
          });
        } catch { /* 端口不匹配或配方失效时跳过该连线 */ }
      }
      this._syncFlowItems();
      this._batchRecomputePending = true;
    } finally {
      this._endBatch();
    }
    return created;
  },

  pasteClipboard() {
    if (this.readOnly) return [];
    if (!this._clipboard || !this._clipboard.nodes.length) {
      this.onToast("没有可粘贴的节点", "err");
      return [];
    }
    this._pasteSerial += 1;
    const offset = this._pasteSerial * CANVAS_GRID_SIZE * 2;
    const ids = this._appendNodesEdges(this._deepClone(this._clipboard.nodes), this._deepClone(this._clipboard.edges), offset);
    this._selectPastedNodes(ids);
    this.onToast(`已粘贴 ${ids.length} 个节点`, "ok");
    return ids;
  },

  removeSelectedNodes() {
    if (this.readOnly) return 0;
    const ids = this.getSelectedNodeIds().filter((id) => {
      const state = this.state.get(id);
      return state && !state.boundary;
    });
    if (!ids.length) return 0;
    this._clearAllSelection();
    this._beginBatch();
    try {
      for (const id of ids) {
        if (this.state.has(id)) this.editor.removeNodeId(`node-${id}`);
      }
      this._syncFlowItems();
      this._batchRecomputePending = true;
    } finally {
      this._endBatch();
    }
    return ids.length;
  },

  cutSelected() {
    if (this.readOnly) return 0;
    const count = this.copySelected(false);
    if (!count) {
      this.onToast("请先选择要剪切的节点", "err");
      return 0;
    }
    const removed = this.removeSelectedNodes();
    this.onToast(`已剪切 ${removed} 个节点`, "ok");
    return removed;
  }
};
