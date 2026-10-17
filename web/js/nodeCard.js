// nodeCard.js —— 生成 4 类节点卡片的 HTML 内容（机器 / 固定源 / 最终产物箱 / 黑盒）。
// 卡片中的可交互控件通过 graph.js 的事件委托统一处理，卡片本身只负责结构与初值。
import { recipes } from "./recipes.js";
import { fmt } from "./engine.js";
import { esc, iconImg } from "./dom.js";

function portRow(dir, idx, itemId, name, fixed, proportional) {
  const attr = dir === "in" ? "data-pin" : "data-pout";
  const fixedTag = fixed
    ? ` <b class="fixed-tag" title="恒定消耗：每台机器运转时按固定速率消耗，与配方产量无关（类似耗电）。总量 = 单台速率 × 台数（速度向上取整）">恒定</b>`
    : (proportional
      ? ` <b class="proportional-tag" title="比例消耗：按机器实际有效速度线性变化，例如速度0.5/1/1.5时分别消耗基准的0.5/1/1.5倍">比例</b>`
      : "");
  return (
    `<div class="port-row ${dir}" ${attr}="${idx}">` +
    iconImg(itemId, "p-icon") +
    `<span class="p-name">${esc(name)}${fixedTag}</span>` +
    `<span class="p-rate" data-rate>–</span>` +
    `</div>`
  );
}

function portColumns(inputs = "", outputs = "", extraClass = "") {
  if (!inputs && !outputs) {
    return `<div class="port-columns is-empty ${extraClass}"><div class="port-empty">没有输入或输出</div></div>`;
  }
  return `<div class="port-columns ${extraClass}">` +
    `<div class="port-list">${inputs}${outputs}</div>` +
    `</div>`;
}

// ---- 各类型卡片 ----
function machineCard(st) {
  const rec = st.recipe;
  const inputs = rec.inputs.map((p, i) => portRow("in", i, p.item_id, p.name_cn, p.fixed, p.proportional)).join("");
  const outputs = rec.outputs.map((p, i) => portRow("out", i, p.item_id, p.name_cn, p.fixed, p.proportional)).join("");
  const on = st.auto_slow ? "on" : "";
  // 无产出配方（如废水处理机）用首个输入物料作为标题图标
  const headItem = (rec.outputs[0] && rec.outputs[0].item_id) || (rec.inputs[0] && rec.inputs[0].item_id);
  const tag = rec.temporary ? ' <b class="tmp-tag">临时</b>'
    : (rec.special ? ' <b class="spec-tag">特殊</b>' : "");
  const recipeSub = rec.duplicateName ? `${rec.recipe_name} · ` : "";
  return `
  <div class="df-card type-machine">
    <div class="card-head">
      ${iconImg(headItem, "head-icon")}
      <div class="head-body">
        <div class="head-title" title="${esc(st.label || rec.displayName || rec.recipe_name)}">${esc(st.label || rec.displayName || rec.recipe_name)}${tag}</div>
        <div class="head-sub">${esc(recipeSub + rec.facility_name_cn)} · ${fmt(rec.time_sec)}s</div>
      </div>
    </div>
    <div class="card-body">
      <div class="speed-row">
        <label>速度</label>
        <input class="speed-input" data-role="speed" value="${esc(st.speed)}" spellcheck="false" ${st.auto_slow ? "disabled" : ""} />
        <span class="speed-x">×</span>
        <span class="toggle-row" data-role="autoslow">
          <span class="toggle ${on}"></span><span class="tg-label">自动降速</span>
        </span>
      </div>
      ${portColumns(inputs, outputs)}
    </div>
  </div>`;
}

