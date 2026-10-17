// topology.js —— 统一拓扑序列化/反序列化。
// 方案文件采用 zmd_dyn 同族外壳（version/nodes/edges + symbols），并挂本项目扩展字段；
// 本项目文件因此可被 zmd_dyn 直接打开（退化为抽象流量图）。
import { recipes } from "./recipes.js";
import { normalizeFlowRule } from "./flowRules.js";
import { parseSpeed } from "./engine.js";

function sym(base, sub, def) {
  const s = { base, sub: String(sub), text: `${base}${sub}` };
  if (def != null && def !== "") s.defaultValue = String(def);
  return s;
}

function buildSymbols(n) {
  switch (n.type) {
    case "machine": {
      const rec = recipes.resolveRef(n.recipe_ref);
      const inputs = (n.ports && n.ports.inputs ? n.ports.inputs : []).map((item, i) => {
        const qty = rec && rec.inputs[i] ? rec.inputs[i].qty : 1;
        return {
          index: i + 1,
          stock: sym("s", `${n.id}_${i + 1}`),
          capacity: sym("C", `${n.id}_${i + 1}`, "100"),
          recipe: sym("K", `${n.id}_${i + 1}`, qty),
        };
      });
      return { speed: sym("U", n.id, parseSpeed(n.speed, 1)), inputs };
    }
    case "source":
      return {
        input: sym("I", n.id, parseSpeed(n.source_rate, 0)),
        outputs: (n.source_outputs || []).map((output, i) => sym("I", `${n.id}_${i + 1}`, parseSpeed(output.rate, 0))),
      };
    case "sink":
      return { output: sym("O", n.id) };
    case "blackbox":
      return { speed: sym("U", n.id, parseSpeed(n.speed, 1)) };
    case "merger":
      return {};
    default:
      return {};
  }
}

// 组装方案文件（zmd_dyn 同族外壳 + 扩展字段）
export function toPlan(meta, nodes, edges, boards = []) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const planNodes = nodes.map((n) => Object.assign({}, n, { symbols: buildSymbols(n) }));
  const planEdges = edges.map((e, i) => {
    const fn = nodeMap.get(e.from);
    const item = fn && fn.ports && fn.ports.outputs ? fn.ports.outputs[e.fromPort] : null;
    const state = item ? recipes.itemState(item) : "solid";
    return {
      id: `e${i + 1}`,
      from: e.from,
      to: e.to,
      length: 2,
      speed: 0.5,
      symbols: { flow: sym("v", i + 1) },
      from_port: e.fromPort,
      to_port: e.toPort,
      ...normalizeFlowRule(e),
      ...(typeof e.color === "string" && /^#[0-9a-f]{6}$/i.test(e.color) ? { color: e.color } : {}),
      ...(e.width != null && e.width !== "" && Number.isFinite(Number(e.width)) ? { width: Math.max(1, Math.min(12, Number(e.width))) } : {}),
      item_id: item || null,
      state,
    };
  });
  return { version: 1, app: "zmd_recipe", meta: meta || {}, nodes: planNodes, edges: planEdges, boards: Array.isArray(boards) ? boards : [] };
}

// 解析方案文件为 graph.loadFromNodesEdges 可消费的形式
export function fromPlan(plan) {
  const meta = (plan && plan.meta) || {};
  const nodes = (plan && Array.isArray(plan.nodes)) ? plan.nodes : [];
  const edges = ((plan && Array.isArray(plan.edges)) ? plan.edges : []).map((e) => ({
    from: String(e.from),
    to: String(e.to),
    fromPort: Number.isInteger(e.from_port) ? e.from_port : 0,
    toPort: Number.isInteger(e.to_port) ? e.to_port : 0,
    ...normalizeFlowRule(e),
    ...(typeof e.color === "string" && /^#[0-9a-f]{6}$/i.test(e.color) ? { color: e.color } : {}),
    ...(e.width != null && e.width !== "" && Number.isFinite(Number(e.width)) ? { width: Math.max(1, Math.min(12, Number(e.width))) } : {}),
  }));
  const boards = (plan && Array.isArray(plan.boards)) ? plan.boards : [];
  return { meta, nodes, edges, boards };
}

// 导出 zmd_dyn 可直接打开的拓扑：同族外壳；入边按目标端口顺序排列以契合 zmd_dyn 的入边序推断。
export function toDynExport(meta, nodes, edges) {
  const sorted = edges.slice().sort((a, b) => {
    if (a.to !== b.to) return String(a.to).localeCompare(String(b.to));
    return a.toPort - b.toPort;
  });
  const plan = toPlan(meta, nodes, sorted);
  plan.app = "zmd_recipe->zmd_dyn";
  return plan;
}
