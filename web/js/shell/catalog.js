import { html } from "../../vendor/preact-standalone.module.js";
import { iconUrl, PLACEHOLDER_ICON } from "../dom.js";

function ItemIcon({ itemId, className = "" }) {
  const onError = (event) => {
    event.currentTarget.onerror = null;
    event.currentTarget.src = PLACEHOLDER_ICON;
  };
  return html`<img class=${className} src=${itemId ? iconUrl(itemId) : PLACEHOLDER_ICON} alt="" draggable=${false} onError=${onError} />`;
}

function RecipeItem({ recipe, onUse }) {
  const item = recipe.outputs[0] || recipe.inputs[0];
  return html`<button class="catalog-item catalog-item-button" type="button" title=${recipe.displayName || recipe.recipe_name} onClick=${() => onUse(recipe)}>
    <${ItemIcon} itemId=${item && item.item_id} className="thumb" />
    <span class="ci-body">
      <span class="ci-name">${recipe.displayName || recipe.recipe_name}${recipe.temporary && html` <b class="tmp-tag">临时</b>`}${recipe.special && html` <b class="spec-tag">特殊</b>`}</span>
      <span class="ci-sub"><span>${recipe.facility_name_cn}</span>${recipe.duplicateName && html`<span class="ci-variant">原名：${recipe.recipe_name}</span>`}</span>
    </span>
  </button>`;
}

const ELEMENTS = [
  ["source", "▶", "固定源", "按固定速率供料，物品随连线自动确定"],
  ["sink", "▣", "最终产物箱", "收集最终产出并计入统计"],
  ["merger", "⇄", "汇流分配器", "汇合相同物料，再按路径模式分配"],
  ["portal", "⌁", "传送门", "创建绑定的入口与出口，跨区域传递物料"],
];

export function CatalogShell({ data, actions }) {
  const showRecent = !data.searchText && !data.facilityFilter && data.recentRecipes.length > 0;
  return html`
    <div class="panel-section catalog-section">
      <div class="panel-head"><span>配方目录</span><span class="muted">${data.visibleRecipes.length} 条</span></div>
      <input class="input search" type="search" value=${data.searchText} placeholder="搜索配方 / 物品（空格分隔多关键词）…" spellcheck=${false}
        onInput=${(event) => actions.setCatalogSearch(event.currentTarget.value)} />
      <div class="catalog-filter-row">
        <label class="facility-select-wrap">
          <span>设施</span>
          <select class="facility-select" value=${data.facilityFilter} onChange=${(event) => actions.setFacilityFilter(event.currentTarget.value)}>
            <option value="">全部设施</option>
            ${data.facilities.map((facility) => html`<option key=${facility.id} value=${facility.id}>${facility.name}</option>`)}
          </select>
        </label>
        <label class=${`catalog-toggle compact ${data.showAllFilling ? "active" : ""}`} title="显示通常隐藏的灌装与拆解配方">
          <input type="checkbox" checked=${data.showAllFilling} onChange=${(event) => actions.setShowAllFilling(event.currentTarget.checked)} />
          <span>灌装 / 拆解</span>
        </label>
      </div>
      <div class="list catalog-list">
        ${showRecent && html`<div class="catalog-group">最近使用</div>${data.recentRecipes.map((recipe) => html`<${RecipeItem} key=${`recent-${recipe.key}`} recipe=${recipe} onUse=${actions.useRecipe} />`)}<div class="catalog-group">全部配方</div>`}
        ${data.visibleRecipes.length
          ? data.visibleRecipes.map((recipe) => html`<${RecipeItem} key=${recipe.key} recipe=${recipe} onUse=${actions.useRecipe} />`)
          : html`<div class="empty-hint">没有匹配的配方</div>`}
      </div>
    </div>

    <div class="panel-section element-section">
      <div class="panel-head"><span>元件</span></div>
      <div class="element-list">
        ${ELEMENTS.map(([kind, icon, title, desc]) => html`<button key=${kind} class="element-card" type="button" onClick=${() => actions.addElement(kind)}>
          <span class=${`element-icon element-${kind}`}>${icon}</span>
          <span class="element-text"><span class="element-title">${title}</span><span class="element-desc">${desc}</span></span>
        </button>`)}
      </div>
    </div>

    <div id="componentResizeHandle" class="sidebar-resize-handle" role="separator" tabindex="0" aria-label="调整组件库高度" aria-orientation="horizontal" title="上下拖动调整组件库高度，双击恢复默认"></div>
    <div class="panel-section component-section">
      <div class="panel-head"><span>组件库（黑盒）</span><span class="muted">${data.components.length ? `${data.components.length} 个` : ""}</span></div>
      <div class="list component-list">
        ${data.components.length ? data.components.map((component) => html`<div key=${component.id} class="component-item">
          <button class="cmp-main" type="button" onClick=${() => actions.addComponent(component)}>◧ ${component.name}</button>
          <span class="cmp-actions">
            <button type="button" class="cmp-edit" title="打开组件内部画布" onClick=${() => actions.editComponent(component)}>编辑内部</button>
            <button type="button" class="cmp-del" title="删除组件" onClick=${() => actions.deleteComponent(component)}>✕</button>
          </span>
        </div>`) : html`<div class="empty-hint">按住 Ctrl 多选机器后点「组合为黑盒」创建</div>`}
      </div>
    </div>`;
}
