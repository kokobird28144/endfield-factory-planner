import { html, useState } from "../vendor/preact-standalone.module.js";
import { recipes } from "./recipes.js";
import { esc, iconImg, iconUrl } from "./dom.js";

export function normalizePlanIcon(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : "";
}

export function PlanIcon({ itemId }) {
  const [failed, setFailed] = useState(null);
  const id = normalizePlanIcon(itemId);
  return id && failed !== id
    ? html`<img class="plan-item-icon" src=${iconUrl(id)} alt="" draggable=${false} onError=${() => setFailed(id)} />`
    : "▦";
}

export function choosePlanIcon(current = "") {
  return new Promise(resolve => {
    const modal = document.createElement("dialog");
    modal.className = "plan-icon-picker";
    modal.setAttribute("aria-label", "选择方案图标");
    modal.innerHTML = `<div class="plan-icon-heading"><strong>选择方案图标</strong><button type="button" class="icon-btn" aria-label="关闭">✕</button></div>
      <input class="input search" type="search" placeholder="搜索物品名称或 ID…" aria-label="搜索方案图标" />
      <button type="button" class="btn plan-icon-default">▦ 使用默认图标</button>
      <div class="plan-icon-options"></div>`;
    const input = modal.querySelector("input"), grid = modal.querySelector(".plan-icon-options");
    let finished = false;
    const close = value => {
      if (finished) return;
      finished = true; modal.close(); modal.remove(); resolve(value);
    };
    const draw = () => {
      const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const items = [...recipes.itemMeta].filter(([id, meta]) => normalizePlanIcon(id) && terms.every(term => `${id} ${meta.name_cn || ""}`.toLowerCase().includes(term)));
      grid.innerHTML = items.length ? items.map(([id, meta]) => `<button type="button" class="plan-icon-option" data-item="${esc(id)}" aria-label="${esc(meta.name_cn || id)}" aria-pressed="${id === current}" title="${esc(meta.name_cn || id)} · ${esc(id)}">${iconImg(id)}<span>${esc(meta.name_cn || id)}</span></button>`).join("") : '<div class="empty-hint">没有匹配的物品</div>';
    };
    input.addEventListener("input", draw);
    modal.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") { event.preventDefault(); grid.querySelector("button")?.focus(); }
    });
    modal.querySelector(".icon-btn").addEventListener("click", () => close(null));
    modal.querySelector(".plan-icon-default").addEventListener("click", () => close(""));
    grid.addEventListener("click", event => { const button = event.target.closest("[data-item]"); if (button) close(button.dataset.item); });
    modal.addEventListener("cancel", event => { event.preventDefault(); close(null); });
    modal.addEventListener("click", event => { const box = modal.getBoundingClientRect(); if (event.target === modal && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close(null); });
    document.body.appendChild(modal); draw(); modal.showModal(); input.focus();
  });
}