function sourceCard(st) {
  const outputs = Array.isArray(st.source_outputs)
    ? st.source_outputs
    : [{ item_id: st.source_item || "", rate: st.source_rate || "0" }];
  const firstChosen = outputs.find((output) => output.item_id);
  const collapsed = !!st.source_collapsed;
  const rows = outputs.map((output, i) => {
    const chosen = output.item_id || "";
    const name = chosen ? recipes.itemName(chosen) : "";
    return `<div class="source-output-group">
      <div class="source-details">
        <div class="source-item ${chosen ? "" : "is-empty"}">${chosen ? esc(name) : "连线到机器输入口后自动确定物品"}</div>
        <div class="field-inline">
          <input class="mini-input" data-role="source-rate" data-source-output="${i}" value="${esc(output.rate)}" spellcheck="false" />
          <span class="speed-x">/分</span>
        </div>
      </div>
      ${portRow("out", i, chosen, chosen ? name : "未连接")}
    </div>`;
  }).join("");
  return `
  <div class="df-card type-source ${collapsed ? "is-collapsed" : ""}">
    <div class="card-head">
      ${iconImg(firstChosen ? firstChosen.item_id : "", "head-icon")}
      <div class="head-body">
        <div class="head-title">${esc(st.label || "固定源")}</div>
        <div class="head-sub">${outputs.length ? `${outputs.length} 路输出` : "暂无输出"}</div>
      </div>
      <button class="source-fold-btn" type="button" data-role="source-fold" data-no-drag
        aria-label="${collapsed ? "展开固定源" : "折叠固定源"}" title="${collapsed ? "展开" : "折叠"}">${collapsed ? "▸" : "▾"}</button>
    </div>
    <div class="card-body">${portColumns("", rows || '<div class="source-no-output">暂无输出，请在右侧检查器中添加</div>')}</div>
  </div>`;
}

function sinkCard(st) {
  const title = st.label || "最终产物箱";
  const subtitle = title.includes("丢弃") ? "收集可直接排出的副产物" : "收集该模块最终产出";
  return `
  <div class="df-card type-sink">
    <div class="card-head">
      <span class="head-icon sink-icon">▣</span>
      <div class="head-body">
        <div class="head-title">${esc(title)}</div>
        <div class="head-sub">${esc(subtitle)}</div>
      </div>
    </div>
    <div class="card-body">
      ${portColumns(
        '<div class="in-any"><div class="port-row in" data-pin="0"><span class="p-name">接收任意产物</span></div></div>' +
        '<div class="sink-inflow" data-role="inflow"><div class="muted">暂无流入</div></div>',
        ""
      )}
    </div>
  </div>`;
}

function boundaryCard(st) {
  const isInput = st.boundary === "input";
  const ports = isInput
    ? (st.source_outputs || []).map((port) => ({ item_id: port.item_id, rate: Number(port.rate) || 0 }))
    : (st.sink_inputs || []);
  const rows = ports.map((port, index) => {
    const dir = isInput ? "out" : "in";
    const row = portRow(dir, index, port.item_id, recipes.itemName(port.item_id));
    return row.replace("<span class=\"p-rate\" data-rate>–</span>",
      `<span class="p-rate"${isInput ? " data-rate" : ""}>${fmt(port.rate)} /分</span>`);
  }).join("");
  return `
  <div class="df-card type-boundary type-boundary-${isInput ? "input" : "output"}">
    <div class="card-head">
      <span class="head-icon boundary-icon">${isInput ? "▶" : "▣"}</span>
      <div class="head-body">
        <div class="head-title">${isInput ? "模块输入" : "模块输出"}</div>
        <div class="head-sub">固定边界 · ${ports.length} 种物品</div>
      </div>
    </div>
    <div class="card-body">
      ${portColumns(
        isInput ? "" : (rows || '<div class="muted">没有对外端口</div>'),
        isInput ? (rows || '<div class="muted">没有对外端口</div>') : "",
        "port-columns-boundary"
      )}
    </div>
  </div>`;
}

function mergerCard(st) {
  const itemId = st.item_id || "";
  const itemName = itemId ? recipes.itemName(itemId) : "连接后自动确定物料";
  return `
  <div class="df-card type-merger">
    <div class="card-head">
      ${iconImg(itemId, "head-icon")}
      <div class="head-body">
        <div class="head-title">${esc(st.label || "汇流分配器")}</div>
        <div class="head-sub">${esc(itemName)}</div>
      </div>
    </div>
    <div class="card-body">
      <div class="merger-hint">多路汇入 · 按路径模式分配</div>
      ${portColumns(
        portRow("in", 0, itemId, itemId ? itemName : "汇入"),
        portRow("out", 0, itemId, itemId ? itemName : "分配")
      )}
    </div>
  </div>`;
}

