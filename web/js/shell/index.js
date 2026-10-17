import { html, render } from "../../vendor/preact-standalone.module.js";
import { shellStore } from "./store.js";
import { CatalogShell } from "./catalog.js";
import { InspectorShell } from "./inspector.js";
import { PlanGrid } from "./plans.js";
import { Topbar } from "./topbar.js";
import { CommandPalette } from "./palette.js";
import { BalanceBar } from "./balanceBar.js";

let actions = null;
let inspectorMarkup = "";
let planManagerState = { plans: [], loading: false, error: "", searchText: "", currentPlanId: null, formatTime: (value) => value || "—" };

function draw(state = shellStore.state) {
  const topbarRoot = document.getElementById("topbarShellRoot");
  if (topbarRoot && actions) render(html`<${Topbar} warnCount=${state.warnCount} planIcon=${state.planIcon} actions=${actions.topbar} />`, topbarRoot);
  const leftRoot = document.getElementById("leftShellRoot");
  if (leftRoot && actions) render(html`<${CatalogShell} data=${state.catalog} actions=${actions.catalog} />`, leftRoot);
  const inspectorRoot = document.getElementById("inspectorShellRoot");
  if (inspectorRoot && actions) render(html`<${InspectorShell} node=${state.selectedNode} markup=${inspectorMarkup} actions=${actions.inspector} />`, inspectorRoot);
  const paletteRoot = document.getElementById("commandPaletteRoot");
  if (paletteRoot && actions) render(html`<${CommandPalette} recipes=${state.catalog.allRecipes} components=${state.catalog.components} actions=${actions.catalog} />`, paletteRoot);
  const balanceRoot = document.getElementById("balanceBarRoot");
  if (balanceRoot && actions) render(html`<${BalanceBar} result=${state.lastResult} actions=${actions.balance} />`, balanceRoot);
}

export function initShell(nextActions) {
  actions = nextActions;
  shellStore.subscribe(draw);
  draw();
}

export function updateShell(patch) {
  shellStore.patch(patch);
}

export function updateInspector(node, markup) {
  inspectorMarkup = markup || "";
  shellStore.patch({ selectedNode: node || null });
}

export function renderPlanManager(state) {
  planManagerState = { ...planManagerState, ...state };
  const root = document.getElementById("planManagerGrid");
  if (!root || !actions) return;
  render(html`<${PlanGrid} plans=${planManagerState.plans} loading=${planManagerState.loading} error=${planManagerState.error} searchText=${planManagerState.searchText} currentPlanId=${planManagerState.currentPlanId} view=${planManagerState.view} formatTime=${planManagerState.formatTime} actions=${actions.planManager} />`, root);
}
