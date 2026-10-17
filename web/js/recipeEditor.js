// recipeEditor.js —— 批量新增/编辑临时配方（表格录入）。
// 每行一条配方，最多 2 入 2 出；保存后经后端标记 temporary 并入配方目录。
import { api } from "./api.js";
import { recipes } from "./recipes.js";
import { esc, iconImg } from "./dom.js";

const FALLBACK_FACILITIES = [
  ["mix_pool_1", "反应池"], ["dismantler_1", "拆解机"], ["filler_1", "灌装机"],
  ["refine_furnace_1", "精炼炉"], ["crusher_1", "粉碎机"], ["grinder_1", "研磨机"],
  ["shaper_1", "塑形机"], ["packer_1", "封装机"], ["assembler_1", "配件机"],
];

class RecipeEditor {
  constructor() {
    this.onSaved = () => {};
    this.modal = null;
    this.tbody = null;
  }

  init({ onSaved } = {}) {
    if (onSaved) this.onSaved = onSaved;
    this.modal = document.getElementById("recipeEditorModal");
    this.table = document.getElementById("recipeEditorTable");
    this.tbody = this.table.querySelector("tbody");
    this._renderHead();

    document.getElementById("btnAddRecipeRow").addEventListener("click", () => this._addRow());
    document.getElementById("btnSaveRecipes").addEventListener("click", () => this._save());
    this.tbody.addEventListener("click", (e) => {
      const del = e.target.closest(".row-del");
      if (del) del.closest("tr").remove();
    });
    this.tbody.addEventListener("focusin", event => {
      if (event.target.matches(".pc-search")) this._showItems(event.target);
    });
    this.tbody.addEventListener("input", event => {
      const input = event.target;
      if (input.matches(".pc-search")) {
        const cell = input.closest(".port-cell");
        cell.querySelector(".pc-id").value = "";
        cell.querySelector(".pc-name").value = "";
        this._showItems(input);
      }
      if (input.matches(".pc-id,.pc-name")) {
        const cell = input.closest(".port-cell");
        cell.querySelector(".pc-search").value = cell.querySelector(".pc-name").value || cell.querySelector(".pc-id").value;
      }
    });
    this.tbody.addEventListener("keydown", event => {
      if (!event.target.matches(".pc-search") || !this._itemPicker) return;
      const buttons = [...this._itemPicker.querySelectorAll("button")];
      if (event.key === "Escape") { event.stopPropagation(); this._closeItems(); }
      else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        this._itemIndex = Math.max(0, Math.min(buttons.length - 1, this._itemIndex + (event.key === "ArrowDown" ? 1 : -1)));
        buttons.forEach((button, i) => button.classList.toggle("active", i === this._itemIndex));
        buttons[this._itemIndex]?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && buttons.length) { event.preventDefault(); buttons[Math.max(0, this._itemIndex)].click(); }
    });
    document.addEventListener("pointerdown", event => {
      if (!event.target.closest(".recipe-item-picker,.pc-search")) this._closeItems();
    });
    this.modal.addEventListener("scroll", () => this._closeItems(), true);
    window.addEventListener("resize", () => this._closeItems());
  }

  _closeItems() { this._itemPicker?.remove(); this._itemPicker = null; }

  _showItems(input) {
    this._closeItems();
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const query = input.value.trim().toLowerCase();
    const exact = ([id, meta]) => id.toLowerCase() === query || (meta.name_cn || "").toLowerCase() === query;
    const items = [...recipes.itemMeta].filter(([id, meta]) => terms.every(term => `${meta.name_cn} ${id}`.toLowerCase().includes(term)))
      .sort((a, b) => Number(exact(b)) - Number(exact(a))).slice(0, 60);
    const menu = document.createElement("div");
    menu.className = "recipe-item-picker";
    menu.setAttribute("aria-label", "物品搜索结果");
    menu.innerHTML = items.length ? items.map(([id, meta]) =>
      `<button type="button" data-item="${esc(id)}">${iconImg(id, "picker-icon")}<span>${esc(meta.name_cn || id)}<small>${esc(id)}</small></span></button>`).join("")
      : '<div class="empty-hint">没有匹配物品，可在“自定义”中填写新物品。</div>';
    menu.addEventListener("pointerdown", event => event.preventDefault());
    menu.addEventListener("click", event => {
      const button = event.target.closest("[data-item]");
      if (!button || !input.isConnected) return;
      const id = button.dataset.item, name = recipes.itemName(id), cell = input.closest(".port-cell");
      cell.querySelector(".pc-id").value = id;
      cell.querySelector(".pc-name").value = name;
      input.value = name;
      this._closeItems();
      cell.querySelector(".pc-rate").focus();
    });
    document.body.appendChild(menu);
    const rect = input.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 308))}px`;
    const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    const openAbove = below < 160 && above > below;
    menu.style.maxHeight = `${Math.max(60, Math.min(260, openAbove ? above : below))}px`;
    menu.style.top = `${openAbove ? Math.max(8, rect.top - menu.offsetHeight - 4) : rect.bottom + 4}px`;
    this._itemPicker = menu;
    this._itemIndex = -1;
  }

  _facilities() {
    const list = recipes.getFacilities();
    return list.length ? list : FALLBACK_FACILITIES.map(([id, name]) => ({ id, name }));
  }

  _renderHead() {
    const thead = this.table.querySelector("thead");
    thead.innerHTML =
      "<tr>" +
      "<th>配方名</th><th>设施</th><th>耗时(s)</th><th>产物形态</th>" +
      "<th>输入 1</th><th>输入 2</th><th>输出 1</th><th>输出 2</th><th></th>" +
      "</tr>";
  }

  _facilityOptions(selected) {
    return this._facilities()
      .map((f) => `<option value="${esc(f.id)}"${f.id === selected ? " selected" : ""}>${esc(f.name)}</option>`)
      .join("");
  }

  _portCell(slot, port) {
    const p = port || {};
    return (
      `<td><div class="port-cell" data-slot="${slot}">` +
      `<input class="cell-input pc-search" aria-label="搜索物品" placeholder="搜索中文名或ID…" autocomplete="off" value="${esc(p.name_cn || (p.item_id && recipes.itemName(p.item_id)) || "")}" />` +
      `<details class="pc-custom"><summary>自定义</summary>` +
      `<input class="cell-input pc-id" placeholder="item_id" value="${esc(p.item_id || "")}" />` +
      `<input class="cell-input pc-name" placeholder="名称" value="${esc(p.name_cn || "")}" />` +
      `</details>` +
      `<div class="pc-nums">` +
      `<input class="cell-input pc-qty" placeholder="数量" value="${p.qty != null ? esc(p.qty) : ""}" />` +
      `<input class="cell-input pc-rate" placeholder="速率/分" value="${p.rate_per_min != null ? esc(p.rate_per_min) : ""}" />` +
      `</div></div></td>`
    );
  }

  _addRow(rec) {
    const r = rec || {};
    const ins = r.inputs || [];
    const outs = r.outputs || [];
    const state = (outs[0] && outs[0].state) || "";
    const tr = document.createElement("tr");
    tr.dataset.id = r.id || "";
    tr.innerHTML =
      `<td><input class="cell-input rc-name" value="${esc(r.recipe_name || "")}" placeholder="配方名" /></td>` +
      `<td><select class="cell-input rc-fac">${this._facilityOptions(r.facility_id)}</select></td>` +
      `<td><input class="cell-input cell-num rc-time" value="${r.time_sec != null ? esc(r.time_sec) : "2"}" /></td>` +
      `<td><select class="cell-input rc-state">` +
        `<option value=""${state === "" ? " selected" : ""}>自动</option>` +
        `<option value="solid"${state === "solid" ? " selected" : ""}>固体</option>` +
        `<option value="liquid"${state === "liquid" ? " selected" : ""}>液体</option>` +
        `<option value="gas"${state === "gas" ? " selected" : ""}>气体</option>` +
      `</select></td>` +
      this._portCell("in0", ins[0]) +
      this._portCell("in1", ins[1]) +
      this._portCell("out0", outs[0]) +
      this._portCell("out1", outs[1]) +
      `<td><span class="row-del" title="删除此行">✕</span></td>`;
    this.tbody.appendChild(tr);
    return tr;
  }

  async open() {
    this._closeItems();
    this.tbody.innerHTML = "";
    const temp = recipes.tempRaw || [];
    if (temp.length) temp.forEach((r) => this._addRow(r));
    else { this._addRow(); this._addRow(); }
    this._msg("", "");
    this.modal.hidden = false;
  }

  _msg(text, cls) {
    const el = document.getElementById("recipeEditorMsg");
    el.textContent = text;
    el.className = "editor-msg" + (cls ? " " + cls : "");
  }

  _readPort(cellEl, state) {
    const id = cellEl.querySelector(".pc-id").value.trim();
    if (!id) return null;
    const name = cellEl.querySelector(".pc-name").value.trim() || id;
    const qty = Number(cellEl.querySelector(".pc-qty").value);
    const rate = Number(cellEl.querySelector(".pc-rate").value);
    const port = {
      item_id: id,
      name_cn: name,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      rate_per_min: Number.isFinite(rate) && rate > 0 ? rate : 0,
    };
    if (state) port.state = state;
    return port;
  }

  _collect() {
    const rows = [...this.tbody.querySelectorAll("tr")];
    const out = [];
    const errors = [];
    rows.forEach((tr, idx) => {
      const name = tr.querySelector(".rc-name").value.trim();
      const facId = tr.querySelector(".rc-fac").value;
      const facName = tr.querySelector(".rc-fac").selectedOptions[0]?.text || facId;
      const time = Number(tr.querySelector(".rc-time").value) || 0;
      const state = tr.querySelector(".rc-state").value;
      if ([...tr.querySelectorAll(".port-cell")].some(cell => cell.querySelector(".pc-search").value.trim() && !cell.querySelector(".pc-id").value.trim())) {
        errors.push(`第 ${idx + 1} 行：请从搜索结果选择物品，或填写自定义ID`); return;
      }

      const cells = (slot) => tr.querySelector(`.port-cell[data-slot="${slot}"]`);
      const inputs = [this._readPort(cells("in0"), null), this._readPort(cells("in1"), null)].filter(Boolean);
      // 产物形态仅作用于输出物品
      const outputs = [this._readPort(cells("out0"), state), this._readPort(cells("out1"), state)].filter(Boolean);

      const isBlank = !name && !inputs.length && !outputs.length;
      if (isBlank) return; // 跳过空行

      if (!name) { errors.push(`第 ${idx + 1} 行：缺少配方名`); return; }
      if (!outputs.length) { errors.push(`第 ${idx + 1} 行：至少需要 1 个输出产物`); return; }
      for (const p of [...inputs, ...outputs]) {
        if (p.rate_per_min <= 0) { errors.push(`第 ${idx + 1} 行：物品「${p.item_id}」缺少有效速率`); return; }
      }

      const rec = {
        temporary: true,
        recipe_name: name,
        section: "合成表",
        facility_id: facId,
        facility_name_cn: facName,
        time_sec: time,
        page_item_id: outputs[0].item_id,
        page_name_cn: outputs[0].name_cn,
        inputs,
        outputs,
      };
      const id = tr.dataset.id;
      if (id) rec.id = id;
      out.push(rec);
    });
    return { recipes: out, errors };
  }

  async _save() {
    this._closeItems();
    const { recipes: list, errors } = this._collect();
    if (errors.length) { this._msg(errors[0], "err"); return; }
    this._msg("保存中…", "");
    try {
      await api.saveTempRecipes(list);
      await recipes.reloadTemp();
      this._msg(`已保存 ${list.length} 条临时配方`, "ok");
      this.onSaved();
      setTimeout(() => { this.modal.hidden = true; }, 500);
    } catch (err) {
      this._msg("保存失败：" + err.message, "err");
    }
  }
}

export const recipeEditor = new RecipeEditor();
