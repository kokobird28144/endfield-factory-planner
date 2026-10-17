import { html, useState } from "../../vendor/preact-standalone.module.js";
import { recipes } from "../recipes.js";
import { fmt, WARN_TOLERANCE } from "../engine.js";

export function BalanceBar({ result, actions }) {
  const [expanded, setExpanded] = useState(false);
  const balance = result ? result.balance : { items: [], finalOutputs: [] };
  const finalSummary = balance.finalOutputs.length
    ? balance.finalOutputs.slice(0, 3).map((item) => `${recipes.itemName(item.item_id)} ${fmt(item.rate)}/分`).join(" · ")
    : "尚无最终产出";
  return html`<section class=${`balance-bar ${expanded ? "expanded" : ""}`}>
    <button class="balance-summary" type="button" onClick=${() => setExpanded(!expanded)} aria-expanded=${expanded}>
      <span class="balance-chevron">${expanded ? "▾" : "▴"}</span>
      <span class="balance-title">全局产消</span>
      <span class="balance-final">${finalSummary}</span>
      <span class=${`balance-warning ${result && result.warnCount ? "has-warn" : ""}`}>${result && result.flowConverged === false ? "分配未收敛，请检查回流或冲突设置" : result && result.warnCount ? `${result.warnCount} 处告警` : "供需正常"}</span>
    </button>
    ${expanded && html`<div class="balance-details">
      ${balance.items.length ? balance.items.map((item) => html`<button key=${item.item_id} class=${`balance-item ${item.net < -WARN_TOLERANCE ? "deficit" : ""}`} type="button" onClick=${() => actions.focusItem(item.item_id)} title="定位使用该物品的节点">
        <span class="balance-item-name">${recipes.itemName(item.item_id)}</span>
        <span>产 ${fmt(item.produced)}</span><span>耗 ${fmt(item.consumed)}</span><strong>净 ${fmt(item.net)}</strong>
      </button>`) : html`<div class="empty-hint">画布为空</div>`}
    </div>`}
  </section>`;
}
