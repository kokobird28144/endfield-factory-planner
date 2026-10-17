import { html, useEffect, useMemo, useRef, useState } from "../../vendor/preact-standalone.module.js";

const ELEMENTS = [
  { key: "element-source", kind: "source", label: "固定源", category: "元件" },
  { key: "element-sink", kind: "sink", label: "最终产物箱", category: "元件" },
  { key: "element-merger", kind: "merger", label: "汇流分配器", category: "元件" },
  { key: "element-portal", kind: "portal", label: "传送门", category: "元件" },
];

export function CommandPalette({ recipes, components, actions }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const items = useMemo(() => {
    const term = query.trim().toLowerCase();
    const recipeItems = (recipes || []).map((recipe) => ({
      key: `recipe-${recipe.key}`, label: recipe.displayName || recipe.recipe_name,
      detail: recipe.facility_name_cn, category: "配方", recipe,
      search: [recipe.recipe_name, recipe.displayName, recipe.facility_name_cn, ...recipe.inputs.map((p) => p.name_cn), ...recipe.outputs.map((p) => p.name_cn)].join(" ").toLowerCase(),
    }));
    const componentItems = (components || []).map((component) => ({ key: `component-${component.id}`, label: component.name, category: "组件", component, search: component.name.toLowerCase() }));
    return [...ELEMENTS.map((item) => ({ ...item, search: item.label.toLowerCase() })), ...recipeItems, ...componentItems]
      .filter((item) => !term || item.search.includes(term)).slice(0, 60);
  }, [query, recipes, components]);

  const show = () => { setQuery(""); setActive(0); setOpen(true); };
  const close = () => setOpen(false);
  const choose = (item) => {
    if (!item) return;
    if (item.recipe) actions.useRecipe(item.recipe);
    else if (item.component) actions.addComponent(item.component);
    else actions.addElement(item.kind);
    close();
  };

  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
        event.preventDefault();
        open ? close() : show();
      } else if (open && event.key === "Escape") {
        event.preventDefault(); close();
      }
    };
    const onOpen = () => show();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("zmd-open-palette", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("zmd-open-palette", onOpen);
    };
  }, [open]);
  useEffect(() => { if (open) requestAnimationFrame(() => inputRef.current && inputRef.current.focus()); }, [open]);
  useEffect(() => { if (active >= items.length) setActive(Math.max(items.length - 1, 0)); }, [items.length, active]);

  if (!open) return null;
  return html`<div class="command-palette-layer" onMouseDown=${(event) => { if (event.target === event.currentTarget) close(); }}>
    <div class="command-palette" role="dialog" aria-modal="true" aria-label="添加节点">
      <div class="command-search-row"><span>⌕</span><input ref=${inputRef} value=${query} placeholder="搜索配方、元件或组件…" onInput=${(event) => { setQuery(event.currentTarget.value); setActive(0); }}
        onKeyDown=${(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(active - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); choose(items[active]); }
        }} /></div>
      <div class="command-results">
        ${items.length ? items.map((item, index) => html`<button key=${item.key} class=${`command-result ${index === active ? "active" : ""}`} type="button" onMouseEnter=${() => setActive(index)} onClick=${() => choose(item)}>
          <span class="command-category">${item.category}</span><span class="command-label">${item.label}</span><span class="command-detail">${item.detail || ""}</span>
        </button>`) : html`<div class="empty-hint">没有匹配项</div>`}
      </div>
      <div class="command-footer"><span>↑↓ 选择</span><span>Enter 添加</span><span>Esc 关闭</span></div>
    </div>
  </div>`;
}
