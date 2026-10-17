import { recipes } from "../recipes.js";
import { compute, parseSpeed, fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const boardsMethods = {
  addBoard(data = null) {
    if (this.readOnly || !this.editor || !this.editor.precanvas) return null;
    const pos = this._nextPos();
    const board = this._normalizeBoard(Object.assign({
      id: `board_${Date.now().toString(36)}_${++this._boardSeq}`,
      x: pos.x - 160, y: pos.y - 90, width: 520, height: 320,
      text: "区域标题", color: "blue",
    }, data || {}));
    this.boards.set(board.id, board);
    this._renderBoard(board);
    this._selectBoard(board.id);
    this._updateEmpty();
    this._scheduleHistoryCommit();
    return board.id;
  },

  _normalizeBoard(raw) {
    const color = BOARD_COLORS.some((item) => item.id === raw.color) ? raw.color : "blue";
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    return {
      id: String(raw.id || `board_${Date.now().toString(36)}_${++this._boardSeq}`),
      x: finite(raw.x, 80), y: finite(raw.y, 80),
      width: Math.max(BOARD_MIN_WIDTH, finite(raw.width, 520)),
      height: Math.max(BOARD_MIN_HEIGHT, finite(raw.height, 320)),
      text: String(raw.text == null ? "区域标题" : raw.text).slice(0, 120), color,
    };
  },

  _renderBoard(board) {
    let el = this.editor.precanvas.querySelector(`.canvas-board[data-board-id="${CSS.escape(board.id)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "canvas-board";
      el.dataset.boardId = board.id;
      const title = document.createElement("div");
      title.className = "canvas-board-title";
      title.dataset.role = "board-title";
      title.setAttribute("spellcheck", "false");
      el.appendChild(title);
      const resize = document.createElement("span");
      resize.className = "canvas-board-resize";
      resize.title = "拖动调整大小";
      el.appendChild(resize);
      this.editor.precanvas.prepend(el);
    }
    const color = BOARD_COLORS.find((item) => item.id === board.color) || BOARD_COLORS[5];
    const rgb = color.value.match(/[\da-f]{2}/gi).map((part) => parseInt(part, 16));
    const rgba = (alpha) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
    const titleRgb = rgb.map((channel) => Math.round(channel * 0.7 + 255 * 0.3));
    el.style.left = `${board.x}px`;
    el.style.top = `${board.y}px`;
    el.style.width = `${board.width}px`;
    el.style.height = `${board.height}px`;
    el.style.setProperty("--board-color", color.value);
    el.style.setProperty("--board-bg", rgba(0.18));
    el.style.setProperty("--board-border", rgba(0.66));
    el.style.setProperty("--board-glow", rgba(0.09));
    el.style.setProperty("--board-selected", rgba(0.24));
    el.style.setProperty("--board-selected-glow", rgba(0.12));
    el.style.setProperty("--board-title", `rgb(${titleRgb.join(", ")})`);
    el.dataset.boardColor = board.color;
    el.classList.toggle("selected", this.selectedBoardId === board.id);
    const title = el.querySelector(".canvas-board-title");
    if (title && title.textContent !== board.text) title.textContent = board.text;
    if (title) title.contentEditable = String(!this.readOnly);
    return el;
  },

  _selectBoard(id) {
    const next = id && this.boards.has(String(id)) ? String(id) : null;
    if (next) this._clearAllSelection();
    this.selectedBoardId = next;
    if (!this.editor || !this.editor.precanvas) return;
    this.editor.precanvas.querySelectorAll(".canvas-board.selected").forEach((el) => el.classList.remove("selected"));
    if (next) {
      const el = this.editor.precanvas.querySelector(`.canvas-board[data-board-id="${CSS.escape(next)}"]`);
      if (el) el.classList.add("selected");
    }
  },

  _startBoardGesture(id, event, mode) {
    const board = this.boards.get(String(id));
    if (!board) return;
    this._boardGesture = {
      id: board.id, mode, startX: event.clientX, startY: event.clientY,
      x: board.x, y: board.y, width: board.width, height: board.height,
    };
    this.container.classList.add("board-dragging");
  },

  _updateBoardGesture(event) {
    const gesture = this._boardGesture;
    const board = gesture && this.boards.get(gesture.id);
    if (!board) return;
    const zoom = Number(this.editor.zoom) || 1;
    const dx = (event.clientX - gesture.startX) / zoom;
    const dy = (event.clientY - gesture.startY) / zoom;
    if (gesture.mode === "resize") {
      board.width = Math.max(BOARD_MIN_WIDTH, gesture.width + dx);
      board.height = Math.max(BOARD_MIN_HEIGHT, gesture.height + dy);
    } else {
      board.x = gesture.x + dx;
      board.y = gesture.y + dy;
    }
    this._renderBoard(board);
  },

  _finishBoardGesture() {
    if (!this._boardGesture) return;
    this._boardGesture = null;
    if (this.container) this.container.classList.remove("board-dragging");
    this._scheduleHistoryCommit();
  },

  removeBoard(id) {
    if (this.readOnly) return false;
    id = String(id);
    if (!this.boards.has(id)) return false;
    this.boards.delete(id);
    const el = this.editor.precanvas.querySelector(`.canvas-board[data-board-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
    if (this.selectedBoardId === id) this.selectedBoardId = null;
    this._closeBoardColorMenu();
    this._updateEmpty();
    this._scheduleHistoryCommit();
    return true;
  },

  _openBoardColorMenu(boardId, x, y) {
    this._closeBoardColorMenu();
    this._closeNodeMarkerMenu();
    this._closePortMenu();
    const board = this.boards.get(String(boardId));
    if (!board) return;
    const menu = document.createElement("div");
    menu.className = "board-color-menu";
    menu.innerHTML = `<div class="bcm-title">底板颜色</div><div class="bcm-colors">${BOARD_COLORS.map((color) =>
      `<button type="button" data-color="${color.id}" title="${color.label}" style="--swatch:${color.value}" class="${board.color === color.id ? "active" : ""}"></button>`
    ).join("")}</div>`;
    menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 90)}px`;
    document.body.appendChild(menu);
    this._boardMenuEl = menu;
    menu.querySelectorAll("[data-color]").forEach((button) => button.addEventListener("click", () => {
      board.color = button.dataset.color;
      this._renderBoard(board);
      this._closeBoardColorMenu();
      this._scheduleHistoryCommit();
    }));
    this._boardMenuCloser = (event) => {
      if (this._boardMenuEl === menu && !menu.contains(event.target)) this._closeBoardColorMenu();
    };
    document.addEventListener("mousedown", this._boardMenuCloser, true);
  },

  _closeBoardColorMenu() {
    if (this._boardMenuEl) { this._boardMenuEl.remove(); this._boardMenuEl = null; }
    if (this._boardMenuCloser) {
      document.removeEventListener("mousedown", this._boardMenuCloser, true);
      this._boardMenuCloser = null;
    }
  },

  serializeBoards() { return [...this.boards.values()].map((board) => Object.assign({}, board)); }
};