function portalCard(st) {
  const isInput = st.type === "portal_in";
  const itemId = st.item_id || "";
  const itemName = itemId ? recipes.itemName(itemId) : "连接后自动确定物料";
  const row = portRow(isInput ? "in" : "out", 0, itemId, itemId ? itemName : (isInput ? "传送入口" : "传送出口"));
  const status = st.portal_connected === false
    ? `<div class="portal-broken"><span>连接已删除</span><button type="button" data-role="portal-repair" data-no-drag>修复</button></div>`
    : `<div class="portal-status">已连接配对传送门</div>`;
  return `
  <div class="df-card type-portal type-portal-${isInput ? "in" : "out"}">
    <div class="card-head">
      <span class="head-icon portal-icon">${isInput ? "↘" : "↗"}</span>
      <div class="head-body">
        <div class="head-title">${esc(st.label || (isInput ? "传送门入口" : "传送门出口"))}</div>
        <div class="head-sub">${esc(itemName)}</div>
      </div>
    </div>
    <div class="card-body">
      ${status}
      ${portColumns(isInput ? row : "", isInput ? "" : row)}
    </div>
  </div>`;
}

function blackboxCard(st) {
  const comp = st.box;
  const inputs = (comp.external_inputs || []).map((p, i) => portRow("in", i, p.item_id, recipes.itemName(p.item_id))).join("");
  const embeddedInputs = (comp.embedded_inputs || []).map((p) =>
    `<div class="port-row embedded">${iconImg(p.item_id, "p-icon")}` +
    `<span class="p-name">${esc(recipes.itemName(p.item_id))}</span>` +
    `<span class="p-rate">${fmt(p.rate)} /分</span></div>`
  ).join("");
  const outputs = (comp.external_outputs || []).map((p, i) => portRow("out", i, p.item_id, recipes.itemName(p.item_id))).join("");
  const on = st.auto_slow ? "on" : "";
  const foldedProcess = comp.component_kind === "production";
  const internalCount = comp.internal && Array.isArray(comp.internal.nodes) ? comp.internal.nodes.length : 0;
  const subtitle = foldedProcess
    ? `折叠生产 · ${internalCount} 台机器 · ${(comp.external_inputs || []).length} 种输入`
    : `组件 · ${internalCount} 台机器`;
  const speedRow = foldedProcess ? "" : `
      <div class="speed-row">
        <label>速度</label>
        <input class="speed-input" data-role="speed" value="${esc(st.speed)}" spellcheck="false" ${st.auto_slow ? "disabled" : ""} />
        <span class="speed-x">×</span>
        <span class="toggle-row" data-role="autoslow">
          <span class="toggle ${on}"></span><span class="tg-label">自动降速</span>
        </span>
      </div>`;
  return `
  <div class="df-card type-blackbox">
    <div class="card-head">
      <span class="head-icon blackbox-icon">◧</span>
      <div class="head-body">
        <div class="head-title">${esc(st.label || comp.name || "黑盒")}</div>
        <div class="head-sub">${esc(subtitle)}</div>
      </div>
      <button class="blackbox-open-btn" type="button" data-role="blackbox-open" data-no-drag title="查看内部结构">进入内部</button>
    </div>
    <div class="card-body">
      ${speedRow}
      ${portColumns(inputs + embeddedInputs, outputs)}
    </div>
  </div>`;
}

export function renderCard(st) {
  if (st.boundary) return boundaryCard(st);
  switch (st.type) {
    case "machine": return machineCard(st);
    case "source": return sourceCard(st);
    case "sink": return sinkCard(st);
    case "merger": return mergerCard(st);
    case "portal_in":
    case "portal_out": return portalCard(st);
    case "blackbox": return blackboxCard(st);
    default: return `<div class="df-card">未知节点</div>`;
  }
}

// 供固定源速率标签用
export { esc, iconImg };
