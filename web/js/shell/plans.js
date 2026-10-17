import { html, useState } from "../../vendor/preact-standalone.module.js";
import { PlanIcon } from "../planIcon.js";

export function PlanGrid({ plans, loading, error, currentPlanId, searchText, view, formatTime, actions }) {
  const [menuId, setMenuId] = useState(null);
  const keyword = (searchText || "").toLowerCase();
  const visible = plans.filter(plan => !keyword || String(plan.name || plan.id).toLowerCase().includes(keyword));
  if (loading) return html`<div class="empty-hint">加载中…</div>`;
  if (error) return html`<div class="empty-hint">加载失败：${error}</div>`;
  if (!plans.length) return html`<div class="empty-hint">还没有已保存的方案</div>`;
  if (!visible.length) return html`<div class="empty-hint">没有匹配的方案</div>`;
  return html`${visible.map(plan => html`<article key=${plan.id} class=${`plan-tile ${currentPlanId === plan.id ? "is-current" : ""}`} data-plan-id=${plan.id}>
    <button class="plan-tile-open" type="button" title=${`${plan.name || plan.id}\n更新于 ${formatTime(plan.updated_at)}\n${plan.node_count || 0} 个节点 · ${plan.edge_count || 0} 条连线`} onClick=${() => actions.open(plan.id)}>
      <span class="plan-tile-icon" aria-hidden="true"><${PlanIcon} itemId=${plan.icon_item_id} /></span><span class="plan-tile-name">${plan.name || plan.id}</span>
      ${view === "list" && html`<span class="plan-tile-date"><small>更新于</small>${formatTime(plan.updated_at || plan.created_at)}</span>`}
      ${currentPlanId === plan.id && html`<span class="plan-current-badge">当前</span>`}
    </button>
    <button class="plan-more" type="button" aria-label=${`管理 ${plan.name || plan.id}`} aria-expanded=${menuId === plan.id} onClick=${() => setMenuId(menuId === plan.id ? null : plan.id)}>⋯</button>
    ${menuId === plan.id && html`<div class="plan-tile-menu">
      <button type="button" onClick=${() => { setMenuId(null); actions.chooseIcon(plan.id); }}>更换图标</button>
      <button type="button" onClick=${() => { setMenuId(null); actions.rename(plan.id, plan.name || plan.id); }}>重命名</button>
      <button type="button" onClick=${() => { setMenuId(null); actions.duplicate(plan.id, plan.name || plan.id); }}>复制</button>
      <button class="danger" type="button" onClick=${() => { setMenuId(null); actions.delete(plan.id, plan.name || plan.id); }}>删除</button>
    </div>`}
  </article>`)}`;
}
