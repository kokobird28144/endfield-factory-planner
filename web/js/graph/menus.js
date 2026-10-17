import { recipes } from "../recipes.js";
import { compute, parseSpeed, fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const menusMethods = {
  _applyNodeMarker(id) {
    const state = this.state.get(String(id));
    const nodeEl = this.container.querySelector(`#node-${id}`);
    if (!state || !nodeEl) return;
    const color = NODE_MARKER_COLORS.find((item) => item.id === state.marker_color);
    if (color) {
      nodeEl.classList.add("has-node-marker");
      nodeEl.style.setProperty("--node-marker-color", color.value);
      nodeEl.dataset.markerColor = color.id;
    } else {
      nodeEl.classList.remove("has-node-marker");
      nodeEl.style.removeProperty("--node-marker-color");
      delete nodeEl.dataset.markerColor;
    }
  },

  _openNodeMarkerMenu(nodeId, x, y) {
    this._closeNodeMarkerMenu();
    this._closeBoardColorMenu();
    this._closePortMenu();
    const state = this.state.get(String(nodeId));
    if (!state || state.boundary) return;
    const menu = document.createElement("div");
    menu.className = "node-marker-menu";
    menu.innerHTML = `<div class="nmm-title">卡片标记</div><div class="nmm-colors">` +
      NODE_MARKER_COLORS.map((color) =>
        `<button type="button" class="nmm-color${state.marker_color === color.id ? " selected" : ""}" ` +
        `data-color="${color.id}" title="${color.label}" style="--swatch:${color.value}"></button>`
      ).join("") +
      `</div><button type="button" class="nmm-clear" data-color="">清除标记</button>`;
    if (this.multi.has(String(nodeId)) && this.getMultiSelected().length > 1) {
      const group = document.createElement("button");
      group.type = "button";
      group.className = "nmm-clear nmm-group";
      group.textContent = "组合为黑盒";
      group.addEventListener("click", () => { this._closeNodeMarkerMenu(); this.onGroupBlackbox(); });
      menu.prepend(group);
    }
    document.body.appendChild(menu);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - height - 8)) + "px";
    this._nodeMarkerMenuEl = menu;

    menu.querySelectorAll("[data-color]").forEach((button) => {
      button.addEventListener("click", () => {
        if (this._nodeMarkerMenuEl !== menu) return;
        state.marker_color = button.dataset.color || "";
        this._applyNodeMarker(nodeId);
        this._closeNodeMarkerMenu();
        this._scheduleHistoryCommit();
      });
    });
    this._nodeMarkerMenuCloser = (event) => {
      if (this._nodeMarkerMenuEl === menu && !menu.contains(event.target)) this._closeNodeMarkerMenu();
    };
    document.addEventListener("mousedown", this._nodeMarkerMenuCloser, true);
  },

  _closeNodeMarkerMenu() {
    if (this._nodeMarkerMenuEl) {
      this._nodeMarkerMenuEl.remove();
      this._nodeMarkerMenuEl = null;
    }
    if (this._nodeMarkerMenuCloser) {
      document.removeEventListener("mousedown", this._nodeMarkerMenuCloser, true);
      this._nodeMarkerMenuCloser = null;
    }
  },

  _openPortMenu(nodeId, portIdx, itemId, x, y, direction = "input") {
    this._closeNodeMarkerMenu();
    this._closeBoardColorMenu();
    this._closePortMenu();
    const downstream = direction === "output";
    const candidates = downstream ? recipes.consumersOf(itemId) : recipes.producersOf(itemId);
    const itemName = recipes.itemName(itemId);
    const menu = document.createElement("div");
    menu.className = "port-menu";
    let html = `<div class="pm-title">为「${esc(itemName)}」${downstream ? "选择下游" : "接入来源"}</div><div class="pm-scroll">`;
    if (candidates.length) {
      html += candidates.map((rec) => {
        const out = rec.outputs[0] && rec.outputs[0].item_id;
        return `<div class="pm-item" data-kind="recipe" data-key="${esc(rec.key)}">` +
          iconImg(out || itemId, "pm-icon") +
          `<span class="pm-name">${esc(rec.displayName || rec.recipe_name)}${rec.temporary ? ' <b class="tmp-tag">临时</b>' : ""}</span>` +
          `<span class="pm-sub">${esc(rec.duplicateName ? `${rec.recipe_name} · ${rec.facility_name_cn}` : rec.facility_name_cn)}</span></div>`;
      }).join("");
    } else {
      html += `<div class="pm-empty">${downstream ? "没有使用该物品的下游配方" : "没有能生产该物品的配方"}</div>`;
    }
    html += `</div>`;
    if (!downstream) html += `<div class="pm-item pm-source" data-kind="source">▶ 固定源（按固定速率供给）</div>`;
    menu.innerHTML = html;
    document.body.appendChild(menu);

    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + "px";
    this._portMenuEl = menu;
    this._portMenuKeyCloser = (event) => {
      if (event.key === "Escape") this._closePortMenu();
    };
    document.addEventListener("keydown", this._portMenuKeyCloser);

    menu.querySelectorAll(".pm-item").forEach((el) => {
      el.addEventListener("click", () => {
        if (this._portMenuEl !== menu || this.readOnly) return;
        const kind = el.getAttribute("data-kind");
        if (kind === "recipe") {
          const rec = recipes.getByKey(el.getAttribute("data-key"));
          if (rec) {
            if (downstream) this.addConsumerFor(nodeId, portIdx, rec);
            else this.addProducerFor(nodeId, portIdx, rec);
          }
        } else if (kind === "source") {
          this.addSourceFor(nodeId, portIdx);
        }
        this._closePortMenu();
      });
    });

    setTimeout(() => {
      if (this._portMenuEl !== menu) return;
      this._portMenuCloser = (ev) => { if (this._portMenuEl && !this._portMenuEl.contains(ev.target)) this._closePortMenu(); };
      document.addEventListener("mousedown", this._portMenuCloser, true);
    }, 0);
  },

  _closePortMenu() {
    if (this._portMenuEl) { this._portMenuEl.remove(); this._portMenuEl = null; }
    if (this._portMenuCloser) { document.removeEventListener("mousedown", this._portMenuCloser, true); this._portMenuCloser = null; }
    if (this._portMenuKeyCloser) { document.removeEventListener("keydown", this._portMenuKeyCloser); this._portMenuKeyCloser = null; }
  },

  addConsumerFor(sourceId, portIdx, recipe) {
    if (this.readOnly) return null;
    const source = this.state.get(String(sourceId));
    const item = source?.outputPorts?.[portIdx]?.item_id;
    if (!item) return null;
    const inputIdx = recipe.inputs.findIndex((p) => p.item_id === item);
    if (inputIdx < 0) return null;
    const nd = this.editor.drawflow.drawflow.Home.data[sourceId];
    const nodeEl = this.container.querySelector(`#node-${sourceId}`);
    const x = (nd ? nd.pos_x : 100) + Math.max(300, (nodeEl?.offsetWidth || 0) + 60);
    const y = (nd ? nd.pos_y : 100) + portIdx * 40;
    const newId = this.addRecipeNode(recipe, x, y);
    if (newId == null) return null;
    this.editor.addConnection(sourceId, newId, `output_${portIdx + 1}`, `input_${inputIdx + 1}`);
    this.recompute();
    return newId;
  },

  addProducerFor(targetId, portIdx, recipe) {
    const target = this.state.get(targetId);
    if (!target) return null;
    const port = target.inputPorts && target.inputPorts[portIdx];
    const item = port && port.item_id;
    let outIdx = recipe.outputs.findIndex((o) => o.item_id === item);
    if (outIdx < 0) outIdx = 0;
    const data = this.editor.drawflow.drawflow.Home.data;
    const nd = data[targetId];
    const x = (nd ? nd.pos_x : 100) - 300;
    const y = (nd ? nd.pos_y : 100) + portIdx * 40;
    const newId = this.addRecipeNode(recipe, x, y);
    try { this.editor.addConnection(newId, targetId, `output_${outIdx + 1}`, `input_${portIdx + 1}`); } catch { /* 端口不匹配则跳过 */ }
    this.recompute();
    return newId;
  },

  addSourceFor(targetId, portIdx) {
    const nd = this.editor.drawflow.drawflow.Home.data[targetId];
    const x = (nd ? nd.pos_x : 100) - 260;
    const y = (nd ? nd.pos_y : 100) + portIdx * 40;
    const newId = this.addSource(x, y);
    try { this.editor.addConnection(newId, targetId, "output_1", `input_${portIdx + 1}`); } catch { /* 端口不匹配则跳过 */ }
    this._syncSourceItem(newId);
    this.recompute();
    return newId;
  }
};
