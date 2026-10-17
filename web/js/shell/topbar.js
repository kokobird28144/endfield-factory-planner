import { html, useEffect, useState } from "../../vendor/preact-standalone.module.js";
import { PlanIcon } from "../planIcon.js";
import { isPages } from "../storageMode.js";
import { examplePlans } from "../examples.js";

function MenuGroup({ label, items }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!event.target.closest(".topbar-menu")) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return html`<div class=${`topbar-menu ${open ? "open" : ""}`}>
    <button class="btn menu-trigger" type="button" aria-expanded=${open} onClick=${() => setOpen(!open)}>${label}<span>▾</span></button>
    ${open && html`<div class="topbar-menu-popover">
      ${items.map((item) => html`<button id=${item.id} key=${item.id} title=${item.description} class=${`menu-action ${item.primary ? "primary" : ""}`} type="button" onClick=${() => { setOpen(false); item.action(); }}>
        <span class="menu-action-label">${item.icon && html`<${PlanIcon} itemId=${item.icon} />`}${item.label}</span>${item.hint && html`<span class="menu-action-hint">${item.hint}</span>`}
      </button>`)}
    </div>`}
  </div>`;
}

export function Topbar({ warnCount, planIcon, actions }) {
  const fileItems = [
    { id: "btnNew", label: "新建方案", action: actions.newPlan },
    { id: "btnOpen", label: "打开方案", action: actions.openPlans },
    { id: "btnSave", label: "保存方案", action: actions.savePlan, primary: true, hint: "Ctrl+S" },
    { id: "btnImportPlan", label: "导入方案 JSON", action: actions.importPlan },
    { id: "btnImportBackup", label: "导入完整备份", action: actions.importBackup },
  ];
  const toolItems = [
    { id: "btnSupplyScan", label: "原料扫描", action: actions.openSupplyScan },
    { id: "btnBatchRecipe", label: "批量新增配方", action: actions.batchRecipes },
    { id: "btnProdTable", label: "打开产消表", action: actions.openProduction },
    { id: "btnGroupBlackbox", label: "组合为黑盒", action: actions.groupBlackbox },
    { id: "btnCommandPalette", label: "添加节点…", action: actions.openPalette, hint: "Ctrl+K" },
  ];
  const exportItems = [
    { id: "btnExportPlan", label: "导出方案 JSON", action: actions.exportPlan },
    { id: "btnExportBackup", label: "导出完整备份（已保存数据）", action: actions.exportBackup },
    { id: "btnExportPng", label: "导出画布 PNG", action: actions.exportPng },
    { id: "btnExportDyn", label: "导出 zmd_dyn 拓扑", action: actions.exportDyn },
  ];
  return html`
    <div class="brand"><span class="brand-mark">⚙</span><span class="brand-title">工厂配平编辑器</span>${isPages && html`<small title="数据仅保存在当前浏览器；清除网站数据会删除保存内容，请定期导出完整备份。">浏览器保存 · 请备份</small>`}</div>
    <div class="topbar-plan"><span class="plan-label">当前方案</span><button id="btnPlanIcon" class="plan-icon-button" type="button" aria-label="选择方案图标" title="选择方案图标（随方案保存）" onClick=${actions.chooseIcon}><${PlanIcon} itemId=${planIcon} /></button><input id="planName" class="plan-name-input" type="text" defaultValue="未命名方案" spellcheck=${false} /></div>
    <div class="topbar-actions grouped">
      <${MenuGroup} label="文件" items=${fileItems} />
      <${MenuGroup} label="示例" items=${examplePlans.map(example => ({ id: `example-${example.id}`, label: example.name, icon: example.icon, description: example.description, action: () => actions.openExample(example.id) }))} />
      <${MenuGroup} label="工具" items=${toolItems} />
      <${MenuGroup} label="导出" items=${exportItems} />
    </div>
    <div class="topbar-status"><span class=${`warn-badge ${warnCount > 0 ? "has-warn" : ""}`} title=${warnCount > 0 ? `${warnCount} 处供需不满足` : "供需均衡"}><span class="warn-dot"></span><span>${warnCount}</span></span></div>`;
}
