import { recipes } from "../recipes.js";
import { compute, parseSpeed, fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const historyMethods = {
  _historySnapshot() {
    return this._deepClone({ nodes: this.serializeNodes(), edges: this.serializeEdges(), boards: this.serializeBoards() });
  },

  _historyKey(snapshot) {
    return JSON.stringify(snapshot);
  },

  _notifyHistoryChange() {
    this.onHistoryChange({
      canUndo: !this.readOnly && this._historyIndex > 0,
      canRedo: !this.readOnly && this._historyIndex >= 0 && this._historyIndex < this._history.length - 1,
    });
  },

  resetHistory() {
    this._historyScheduled = false;
    const snapshot = this._historySnapshot();
    this._history = [{ snapshot, key: this._historyKey(snapshot) }];
    this._historyIndex = 0;
    this._notifyHistoryChange();
  },

  _scheduleHistoryCommit() {
    if (this._historyRestoring || this._historyMuted || this.readOnly || this._historyScheduled) return;
    this._historyScheduled = true;
    queueMicrotask(() => {
      this._historyScheduled = false;
      if (this._historyRestoring || this._historyMuted || this.readOnly) return;
      const snapshot = this._historySnapshot();
      const key = this._historyKey(snapshot);
      const current = this._history[this._historyIndex];
      if (current && current.key === key) return;
      this._history.splice(this._historyIndex + 1);
      this._history.push({ snapshot, key });
      if (this._history.length > HISTORY_LIMIT) this._history.shift();
      this._historyIndex = this._history.length - 1;
      this._notifyHistoryChange();
    });
  },

  _restoreHistoryAt(index, message) {
    if (this.readOnly || this._historyRestoring || index < 0 || index >= this._history.length) return false;
    this._historyRestoring = true;
    this._historyIndex = index;
    const snapshot = this._deepClone(this._history[index].snapshot);
    try {
      this.loadFromNodesEdges(snapshot.nodes, snapshot.edges, snapshot.boards || []);
      this._clearAllSelection();
      this.onToast(message, "ok");
    } finally {
      this._historyRestoring = false;
      this._notifyHistoryChange();
    }
    return true;
  },

  undo() {
    if (this._historyIndex <= 0) return false;
    return this._restoreHistoryAt(this._historyIndex - 1, "已撤销");
  },

  redo() {
    if (this._historyIndex >= this._history.length - 1) return false;
    return this._restoreHistoryAt(this._historyIndex + 1, "已重做");
  }
};
