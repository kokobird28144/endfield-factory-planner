// graph.js —— Drawflow 画布控制器：节点增删、连线、事件委托、实时计算与视觉更新。
import { recipes } from "./recipes.js";
import { compute, parseSpeed, fmt } from "./engine.js";
import { renderCard } from "./nodeCard.js";
import { esc, iconImg } from "./dom.js";

import { CANVAS_GRID_SIZE, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./graph/constants.js";
import { historyMethods } from "./graph/history.js";
import { selectionMethods } from "./graph/selection.js";
import { boardsMethods } from "./graph/boards.js";
import { edgesMethods } from "./graph/edges.js";
import { menusMethods } from "./graph/menus.js";
import { serializerMethods } from "./graph/serializer.js";
import { pngExportMethods } from "./graph/pngExport.js";
import { portOrderMethods } from "./graph/portOrder.js";

class Graph {
  constructor() {
    this.editor = null;
    this.container = null;
    this.state = new Map();     // id -> nodeState
    this.boards = new Map();    // id -> { id, x, y, width, height, text, color }
    this.multi = new Set();     // 多选（组合黑盒用）
    this.selectedId = null;
    this.selectedBoardId = null;
    this._boardGesture = null;
    this._boardMenuEl = null;
    this._boardMenuCloser = null;
    this._boardSeq = 0;
    this.lastResult = null;
    this._lastEdges = [];
    this._edgeWeights = new Map(); // 边 id -> 权重（仅存非默认值，默认视为 1）
    this._edgeRules = new Map(); // 边 id -> 分配模式、固定目标、优先级及流量上限
    this._edgeStyles = new Map(); // 边 id -> { color?, width? }（只存用户自定义外观）
    this._edgeStyleFrame = 0;
    this._seq = 0;
    this._batchDepth = 0;
    this._batchRecomputePending = false;
    this._recomputeFrame = 0;
    this._edgeRefreshFrame = 0;
    this._edgeRefreshFull = false;
    this._edgeRefreshNodeIds = new Set();
    this._edgeRefreshIndexSource = null;
    this._edgeRefreshById = new Map();
    this._edgeRefreshByNode = new Map();
    this._dragNodeId = null;
    this._lastPointer = { x: 0, y: 0 };
    this._boxSelect = null;
    this._groupDrag = null;
    this._nodeResize = null;
    this._nodeResizeFrame = 0;
    this._sourcePortMutation = false;
    this._flowItemMutation = false;
    this._edgeRetargetMutation = false;
    this._selectedConnection = null;
    this._edgeRetargetDrag = null;
    this._portalSeq = 0;
    this._portalLinkEl = null;
    this._edgeEditorEl = null;
    this._edgeEditorCloser = null;
    this._nodeMarkerMenuEl = null;
    this._nodeMarkerMenuCloser = null;
    this._portMenuEl = null;
    this._portMenuCloser = null;
    this._clipboard = null;
    this._pasteSerial = 0;
    this.snapToGrid = false;
    this.showCardDemand = true;
    this.showEdgeWeight = true;
    this.readOnly = false;
    this._gridSyncFrame = 0;
    this._history = [];
    this._historyIndex = -1;
    this._historyScheduled = false;
    this._historyRestoring = false;
    this._historyMuted = false;
    this.onSelect = () => {};    // (nodeState|null)
    this.onConnectionSelect = () => {}; // (edgeSelection|null)
    this.onChange = () => {};    // 计算完成后回调
    this.onToast = () => {};     // (text, className)
    this.onOpenBlackbox = () => {}; // (nodeState)
    this.onGroupBlackbox = () => {};
    this.onHistoryChange = () => {}; // ({ canUndo, canRedo })
  }

  init(container) {
    this.container = container;
    const editor = new Drawflow(container);
    // 禁用 Drawflow 的连线折点功能；点击连线只用于选择/删除，不再插入控制点变回曲线。
    editor.reroute = false;
    editor.reroute_fix_curvature = false;
    // 输入框等控件永远不应触发 Drawflow 的节点拖动。
    editor.draggable_inputs = false;
    this._enableSelfConnections(editor);
    editor.start();
    this.editor = editor;

    editor.on("nodeCreated", () => {
      this._requestRecompute();
      this._scheduleHistoryCommit();
    });
    editor.on("nodeRemoved", (id) => {
      id = String(id);
      const removedState = this.state.get(id);
      this.state.delete(id);
      this.multi.delete(id);
      if (removedState && (removedState.type === "portal_in" || removedState.type === "portal_out")) this._syncFlowItems();
      this._removePortalLink();
      if (this.selectedId !== id) requestAnimationFrame(() => this._refreshPortalLink());
      if (this.selectedId === id) {
        this.selectedId = null;
        this.onSelect(null);
      }
      this._requestRecompute();
      this._scheduleHistoryCommit();
    });
    editor.on("connectionCreated", (info) => {
      if (this._edgeRetargetMutation) return;
      if (info && !this._sourcePortMutation && !this._flowItemMutation) {
        if (!this._syncFlowItems(info)) return;
        // Imports and pasted edges restore their persisted rules after adding connections.
        if (this._batchDepth === 0) this._initializeConnectionRule(info);
      }
      this._requestRecompute();
      this._scheduleHistoryCommit();
    });
    editor.on("connectionRemoved", (info) => {
      if (this._edgeRetargetMutation) return;
      if (info) {
        if (!this._sourcePortMutation && !this._flowItemMutation) this._syncFlowItems();
        // 连线被删则丢弃分配设置和外观，避免同端口重连时残留旧值
        const edgeId = `${info.output_id}.${info.output_class}->${info.input_id}.${info.input_class}`;
        this._edgeWeights.delete(edgeId);
        this._edgeRules.delete(edgeId);
        this._edgeStyles.delete(edgeId);
        if (this._selectedEdgeId() === edgeId) {
          this._selectedConnection = null;
          this.onConnectionSelect(null);
        }
      }
      this._requestRecompute();
      this._scheduleHistoryCommit();
    });
    editor.on("connectionSelected", (info) => {
      this._selectedConnection = info ? {
        from: String(info.output_id), to: String(info.input_id),
        outputClass: info.output_class, inputClass: info.input_class,
      } : null;
      this.selectedId = null;
      this.onSelect(null);
      this.onConnectionSelect(this.getSelectedConnection());
      requestAnimationFrame(() => this._refreshSelectedConnectionHandles());
    });
    editor.on("connectionUnselected", () => {
      if (this._edgeRetargetDrag) return;
      this._selectedConnection = null;
      this._removeConnectionHandles();
      this.onConnectionSelect(null);
    });
    // 移动节点不改变供需，只需吸附位置并刷新连线，避免松手时同步重算整张大图。
    editor.on("nodeMoved", (id) => {
      id = String(id);
      if (this.snapToGrid) this._snapNodes([id]);
      this._scheduleEdgeRefresh({ nodeIds: [id] });
      this._dragNodeId = null;
      this._scheduleHistoryCommit();
    });
    editor.on("translate", () => this._scheduleGridSync());
    editor.on("zoom", () => this._scheduleGridSync());
    window.addEventListener("resize", () => this._scheduleGridSync());
    this._scheduleGridSync();
    editor.on("nodeSelected", (id) => {
      this._selectBoard(null);
      this.selectedId = String(id);
      this._selectedConnection = null;
      this.onConnectionSelect(null);
      const st = this.state.get(this.selectedId);
      this.onSelect(st || null);
      requestAnimationFrame(() => this._refreshPortalLink());
    });
    editor.on("nodeUnselected", () => {
      this.selectedId = null;
      this._removePortalLink();
      this.onSelect(null);
    });

    this._bindPortReordering();
    this._bindDelegation();
    this._bindDragSafety();
    this._bindKeyboard();
    this.recompute();
    this.resetHistory();
  }

  // ---------------- 事件委托 ----------------
  _bindDelegation() {
    const c = this.container;

    // 只允许从卡片标题栏拖动节点。控件、正文与原生图片拖动不会再抢占画布手势。
    const noDrag = "input, select, textarea, button, a, [contenteditable], [data-no-drag], .toggle-row";
    const guardDragStart = (e) => {
      const boardEl = e.target.closest && e.target.closest(".canvas-board");
      if (boardEl) {
        e.stopImmediatePropagation();
        if (e.type !== "mousedown" || e.button !== 0) return;
        const boardId = boardEl.dataset.boardId;
        this._selectBoard(boardId);
        if (this.readOnly || e.target.closest(".canvas-board-title")) return;
        e.preventDefault();
        this._startBoardGesture(boardId, e, e.target.closest(".canvas-board-resize") ? "resize" : "move");
        return;
      }
      const nodeEl = e.target.closest && e.target.closest(".drawflow-node");
      if (!nodeEl) {
        if (e.type === "mousedown" && e.button === 0) this._selectBoard(null);
        if (e.type === "mousedown" && e.button === 0 && e.shiftKey) {
          e.stopPropagation();
          e.preventDefault();
          this._startBoxSelection(e, e.ctrlKey || e.metaKey);
          return;
        }
        if (!(e.ctrlKey || e.metaKey || e.shiftKey)) this._clearMulti();
        return;
      }
      const connectionDot = e.target.closest(".input, .output");
      if (connectionDot) return;
      if (e.type === "mousedown" && e.button !== 0) {
        e.stopPropagation();
        return;
      }
      if (e.target.closest(noDrag)) {
        e.stopPropagation();
        return;
      }
      if (e.type === "mousedown" && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        e.stopPropagation();
        e.preventDefault();
        this._toggleMulti(nodeEl.id.replace("node-", ""));
        return;
      }
      if (!e.target.closest(".card-head")) {
        e.stopPropagation();
        return;
      }
      const nodeId = nodeEl.id.replace("node-", "");
      if (this.multi.has(nodeId)) {
        if (e.type === "mousedown" && this.multi.size > 1) {
          e.stopPropagation();
          e.preventDefault();
          this._startGroupDrag(nodeId, e);
          c.classList.add("node-dragging");
          return;
        }
      } else {
        this._clearMulti();
      }
      this._dragNodeId = nodeId;
      c.classList.add("node-dragging");
    };
    c.addEventListener("mousedown", guardDragStart, true);
    c.addEventListener("touchstart", guardDragStart, { capture: true, passive: false });
    c.addEventListener("dragstart", (e) => {
      if (e.target.closest && e.target.closest(".drawflow-node")) e.preventDefault();
    }, true);
    document.addEventListener("mousemove", (e) => {
      if (this._boardGesture) this._updateBoardGesture(e);
      if (this._boxSelect) this._updateBoxSelection(e);
      if (this._groupDrag) this._updateGroupDrag(e);
      this._scheduleConnectionRouting();
    }, true);
    c.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest && e.target.closest(".node-resize-handle");
      if (handle && !this.readOnly) this._startNodeResize(handle, e);
    }, true);
    document.addEventListener("pointermove", (e) => {
      this._updateNodeResize(e);
      this._updateEdgeRetarget(e);
    }, true);
    document.addEventListener("touchmove", () => this._scheduleConnectionRouting(), { capture: true, passive: true });
    document.addEventListener("mouseup", (e) => {
      if (this._boardGesture) this._finishBoardGesture();
      if (this._boxSelect) this._finishBoxSelection(e);
      if (this._groupDrag) this._finishGroupDrag();
    }, true);
    document.addEventListener("pointerup", (e) => {
      this._finishNodeResize();
      this._finishEdgeRetarget(e);
    }, true);
    document.addEventListener("pointercancel", () => {
      this._finishNodeResize();
      this._cancelEdgeRetarget();
    }, true);
    window.addEventListener("blur", () => {
      this._finishBoardGesture();
      this._cancelBoxSelection();
      this._finishGroupDrag();
      this._finishNodeResize();
      this._cancelEdgeRetarget();
    });

    c.addEventListener("input", (e) => {
      const role = e.target.getAttribute("data-role");
      if (!role || this.readOnly) return;
      if (role === "board-title") {
        const boardEl = e.target.closest(".canvas-board");
        const board = boardEl && this.boards.get(boardEl.dataset.boardId);
        if (board) board.text = e.target.textContent.slice(0, 120);
        return;
      }
      const st = this._stateOfEl(e.target);
      if (!st) return;
      if (role === "speed") {
        if (st.auto_slow) return;
        st.speed = e.target.value;
        this._scheduleRecompute();
      }
      else if (role === "source-rate") {
        const outputIndex = Number(e.target.getAttribute("data-source-output")) || 0;
        const outputs = this._normalizeSourceOutputs(st);
        if (!outputs[outputIndex]) return;
        outputs[outputIndex].rate = e.target.value;
        this._computePorts(st);
        this._scheduleRecompute();
      }
    });

    // 输入过程中实时计算，但等用户确认或移开焦点后才合并记录为一次撤销操作。
    c.addEventListener("change", (e) => {
      const role = e.target.getAttribute("data-role");
      if (!role || this.readOnly) return;
      if (role === "speed" || role === "source-rate") this._scheduleHistoryCommit();
    });
    c.addEventListener("focusout", (e) => {
      if (e.target.getAttribute("data-role") === "board-title" && !this.readOnly) this._scheduleHistoryCommit();
    });

    // 右键输入口补充来源、输出口选择下游；其他区域选择颜色标记。
    // 捕获阶段阻止 Drawflow 自带的右键“x”删除按钮。
    c.addEventListener("contextmenu", (e) => {
      const boardEl = e.target.closest && e.target.closest(".canvas-board");
      if (boardEl) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this._selectBoard(boardEl.dataset.boardId);
        if (!this.readOnly) this._openBoardColorMenu(boardEl.dataset.boardId, e.clientX, e.clientY);
        return;
      }
      const nodeEl = e.target.closest && e.target.closest(".drawflow-node");
      if (!nodeEl) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.container.querySelectorAll(".drawflow-delete").forEach((element) => element.remove());
      if (this.readOnly) return;

      const contextNodeId = nodeEl.id.replace("node-", "");
      if (this.multi.has(contextNodeId) && this.getMultiSelected().length > 1) {
        this._openNodeMarkerMenu(contextNodeId, e.clientX, e.clientY);
        return;
      }
      const portEl = e.target.closest(".port-row.in[data-pin]");
      if (portEl) {
        const st = this._stateOfEl(portEl);
        if (st && (st.type === "machine" || st.type === "blackbox" || st.type === "merger" || st.type === "portal_in")) {
          const portIdx = parseInt(portEl.getAttribute("data-pin"), 10);
          const port = st.inputPorts && st.inputPorts[portIdx];
          if (port && port.item_id) {
            this._openPortMenu(st.id, portIdx, port.item_id, e.clientX, e.clientY);
            return;
          }
        }
      }
      const outputEl = e.target.closest(".port-row.out[data-pout]");
      if (outputEl) {
        const st = this._stateOfEl(outputEl);
        const portIdx = Number(outputEl.dataset.pout);
        const port = st?.outputPorts?.[portIdx];
        if (port?.item_id) {
          this._openPortMenu(st.id, portIdx, port.item_id, e.clientX, e.clientY, "output");
          return;
        }
      }
      this._openNodeMarkerMenu(nodeEl.id.replace("node-", ""), e.clientX, e.clientY);
    }, true);

    c.addEventListener("click", (e) => {
      const repairPortal = e.target.closest('[data-role="portal-repair"]');
      if (repairPortal) {
        const st = this._stateOfEl(repairPortal);
        if (st && !this.readOnly) this.repairPortalPair(st.id);
        return;
      }
      const openBlackbox = e.target.closest('[data-role="blackbox-open"]');
      if (openBlackbox) {
        const st = this._stateOfEl(openBlackbox);
        if (st && st.type === "blackbox") this.onOpenBlackbox(st);
        return;
      }
      const fold = e.target.closest('[data-role="source-fold"]');
      if (fold) {
        const st = this._stateOfEl(fold);
        if (!st || st.type !== "source" || this.readOnly) return;
        st.source_collapsed = !st.source_collapsed;
        this._rerenderContent(st.id);
        this.recompute();
        this._scheduleHistoryCommit();
        return;
      }
      const tg = e.target.closest('[data-role="autoslow"]');
      if (tg) {
        const st = this._stateOfEl(tg);
        if (!st || this.readOnly) return;
        st.auto_slow = !st.auto_slow;
        const dot = tg.querySelector(".toggle");
        if (dot) dot.classList.toggle("on", st.auto_slow);
        this.recompute();
        this._scheduleHistoryCommit();
      }
    });
  }









  _bindKeyboard() {
    const panCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
    const held = new Set();
    let frame = 0;
    let lastTime = 0;

    const isEditing = () => {
      const el = document.activeElement;
      return !!(el && (el.matches("input, select, textarea, [contenteditable]") || el.isContentEditable));
    };
    const canPan = () => !isEditing() && !document.querySelector(".modal:not([hidden])");
    const stopPan = () => {
      held.clear();
      lastTime = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const tick = (now) => {
      frame = 0;
      if (!held.size || !canPan()) {
        stopPan();
        return;
      }
      const elapsed = lastTime ? Math.min(now - lastTime, 32) : 16;
      lastTime = now;
      let dx = (held.has("KeyA") ? 1 : 0) - (held.has("KeyD") ? 1 : 0);
      let dy = (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0);
      if (dx && dy) {
        dx /= Math.SQRT2;
        dy /= Math.SQRT2;
      }
      const distance = 720 * elapsed / 1000;
      this._panViewBy(dx * distance, dy * distance);
      frame = requestAnimationFrame(tick);
    };

    document.addEventListener("keydown", (e) => {
      if (e.isComposing || isEditing() || document.querySelector(".modal:not([hidden])")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        let handled = false;
        if (e.code === "KeyZ" && !e.repeat) {
          handled = e.shiftKey ? this.redo() : this.undo();
        } else if (e.code === "KeyY" && !e.shiftKey && !e.repeat) {
          handled = this.redo();
        } else if (!e.shiftKey && e.code === "KeyC" && this.getSelectedNodeIds().length) {
          this.copySelected();
          handled = true;
        } else if (!e.shiftKey && e.code === "KeyX" && !this.readOnly && this.getSelectedNodeIds().length) {
          this.cutSelected();
          handled = true;
        } else if (!e.shiftKey && e.code === "KeyV" && !this.readOnly && this._clipboard && !e.repeat) {
          this.pasteClipboard();
          handled = true;
        }
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      if (panCodes.has(e.code)) {
        if (mod || e.altKey || !canPan()) return;
        e.preventDefault();
        held.add(e.code);
        if (!frame) frame = requestAnimationFrame(tick);
        return;
      }
      if (!this.readOnly && (e.key === "Delete" || e.key === "Backspace") && !e.repeat) {
        if (this.selectedBoardId && this.boards.has(this.selectedBoardId)) {
          e.preventDefault();
          e.stopPropagation();
          this.removeBoard(this.selectedBoardId);
          this.onToast("已删除底板");
        } else if (this.getSelectedNodeIds().length) {
          e.preventDefault();
          e.stopPropagation();
          const count = this.removeSelectedNodes();
          this.onToast(`已删除 ${count} 个节点`);
        }
      }
    }, true);
    document.addEventListener("keyup", (e) => {
      if (!panCodes.has(e.code) || !held.has(e.code)) return;
      e.preventDefault();
      held.delete(e.code);
      if (!held.size) stopPan();
    });
    window.addEventListener("blur", stopPan);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopPan();
    });
  }

  _panViewBy(dx, dy) {
    const editor = this.editor;
    if (!editor || !editor.precanvas || (!dx && !dy)) return;
    editor.canvas_x = (Number(editor.canvas_x) || 0) + dx;
    editor.canvas_y = (Number(editor.canvas_y) || 0) + dy;
    const zoom = Number(editor.zoom) || 1;
    editor.precanvas.style.transform =
      `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${zoom})`;
    if (typeof editor.dispatch === "function") {
      editor.dispatch("translate", { x: editor.canvas_x, y: editor.canvas_y });
    }
  }

  setSnapToGrid(enabled) {
    this.snapToGrid = !!enabled;
  }

  setDisplayOptions({ showCardDemand, showEdgeWeight }) {
    if (typeof showCardDemand === "boolean") this.showCardDemand = showCardDemand;
    if (typeof showEdgeWeight === "boolean") this.showEdgeWeight = showEdgeWeight;
    if (this.lastResult) this._updateVisuals(this.lastResult);
  }

  _snapNodes(ids) {
    const editor = this.editor;
    const moduleData = editor && editor.drawflow && editor.drawflow.drawflow[editor.module];
    if (!moduleData || !moduleData.data) return;
    for (const id of ids) {
      const node = moduleData.data[String(id)];
      const el = this.container.querySelector(`#node-${id}`);
      if (!node || !el) continue;
      const oldX = Number(node.pos_x);
      const oldY = Number(node.pos_y);
      if (!Number.isFinite(oldX) || !Number.isFinite(oldY)) continue;
      const x = Math.round(oldX / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
      const y = Math.round(oldY / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
      node.pos_x = x;
      node.pos_y = y;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      editor.updateConnectionNodes(`node-${id}`);
    }
  }

  _scheduleGridSync() {
    if (this._gridSyncFrame) return;
    this._gridSyncFrame = requestAnimationFrame(() => {
      this._gridSyncFrame = 0;
      if (!this.editor || !this.editor.precanvas || !this.container) return;
      const wrap = this.container.closest(".canvas-wrap");
      if (!wrap) return;
      const canvasRect = this.editor.precanvas.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const zoom = Number(this.editor.zoom) || 1;
      wrap.style.setProperty("--canvas-grid-size", `${CANVAS_GRID_SIZE * zoom}px`);
      wrap.style.setProperty("--canvas-grid-x", `${canvasRect.left - wrapRect.left}px`);
      wrap.style.setProperty("--canvas-grid-y", `${canvasRect.top - wrapRect.top}px`);
    });
  }

  _stateOfEl(el) {
    const nodeEl = el.closest(".drawflow-node");
    if (!nodeEl) return null;
    return this.state.get(nodeEl.id.replace("node-", "")) || null;
  }












  // ---------------- 节点创建 ----------------
  _nextPos() {
    const editor = this.editor;
    const zoom = Number(editor && editor.zoom) || 1;
    const canvasX = Number(editor && editor.canvas_x) || 0;
    const canvasY = Number(editor && editor.canvas_y) || 0;
    const width = this.container ? this.container.clientWidth : 800;
    const height = this.container ? this.container.clientHeight : 600;
    // 将约 200×140 的卡片中心放到当前可见画布中心；连续添加时略微错开，避免完全重叠。
    const offset = (this._seq++ % 6) * 18;
    let x = (width / 2 - canvasX) / zoom - 100 + offset;
    let y = (height / 2 - canvasY) / zoom - 70 + offset;
    if (this.snapToGrid) {
      x = Math.round(x / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
      y = Math.round(y / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE;
    }
    return { x, y };
  }

  // ---------------- 画布底板 ----------------










  hasContent() { return this.state.size > 0 || this.boards.size > 0; }

  _normalizeSourceOutputs(st) {
    if (!Array.isArray(st.source_outputs)) {
      st.source_outputs = [{ item_id: st.source_item || "", rate: st.source_rate == null ? "30" : String(st.source_rate) }];
    }
    st.source_outputs = st.source_outputs.map((output) => ({
      item_id: output && output.item_id ? String(output.item_id) : "",
      rate: output && output.rate != null ? String(output.rate) : "30",
    }));
    const first = st.source_outputs[0];
    st.source_item = first ? first.item_id : "";
    st.source_rate = first ? first.rate : "0";
    return st.source_outputs;
  }

  _updateSourceLabel(st) {
    if (st.custom_label) return;
    const outputs = this._normalizeSourceOutputs(st);
    const named = outputs.filter((output) => output.item_id);
    if (outputs.length > 1) st.label = `固定源（${outputs.length} 路）`;
    else st.label = named.length ? recipes.itemName(named[0].item_id) : "固定源";
  }

  _defaultNodeLabel(st) {
    if (!st) return "";
    if (st.type === "machine") return (st.recipe && (st.recipe.displayName || st.recipe.recipe_name)) || "机器";
    if (st.type === "source") {
      const outputs = this._normalizeSourceOutputs(st);
      const named = outputs.filter((output) => output.item_id);
      return outputs.length > 1 ? `固定源（${outputs.length} 路）`
        : (named.length ? recipes.itemName(named[0].item_id) : "固定源");
    }
    if (st.type === "sink") return "最终产物箱";
    if (st.type === "merger") return "汇流分配器";
    if (st.type === "portal_in") return "传送门入口";
    if (st.type === "portal_out") return "传送门出口";
    if (st.type === "blackbox") return (st.box && st.box.name) || "黑盒";
    return st.label || "节点";
  }

  setNodeLabel(id, value, commit = false) {
    if (this.readOnly) return false;
    const st = this.state.get(String(id));
    if (!st || st.boundary) return false;
    const label = String(value == null ? "" : value).slice(0, 80);
    const trimmed = label.trim();
    st.custom_label = !!trimmed;
    st.label = trimmed || this._defaultNodeLabel(st);
    this._rerenderContent(String(id));
    this._scheduleEdgeRefresh({ nodeIds: [String(id)] });
    if (commit) this._scheduleHistoryCommit();
    return true;
  }

  _normalizeBlackboxInputs(box) {
    if (!box) return box;
    const embedded = Array.isArray(box.embedded_inputs) ? box.embedded_inputs : [];
    if (!embedded.length) return box;
    const merged = new Map();
    for (const port of [...(box.external_inputs || []), ...embedded]) {
      if (!port || !port.item_id) continue;
      merged.set(port.item_id, (merged.get(port.item_id) || 0) + (Number(port.rate) || 0));
    }
    box.external_inputs = [...merged].map(([item_id, rate]) => ({ item_id, rate }));
    box.embedded_inputs = [];
    box.component_kind = box.component_kind || "production";
    return box;
  }

  _computePorts(st) {
    if (st.type === "machine") {
      const r = st.recipe;
      st.inputPorts = r.inputs.map((p) => ({ item_id: p.item_id, baseRate: p.rate_per_min, fixed: !!p.fixed }));
      st.outputPorts = r.outputs.map((p) => ({ item_id: p.item_id, baseRate: p.rate_per_min, fixed: !!p.fixed }));
    } else if (st.type === "source") {
      st.inputPorts = [];
      st.outputPorts = this._normalizeSourceOutputs(st).map((output) => ({
        item_id: output.item_id || null,
        baseRate: parseSpeed(output.rate, 0),
      }));
    } else if (st.type === "sink") {
      st.inputPorts = Array.isArray(st.sink_inputs)
        ? st.sink_inputs.map((port) => ({ item_id: port.item_id || null, baseRate: 0 }))
        : [{ item_id: null, baseRate: 0 }];
      st.outputPorts = [];
    } else if (st.type === "merger") {
      const itemId = st.item_id || null;
      st.inputPorts = [{ item_id: itemId, baseRate: 0 }];
      st.outputPorts = [{ item_id: itemId, baseRate: 0 }];
    } else if (st.type === "portal_in") {
      st.inputPorts = [{ item_id: st.item_id || null, baseRate: 0 }];
      st.outputPorts = [];
    } else if (st.type === "portal_out") {
      st.inputPorts = [];
      st.outputPorts = [{ item_id: st.item_id || null, baseRate: 0 }];
    } else if (st.type === "blackbox") {
      const b = this._normalizeBlackboxInputs(st.box);
      st.inputPorts = (b.external_inputs || []).map((x) => ({ item_id: x.item_id, baseRate: Number(x.rate) || 0 }));
      st.outputPorts = (b.external_outputs || []).map((x) => ({ item_id: x.item_id, baseRate: Number(x.rate) || 0 }));
    }
  }

  _ensureNodeResizeHandle(id) {
    const node = this.container.querySelector(`#node-${id}`);
    if (!node || node.querySelector(":scope > .node-resize-handle")) return;
    const handle = document.createElement("span");
    handle.className = "node-resize-handle";
    handle.title = "拖动调整卡片宽度";
    handle.setAttribute("aria-hidden", "true");
    node.appendChild(handle);
  }

  _applyNodeWidth(id) {
    const state = this.state.get(String(id));
    const node = this.container.querySelector(`#node-${id}`);
    if (!state || !node) return;
    const width = Number(state.card_width);
    if (Number.isFinite(width) && width > 0) {
      const clamped = Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, width));
      state.card_width = clamped;
      node.style.width = `${clamped}px`;
      node.style.minWidth = `${clamped}px`;
    } else {
      node.style.removeProperty("width");
      node.style.removeProperty("min-width");
      const row = node.querySelector(".speed-row");
      if (row) {
        // 用未缩放的布局尺寸计算刚好容纳整行控件的宽度。
        // 只临时禁止换行，手动缩窄的卡片仍保留原有布局行为。
        const frameWidth = parseFloat(getComputedStyle(node).width) - parseFloat(getComputedStyle(row).width);
        row.style.width = "max-content";
        row.style.whiteSpace = "nowrap";
        const compactWidth = Math.max(NODE_MIN_WIDTH, Math.ceil(frameWidth + parseFloat(getComputedStyle(row).width)));
        row.style.removeProperty("width");
        row.style.removeProperty("white-space");
        node.style.width = `${compactWidth}px`;
        node.style.minWidth = `${compactWidth}px`;
      }
    }
  }

  _startNodeResize(handle, event) {
    const node = handle.closest(".drawflow-node");
    if (!node || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = node.id.replace("node-", "");
    const minWidth = NODE_MIN_WIDTH;
    this._nodeResize = {
      id, node, startX: event.clientX, startWidth: node.offsetWidth,
      minWidth, pendingWidth: node.offsetWidth, changed: false,
    };
    node.classList.add("is-resizing");
    this.container.classList.add("node-resizing");
  }

  _applyPendingNodeResize() {
    const resize = this._nodeResize;
    if (!resize) return;
    const width = Math.max(resize.minWidth, Math.min(NODE_MAX_WIDTH, resize.pendingWidth));
    const state = this.state.get(resize.id);
    if (!state) return;
    state.card_width = width;
    resize.node.style.width = `${width}px`;
    resize.node.style.minWidth = `${width}px`;
    this._alignPorts(resize.id);
    this._scheduleEdgeRefresh({ nodeIds: [resize.id] });
  }

  _updateNodeResize(event) {
    const resize = this._nodeResize;
    if (!resize) return;
    const zoom = Number(this.editor && this.editor.zoom) || 1;
    resize.pendingWidth = resize.startWidth + (event.clientX - resize.startX) / zoom;
    resize.changed = resize.changed || Math.abs(resize.pendingWidth - resize.startWidth) >= 1;
    if (this._nodeResizeFrame) return;
    this._nodeResizeFrame = requestAnimationFrame(() => {
      this._nodeResizeFrame = 0;
      this._applyPendingNodeResize();
    });
  }

  _finishNodeResize() {
    const resize = this._nodeResize;
    if (!resize) return;
    if (this._nodeResizeFrame) {
      cancelAnimationFrame(this._nodeResizeFrame);
      this._nodeResizeFrame = 0;
    }
    this._applyPendingNodeResize();
    resize.node.classList.remove("is-resizing");
    this.container.classList.remove("node-resizing");
    this._nodeResize = null;
    if (resize.changed) this._scheduleHistoryCommit();
  }

  _register(st, nIn, nOut, x, y, className) {
    this._computePorts(st);
    const html = renderCard(st);
    const id = this.editor.addNode(st.type, nIn, nOut, x, y, className, {}, html);
    st.id = String(id);
    this.state.set(st.id, st);
    this._ensureNodeResizeHandle(st.id);
    this._applyNodeWidth(st.id);
    // Drawflow 会在 state 注册前同步触发 nodeCreated；那次重算看不到新节点，
    // 因而端点会保留默认 top:2px 挤在两侧顶部。注册后立即补一次对齐与重算，
    // 下一帧再对齐一次，确保浏览器完成新卡片布局后位置仍准确。
    this._applyNodeMarker(st.id);
    this._applyPortOrder(st.id);
    this._alignPorts(st.id);
    requestAnimationFrame(() => {
      if (this.state.has(st.id)) this._alignPorts(st.id);
    });
    this._requestRecompute();
    return st.id;
  }

  addRecipeNode(recipe, x, y) {
    if (this.readOnly) return null;
    const pos = (x == null) ? this._nextPos() : { x, y };
    const st = {
      type: "machine", recipe, recipeKey: recipe.key,
      // 特殊配方（废水处理机 / 净流节点）默认开启自动降速：喂多少处理多少，不因喂不满而报红
      label: recipe.displayName || recipe.recipe_name, speed: "1", auto_slow: !!recipe.special,
    };
    return this._register(st, recipe.inputs.length, recipe.outputs.length, pos.x, pos.y, "node-machine");
  }

  addSource(x, y) {
    if (this.readOnly) return null;
    const pos = (x == null) ? this._nextPos() : { x, y };
    const st = {
      type: "source", label: "固定源", source_item: "", source_rate: "30",
      source_outputs: [{ item_id: "", rate: "30" }], source_collapsed: false,
      speed: "1", auto_slow: false,
    };
    return this._register(st, 0, 1, pos.x, pos.y, "node-source");
  }

  addSink(x, y) {
    if (this.readOnly) return null;
    const pos = (x == null) ? this._nextPos() : { x, y };
    const st = { type: "sink", label: "最终产物箱", box_kind: "final", speed: "1", auto_slow: false };
    return this._register(st, 1, 0, pos.x, pos.y, "node-sink");
  }

  addMerger(x, y) {
    if (this.readOnly) return null;
    const pos = (x == null) ? this._nextPos() : { x, y };
    const st = {
      type: "merger", label: "汇流分配器", item_id: "",
      speed: "1", auto_slow: false,
    };
    return this._register(st, 1, 1, pos.x, pos.y, "node-merger");
  }

  _newPortalPairId() {
    return `portal_${Date.now().toString(36)}_${++this._portalSeq}`;
  }

  _portalPartner(state) {
    if (!state || !state.pair_id) return null;
    for (const candidate of this.state.values()) {
      if (candidate.id !== state.id && candidate.pair_id === state.pair_id &&
          ((state.type === "portal_in" && candidate.type === "portal_out") ||
           (state.type === "portal_out" && candidate.type === "portal_in"))) return candidate;
    }
    return null;
  }

  _createPortalNode(type, pairId, itemId, x, y) {
    const isInput = type === "portal_in";
    const state = {
      type, pair_id: pairId, item_id: itemId || "", portal_connected: false,
      label: isInput ? "传送门入口" : "传送门出口", speed: "1", auto_slow: false,
    };
    return this._register(state, isInput ? 1 : 0, isInput ? 0 : 1, x, y,
      isInput ? "node-portal-in" : "node-portal-out");
  }

  addPortalPair(x, y) {
    if (this.readOnly) return null;
    const pos = x == null ? this._nextPos() : { x, y };
    const pairId = this._newPortalPairId();
    let inputId = null;
    let outputId = null;
    this._beginBatch();
    try {
      inputId = this._createPortalNode("portal_in", pairId, "", pos.x - 155, pos.y);
      outputId = this._createPortalNode("portal_out", pairId, "", pos.x + 155, pos.y);
      this._syncFlowItems();
      this._batchRecomputePending = true;
    } finally {
      this._endBatch();
    }
    this._scheduleHistoryCommit();
    return { pair_id: pairId, inputId, outputId };
  }

  repairPortalPair(id) {
    if (this.readOnly) return null;
    const state = this.state.get(String(id));
    if (!state || !state.type.startsWith("portal_") || this._portalPartner(state)) return null;
    const data = this.editor.drawflow.drawflow.Home.data[String(id)];
    const partnerType = state.type === "portal_in" ? "portal_out" : "portal_in";
    const x = (Number(data && data.pos_x) || 100) + (partnerType === "portal_out" ? 310 : -310);
    const y = Number(data && data.pos_y) || 100;
    const partnerId = this._createPortalNode(partnerType, state.pair_id, state.item_id, x, y);
    this._syncFlowItems();
    this._requestRecompute();
    this._scheduleHistoryCommit();
    this.onToast("已重新创建配对传送门", "ok");
    requestAnimationFrame(() => this._refreshPortalLink());
    return partnerId;
  }

  addBlackbox(component, x, y) {
    if (this.readOnly) return null;
    this._normalizeBlackboxInputs(component);
    const pos = (x == null) ? this._nextPos() : { x, y };
    const st = {
      type: "blackbox", box: component, component_id: component.id,
      label: component.name, speed: "1", auto_slow: false,
    };
    const nIn = (component.external_inputs || []).length;
    const nOut = (component.external_outputs || []).length;
    return this._register(st, nIn, nOut, pos.x, pos.y, "node-blackbox");
  }

  _rerenderContent(id) {
    const st = this.state.get(id);
    if (!st) return;
    const content = this.container.querySelector(`#node-${id} .drawflow_content_node`);
    if (content) content.innerHTML = renderCard(st);
    this._ensureNodeResizeHandle(id);
    this._applyNodeWidth(id);
    this._applyNodeMarker(id);
    this._applyPortOrder(id);
    this._alignPorts(id);
  }

  // 把每个 Drawflow 连接点（左侧输入 / 右侧输出的小圆点）
  // 竖直对齐到卡片内对应的端口行，并挂上物料名 tooltip，
  // 这样一眼就能看出「哪个点是什么材料」。连线端点由 Drawflow 按点的实际
  // DOM 位置计算，对齐后调用 updateConnectionNodes 让已有连线跟随。

  // ---------------- 固定源：多输出管理与物品推断 ----------------
  addSourceOutput(id) {
    if (this.readOnly) return false;
    const st = this.state.get(String(id));
    if (!st || st.type !== "source") return false;
    const outputs = this._normalizeSourceOutputs(st);
    outputs.push({ item_id: "", rate: "30" });
    this.editor.addNodeOutput(String(id));
    this._updateSourceLabel(st);
    this._computePorts(st);
    this._rerenderContent(String(id));
    this.recompute();
    this._scheduleHistoryCommit();
    return true;
  }

  removeSourceOutput(id, outputIndex) {
    if (this.readOnly) return false;
    id = String(id);
    const st = this.state.get(id);
    const outputs = st && st.type === "source" ? this._normalizeSourceOutputs(st) : null;
    if (!outputs || !Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= outputs.length) return false;
    const oldWeights = [...this._edgeWeights.entries()];
    const oldRules = [...this._edgeRules.entries()];
    const oldStyles = [...this._edgeStyles.entries()];
    this._beginBatch();
    this._sourcePortMutation = true;
    try {
      this.editor.removeNodeOutput(id, `output_${outputIndex + 1}`);
      outputs.splice(outputIndex, 1);
      if (Array.isArray(st.port_order)) {
        st.port_order = st.port_order.filter((key) => key !== `out:${outputIndex}`).map((key) => {
          const match = /^out:(\d+)$/.exec(key);
          return match && Number(match[1]) > outputIndex ? `out:${Number(match[1]) - 1}` : key;
        });
      }
      const prefix = `${id}.output_`;
      for (const key of [...this._edgeRules.keys()]) {
        if (key.startsWith(prefix)) this._edgeRules.delete(key);
      }
      for (const [key, rule] of oldRules) {
        if (!key.startsWith(prefix)) continue;
        const match = key.match(/\.output_(\d+)->/);
        if (!match) continue;
        const oldIndex = Number(match[1]) - 1;
        if (oldIndex === outputIndex) continue;
        const newIndex = oldIndex > outputIndex ? oldIndex - 1 : oldIndex;
        this._edgeRules.set(key.replace(`.output_${oldIndex + 1}->`, `.output_${newIndex + 1}->`), rule);
      }
      for (const key of [...this._edgeWeights.keys()]) {
        if (key.startsWith(prefix)) this._edgeWeights.delete(key);
      }
      for (const [key, weight] of oldWeights) {
        if (!key.startsWith(prefix)) continue;
        const match = key.match(/\.output_(\d+)->/);
        if (!match) continue;
        const oldIndex = Number(match[1]) - 1;
        if (oldIndex === outputIndex) continue;
        const newIndex = oldIndex > outputIndex ? oldIndex - 1 : oldIndex;
        this._edgeWeights.set(key.replace(`.output_${oldIndex + 1}->`, `.output_${newIndex + 1}->`), weight);
      }
      for (const key of [...this._edgeStyles.keys()]) {
        if (key.startsWith(prefix)) this._edgeStyles.delete(key);
      }
      for (const [key, style] of oldStyles) {
        if (!key.startsWith(prefix)) continue;
        const match = key.match(/\.output_(\d+)->/);
        if (!match) continue;
        const oldIndex = Number(match[1]) - 1;
        if (oldIndex === outputIndex) continue;
        const newIndex = oldIndex > outputIndex ? oldIndex - 1 : oldIndex;
        this._edgeStyles.set(key.replace(`.output_${oldIndex + 1}->`, `.output_${newIndex + 1}->`), style);
      }
      this._updateSourceLabel(st);
      this._computePorts(st);
      this._rerenderContent(id);
      this._batchRecomputePending = true;
    } finally {
      this._sourcePortMutation = false;
      this._endBatch();
    }
    this._scheduleHistoryCommit();
    return true;
  }

  // 固定源与汇流分配器沿连线反复传播物料；分配器只允许一种物料。


  // ---------------- 右键节点：颜色标记 ----------------



  // ---------------- 右键端口：反查配方 / 固定源，一键补链 ----------------


  // 新建能生产 target 某输入物品的配方节点，并接到该输入口。

  // 新建固定源并接到 target 某输入口（物品由连线自动推断）。

  // ---------------- 计算与视觉 ----------------
  // 由 from/to 端口构造稳定的边 id（与 _collectEdges 保持一致）。


  buildModel() {
    const nodes = [...this.state.values()].map((st) => ({
      id: st.id, type: st.type, speed: st.speed, auto_slow: st.auto_slow,
      pair_id: st.pair_id || null,
      inputPorts: st.inputPorts, outputPorts: st.outputPorts,
    }));
    const edges = this._collectEdges();
    this._lastEdges = edges;
    return { nodes, edges };
  }







  _requestRecompute() {
    this._scheduleRecompute();
  }

  _scheduleRecompute() {
    if (this._batchDepth > 0) {
      this._batchRecomputePending = true;
      return;
    }
    if (this._recomputeFrame) return;
    this._recomputeFrame = requestAnimationFrame(() => {
      this._recomputeFrame = 0;
      this.recompute();
    });
  }

  _beginBatch() { this._batchDepth += 1; }
  _endBatch() {
    this._batchDepth = Math.max(0, this._batchDepth - 1);
    if (this._batchDepth === 0 && this._batchRecomputePending) {
      this._batchRecomputePending = false;
      this.recompute();
    }
  }

  // ---------------- 已有连线端点重接 ----------------

















  recompute() {
    if (!this.editor) return;
    if (this._recomputeFrame) {
      cancelAnimationFrame(this._recomputeFrame);
      this._recomputeFrame = 0;
    }
    const model = this.buildModel();
    const result = compute(model);
    this.lastResult = result;
    this._updateVisuals(result);
    this._updateEmpty();
    this.onChange(result);
  }

  _updateEmpty() {
    const empty = document.getElementById("canvasEmpty");
    if (empty) empty.style.display = this.hasContent() ? "none" : "grid";
  }

  _updateVisuals(result) {
    const c = this.container;
    for (const [id, res] of result.nodes) {
      const el = c.querySelector(`#node-${id}`);
      if (!el) continue;
      // 端口只在卡片结构变化时重新对齐；流量重算不会改变端口布局。
      el.classList.toggle("node-warn", res.warn);
      const st = this.state.get(String(id));
      const speedInput = el.querySelector('[data-role="speed"]');
      if (st && speedInput) {
        const disabled = !!st.auto_slow;
        const value = disabled ? fmt(res.effectiveSpeed) : st.speed;
        if (speedInput.disabled !== disabled) speedInput.disabled = disabled;
        if (speedInput.value !== value) speedInput.value = value;
      }
      res.inputs.forEach((ip, i) => {
        const row = el.querySelector(`[data-pin="${i}"]`);
        if (!row) return;
        const rate = row.querySelector("[data-rate]");
        const text = st && st.type === "merger"
          ? fmt(ip.supply)
          : (this.showCardDemand ? `${fmt(ip.supply)}/${fmt(ip.required)}` : fmt(ip.supply));
        if (rate && rate.textContent !== text) rate.textContent = text;
        row.classList.toggle("warn", ip.warn);
      });
      res.outputs.forEach((op, i) => {
        const row = el.querySelector(`[data-pout="${i}"]`);
        if (!row) return;
        const rate = row.querySelector("[data-rate]");
        const text = fmt(op.production);
        if (rate && rate.textContent !== text) rate.textContent = text;
        row.classList.toggle("warn", op.warn);
        if (op.reason === "unhandled") {
          row.title = op.unallocated > 0.01
            ? `产出 ${fmt(op.production)}/分，其中 ${fmt(op.unallocated)}/分尚未分配；可添加权重路径承接余量`
            : `产出 ${fmt(op.production)} 未接入下游、也没有产物箱收集，产物没去处`;
        } else if (op.reason === "shortage") {
          row.title = `下游需求 ${fmt(op.demand)}，产出仅 ${fmt(op.production)}`;
        } else {
          row.removeAttribute("title");
        }
      });
      const inflowEl = el.querySelector('[data-role="inflow"]');
      if (inflowEl) {
        const placeholder = el.querySelector(".in-any");
        if (placeholder) {
          placeholder.hidden = res.inflow.length > 0;
          const inputRow = placeholder.querySelector(".port-row");
          if (placeholder.hidden) inputRow.removeAttribute("data-pin");
          else inputRow.setAttribute("data-pin", "0");
        }
        const html = res.inflow.length
          ? res.inflow.map((x, index) => {
              return `<div class="port-row in" data-row-key="item:${esc(x.item_id)}"${index === 0 ? ' data-pin="0"' : ""}>${iconImg(x.item_id, "p-icon")}` +
                `<span class="p-name">${esc(recipes.itemName(x.item_id))}</span>` +
                `<span class="p-rate" style="color:var(--green)">${fmt(x.rate)}</span></div>`;
            }).join("")
          : '<div class="muted">暂无流入</div>';
        if (inflowEl._renderedHtml !== html) {
          inflowEl.innerHTML = html;
          inflowEl._renderedHtml = html;
        }
      }
      if (this._applyPortOrder(id) || inflowEl) this._alignPorts(id);
    }
    if (this._edgeRefreshFrame) {
      cancelAnimationFrame(this._edgeRefreshFrame);
      this._edgeRefreshFrame = 0;
      this._edgeRefreshFull = false;
      this._edgeRefreshNodeIds.clear();
    }
    this._refreshEdges(result);
    this._refreshPortalLink();
  }


  // 将 Drawflow 默认的贝塞尔曲线改成正交折线。
  // 正向连接使用横-竖-横三段；目标位于源节点左侧时，若两张卡片上下错开，
  // 优先从两张卡片之间的空隙绕行；只有卡片纵向重叠、没有中间通道时才走外侧。

  // 在连线中点上方绘制流量数值（SVG <text>），带描边以便在网格/连线上清晰可读。
  // 标签显示分配设置及实际流量；点击标签编辑模式和参数。

  // 路径分配编辑：固定目标 → 优先级（可选上限）→ 权重余量。


  // ---------------- PNG 导出 ----------------

  // ---------------- 视图状态 / 缩放 / 清空 ----------------
  setReadOnly(enabled) {
    this.readOnly = !!enabled;
    if (this.editor) this.editor.editor_mode = this.readOnly ? "view" : "edit";
    if (this.container) this.container.classList.toggle("is-readonly", this.readOnly);
    if (this.editor && this.editor.precanvas) {
      this.editor.precanvas.querySelectorAll(".canvas-board-title").forEach((title) => {
        title.contentEditable = String(!this.readOnly);
      });
    }
    if (this.readOnly) {
      this._finishPortSort(true);
      this._finishBoardGesture();
      this._finishNodeResize();
      this._closeBoardColorMenu();
    }
    this._notifyHistoryChange();
  }



  zoomIn() { this.editor.zoom_in(); }
  zoomOut() { this.editor.zoom_out(); }
  zoomReset() { this.editor.zoom_reset(); }

  removeNode(id) {
    id = String(id);
    if (this.readOnly || !this.state.has(id)) return false;
    this.editor.removeNodeId(`node-${id}`);
    return true;
  }

  clearSelection() {
    this._clearAllSelection();
  }

  getLastResult() {
    return this.lastResult;
  }

  getConnectedEdges(id) {
    id = String(id);
    if (!this.state.has(id)) return [];
    const result = this.lastResult;
    return this._collectEdges()
      .filter((edge) => edge.from === id || edge.to === id)
      .map((edge) => {
        const incoming = edge.to === id;
        const peerId = incoming ? edge.from : edge.to;
        const peer = this.state.get(peerId);
        if (peer) this._computePorts(peer);
        const source = this.state.get(edge.from);
        if (source) this._computePorts(source);
        const edgeResult = result && result.edges.get(edge.id);
        const itemId = (edgeResult && edgeResult.item_id) ||
          (source && source.outputPorts[edge.fromPort] && source.outputPorts[edge.fromPort].item_id) || null;
        return {
          id: edge.id,
          direction: incoming ? "in" : "out",
          peerId,
          peerLabel: peer ? (peer.label || this._defaultNodeLabel(peer)) : `节点 ${peerId}`,
          itemId,
          rate: edgeResult ? edgeResult.rate : 0,
          weight: edgeResult ? edgeResult.weight : edge.weight,
          mode: edge.mode,
          fixedRate: edge.fixedRate,
          priority: edge.priority,
          maxRate: edge.maxRate,
          fromPort: edge.fromPort,
          toPort: edge.toPort,
          warn: !!(edgeResult && edgeResult.warn),
        };
      });
  }

  focusNode(id) {
    id = String(id);
    const node = this.editor && this.editor.drawflow.drawflow.Home.data[id];
    const element = this.container && this.container.querySelector(`#node-${id}`);
    if (!node || !element) return false;
    this._clearAllSelection();
    const zoom = Number(this.editor.zoom) || 1;
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;
    const nodeWidth = element.offsetWidth || 240;
    const nodeHeight = element.offsetHeight || 160;
    this.editor.canvas_x = width / 2 - (Number(node.pos_x) + nodeWidth / 2) * zoom;
    this.editor.canvas_y = height / 2 - (Number(node.pos_y) + nodeHeight / 2) * zoom;
    this.editor.precanvas.style.transform =
      `translate(${this.editor.canvas_x}px, ${this.editor.canvas_y}px) scale(${zoom})`;
    this.container.querySelectorAll(".drawflow-node.selected").forEach((item) => item.classList.remove("selected"));
    element.classList.add("selected");
    this.selectedId = id;
    this.editor.node_selected = element;
    this.onSelect(this.state.get(id) || null);
    this._scheduleGridSync();
    requestAnimationFrame(() => this._refreshPortalLink());
    return true;
  }

  focusItem(itemId) {
    for (const state of this.state.values()) {
      this._computePorts(state);
      const items = [...(state.inputPorts || []), ...(state.outputPorts || [])].map((port) => port.item_id);
      if (items.includes(itemId)) return this.focusNode(state.id);
    }
    return false;
  }

  clear(force = false) {
    if (this.readOnly && !force) return false;
    this._finishPortSort(true);
    this._closeNodeMarkerMenu();
    this._closeBoardColorMenu();
    this._finishBoardGesture();
    this._finishNodeResize();
    this._cancelEdgeRetarget();
    this._selectedConnection = null;
    this._removeConnectionHandles();
    this._removePortalLink();
    this.editor.clear();
    this.state.clear();
    this.boards.clear();
    this.multi.clear();
    this._edgeWeights.clear();
    this._edgeRules.clear();
    this._edgeStyles.clear();
    this.selectedId = null;
    this.selectedBoardId = null;
    this.onSelect(null);
    this.onConnectionSelect(null);
    this._requestRecompute();
    this._scheduleHistoryCommit();
    return true;
  }

  // ---------------- 组合黑盒 ----------------
  // 依据一组节点构造黑盒组件定义（内部节点/边 + 对外接口）。
  // 对外接口取「内部子图的净产消」：选区内既生产又消耗的物料（回收流 / 中间品）相互抵消，
  // 只暴露净缺口（对外输入）与净盈余（对外输出）。这样即便内部的生产者与消费者未直接连线，
  // 只要同在选区内也能正确抵消，不会把已在内部被消化掉的中间品（如惰性废液）误列为对外输出，
  // 也不会因同一输入口有多个来源（回收流 + 新鲜流）而重复累加需求。


  // 由当前多选构造组件（「组合为黑盒」用）；自动带上覆盖所选节点的底板。

  // 由画布上全部节点构造组件（编辑组件后保存用）


  // ---------------- 序列化（供 topology 使用） ----------------




  // 由序列化节点还原运行时 state（不含 id 注册）

  // 加载：清空后按序列化节点/边/底板重建
}

Object.assign(Graph.prototype, historyMethods, selectionMethods, boardsMethods, edgesMethods, menusMethods, serializerMethods, pngExportMethods, portOrderMethods);

export const graph = new Graph();
