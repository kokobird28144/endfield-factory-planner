import { html } from "../../vendor/preact-standalone.module.js";

function InspectorContent({ markup }) {
  return html`<div class="inspector-body" dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}

export function MachineInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }
export function SourceInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }
export function SinkInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }
export function MergerInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }
export function PortalInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }
export function BoundaryInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }
export function BlackboxInspector({ markup }) { return html`<${InspectorContent} markup=${markup} />`; }

const COMPONENTS = {
  machine: MachineInspector,
  source: SourceInspector,
  sink: SinkInspector,
  merger: MergerInspector,
  portal_in: PortalInspector,
  portal_out: PortalInspector,
  blackbox: BlackboxInspector,
};

export function InspectorShell({ node, markup, actions }) {
  if (!node) return html`<div class="inspector-empty">选择节点或连线查看与编辑参数。</div>`;
  const Component = node.boundary ? BoundaryInspector : (COMPONENTS[node.type] || InspectorContent);
  const onClick = (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    if (target.dataset.act === "edge-color-default") actions.setEdgeStyle({ color: "" }, true);
    else if (target.dataset.act === "edge-width-default") actions.setEdgeStyle({ width: null }, true);
    else if (target.dataset.act === "edge-color-preset") actions.setEdgeStyle({ color: target.dataset.color }, true);
    else actions.activate(target.dataset.act, target.dataset);
  };
  const onInput = (event) => {
    if (event.target.matches('[data-role="card-name"]')) actions.rename(event.target.value, false);
    else if (event.target.matches('[data-role="edge-color"]')) actions.setEdgeStyle({ color: event.target.value }, false);
    else if (event.target.matches('[data-role="edge-width"]')) {
      const output = event.target.parentElement.querySelector("output");
      if (output) output.textContent = `${event.target.value} px`;
      actions.setEdgeStyle({ width: Number(event.target.value) }, false);
    }
  };
  const onChange = (event) => {
    if (event.target.matches('[data-role="card-name"]')) actions.rename(event.target.value, true);
    else if (event.target.matches('[data-role="edge-color"]')) actions.setEdgeStyle({ color: event.target.value }, true);
    else if (event.target.matches('[data-role="edge-width"]')) actions.setEdgeStyle({ width: Number(event.target.value) }, true);
  };
  const onKeyDown = (event) => {
    if (event.key === "Enter" && event.target.matches('[data-role="card-name"]')) {
      event.preventDefault();
      event.target.blur();
    }
  };
  return html`<div class="inspector-shell" onClick=${onClick} onInput=${onInput} onChange=${onChange} onKeyDown=${onKeyDown}>
    <${Component} markup=${markup} />
  </div>`;
}
