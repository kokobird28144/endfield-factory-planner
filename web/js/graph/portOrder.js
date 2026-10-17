// Display order is independent of input/output indices used by recipes and edges.
export function normalizePortOrder(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((key) => typeof key === "string" &&
      /^(?:(?:in|out):\d{1,6}|item:[A-Za-z0-9_.:-]{1,160})$/.test(key)))].slice(0, 1024)
    : [];
}

export const portOrderMethods = {
  _portSortGroup(id) {
    const node = this.container.querySelector(`#node-${id}`);
    if (!node || this.state.get(String(id))?.boundary) return null;
    const list = node.querySelector(".sink-inflow") || node.querySelector(".port-list");
    if (!list) return null;
    const rows = [...list.children].filter((block) => {
      const row = block.matches(".port-row") ? block : block.querySelector(".port-row");
      if (!row) return false;
      const key = row.dataset.rowKey || (row.hasAttribute("data-pin") ? `in:${row.dataset.pin}`
        : row.hasAttribute("data-pout") ? `out:${row.dataset.pout}` : "");
      if (!key) return false;
      block.dataset.rowKey = key;
      row.classList.add("port-sortable");
      return true;
    });
    rows.forEach((block) => {
      const row = block.matches(".port-row") ? block : block.querySelector(".port-row");
      row.classList.toggle("port-sortable", rows.length > 1);
    });
    return { node, list, rows };
  },

  _applyPortOrder(id) {
    const group = this._portSortGroup(id);
    if (!group) return false;
    const dragging = this._portSort?.id === String(id);
    if (dragging && this._portSort.block.isConnected) return false;
    if (dragging) this._finishPortSort(true);
    const order = normalizePortOrder(this.state.get(String(id))?.port_order);
    const rank = new Map(order.map((key, index) => [key, index]));
    const sorted = [...group.rows].sort((a, b) =>
      (rank.get(a.dataset.rowKey) ?? order.length) - (rank.get(b.dataset.rowKey) ?? order.length));
    const changed = sorted.some((row, index) => row !== group.rows[index]);
    if (changed) sorted.forEach((row) => group.list.appendChild(row));
    // A sink has one shared input; keep it on the first visible material.
    if (group.list.matches(".sink-inflow")) {
      sorted.forEach((row) => row.removeAttribute("data-pin"));
      sorted[0]?.setAttribute("data-pin", "0");
    }
    return changed;
  },

  _bindPortReordering() {
    this.container.addEventListener("pointerdown", (event) => {
      if (this.readOnly || event.button !== 0 || event.isPrimary === false || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target.closest("input, button, select, textarea, a, .input, .output")) return;
      const row = event.target.closest(".port-sortable");
      if (!row) return;
      const id = row.closest(".drawflow-node").id.replace("node-", "");
      const group = this._portSortGroup(id);
      const block = group?.rows.find((item) => item === row || item.contains(row));
      if (!block || group.rows.length < 2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._portSort = { id, ...group, block, pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY, active: false, valid: true,
        original: [...group.list.children] };
      this.container.setPointerCapture(event.pointerId);
    }, true);
    document.addEventListener("pointermove", (event) => {
      const drag = this._portSort;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.block.isConnected) { this._finishPortSort(true); return; }
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.active = true;
      drag.block.classList.add("port-sort-dragging");
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      drag.valid = !!hit && drag.list.contains(hit);
      if (!drag.valid) return;
      const target = drag.rows.find((item) => item === hit || item.contains(hit));
      if (!target || target === drag.block) return;
      const targetRow = target.matches(".port-row") ? target : target.querySelector(".port-row");
      const rect = targetRow.getBoundingClientRect();
      drag.list.insertBefore(drag.block, event.clientY >= rect.top + rect.height / 2 ? target.nextSibling : target);
      if (drag.list.matches(".sink-inflow")) {
        const rows = [...drag.list.children];
        rows.forEach((row) => row.removeAttribute("data-pin"));
        rows[0]?.setAttribute("data-pin", "0");
      }
      this._alignPorts(drag.id);
      this._scheduleEdgeRefresh({ nodeIds: [drag.id] });
    }, true);
    document.addEventListener("pointerup", (event) => {
      const drag = this._portSort;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      this._finishPortSort(!hit || !drag.list.contains(hit));
    }, true);
    document.addEventListener("pointercancel", () => this._finishPortSort(true), true);
    window.addEventListener("blur", () => this._finishPortSort(true));
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this._portSort) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._finishPortSort(true);
    }, true);
  },

  _finishPortSort(cancel = false) {
    const drag = this._portSort;
    if (!drag) return;
    this._portSort = null;
    drag.block.classList.remove("port-sort-dragging");
    if (this.container.hasPointerCapture(drag.pointerId)) this.container.releasePointerCapture(drag.pointerId);
    const intact = drag.original.every((row) => row.parentElement === drag.list);
    const state = this.state.get(drag.id);
    if (intact && (cancel || this.readOnly)) drag.original.forEach((row) => drag.list.appendChild(row));
    else if (intact && state && drag.active) {
      const keys = [...drag.list.children].map((row) => row.dataset.rowKey).filter(Boolean);
      const oldKeys = drag.rows.map((row) => row.dataset.rowKey);
      if (JSON.stringify(keys) !== JSON.stringify(oldKeys)) {
        state.port_order = [...keys, ...normalizePortOrder(state.port_order).filter((key) => !keys.includes(key))];
        this._scheduleHistoryCommit();
      }
    }
    this._applyPortOrder(drag.id);
    this._alignPorts(drag.id);
    this._scheduleEdgeRefresh({ nodeIds: [drag.id] });
  },
};
