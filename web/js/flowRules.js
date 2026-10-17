// Shared edge settings for the editor, engine and persisted plans.
export function normalizeFlowRule(edge = {}) {
  const nonnegative = (value, fallback) => {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  return {
    mode: ["weight", "fixed", "priority"].includes(edge.mode) ? edge.mode : "weight",
    weight: nonnegative(edge.weight, 1),
    fixedRate: nonnegative(edge.fixedRate, 0),
    priority: Number.isSafeInteger(Number(edge.priority)) && Number(edge.priority) >= 1 ? Number(edge.priority) : 1,
    maxRate: nonnegative(edge.maxRate, null),
  };
}

export function flowRuleLabel(edge, format = String) {
  const rule = normalizeFlowRule(edge);
  if (rule.mode === "fixed") return `固定 ${format(rule.fixedRate)}/分`;
  if (rule.mode === "priority") {
    return `优先 ${rule.priority}${rule.maxRate == null ? "" : ` · 上限 ${format(rule.maxRate)}/分`}`;
  }
  return `权重 ${format(rule.weight)}`;
}

// Allocate proportionally, respecting each path's ceiling; redistribute unused shares.
export function splitCapped(total, entries) {
  const result = new Map(entries.map((entry) => [entry.id, 0]));
  let active = entries.filter((entry) => entry.weight > 0 && entry.cap > 0);
  while (total > 1e-9 && active.length) {
    const scale = Math.max(...active.map((entry) => entry.weight));
    const sum = active.reduce((value, entry) => value + entry.weight / scale, 0);
    const capped = active.filter((entry) => total * (entry.weight / scale) / sum >= entry.cap);
    if (!capped.length) {
      for (const entry of active) result.set(entry.id, total * (entry.weight / scale) / sum);
      break;
    }
    const done = new Set(capped.map((entry) => entry.id));
    for (const entry of capped) {
      result.set(entry.id, entry.cap);
      total = Math.max(0, total - entry.cap);
    }
    active = active.filter((entry) => !done.has(entry.id));
  }
  return result;
}

// Mixed-mode graphs use bounded sweeps, including merger/portal throughput and
// supplies from other output ports. Sorting makes results independent of array order.
export function allocateFlows(nodes, edges, production, demand) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const portalInputs = new Map(nodes.filter((node) => node.type === "portal_in" && node.pair_id)
    .map((node) => [node.pair_id, node]));
  const groups = new Map();
  const incoming = new Map();
  const rates = new Map(edges.map((edge) => [edge.id, 0]));
  const rules = new Map(edges.map((edge) => [edge.id, normalizeFlowRule(edge)]));
  const inputKey = (edge) => `${edge.to}#${edge.toPort}`;
  for (const edge of edges) {
    const key = `${edge.from}#${edge.fromPort}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
    if (!incoming.has(inputKey(edge))) incoming.set(inputKey(edge), []);
    incoming.get(inputKey(edge)).push(edge);
  }
  const orderedGroups = [...groups].sort(([a], [b]) => a.localeCompare(b));
  const itemAt = (edge) => nodeById.get(edge.from)?.outputPorts[edge.fromPort]?.item_id;
  const supply = (key, item) => (incoming.get(key) || []).reduce((sum, edge) =>
    sum + (!item || itemAt(edge) === item ? rates.get(edge.id) || 0 : 0), 0);
  let converged = false;
  for (let iteration = 0; iteration < 240; iteration++) {
    const before = new Map(rates);
    for (const [, list] of orderedGroups) {
      const source = nodeById.get(list[0].from);
      const port = source?.outputPorts[list[0].fromPort];
      let total = 0;
      if (source && port) {
        const upstream = source.type === "portal_out" ? portalInputs.get(source.pair_id) : source;
        total = source.type === "merger" || source.type === "portal_out"
          ? (upstream ? supply(`${upstream.id}#0`, port.item_id) : 0)
          : production(source, list[0].fromPort);
      }
      total = Number.isFinite(total) ? Math.max(0, total) : 0;
      // Remove this output's previous allocations before measuring unmet demand.
      for (const edge of list) rates.set(edge.id, 0);
      const fixed = list.filter((edge) => rules.get(edge.id).mode === "fixed");
      const fixedShares = splitCapped(total, fixed.map((edge) => ({
        id: edge.id, weight: rules.get(edge.id).fixedRate, cap: rules.get(edge.id).fixedRate,
      })));
      for (const [id, rate] of fixedShares) { rates.set(id, rate); total = Math.max(0, total - rate); }

      const levels = [...new Set(list.filter((edge) => rules.get(edge.id).mode === "priority")
        .map((edge) => rules.get(edge.id).priority))].sort((a, b) => a - b);
      for (const level of levels) {
        const candidates = list.filter((edge) => rules.get(edge.id).mode === "priority" && rules.get(edge.id).priority === level);
        // One input can be reached more than once: share its remaining demand once.
        const targets = new Map();
        for (const edge of candidates) {
          const key = inputKey(edge);
          if (!targets.has(key)) targets.set(key, []);
          targets.get(key).push(edge);
        }
        const claims = [];
        for (const [key, targetEdges] of targets) {
          const target = nodeById.get(targetEdges[0].to);
          const input = target?.inputPorts[targetEdges[0].toPort];
          const compatible = target && input && (!input.item_id || input.item_id === port?.item_id);
          const finiteDemand = target && ["machine", "blackbox"].includes(target.type);
          const need = !compatible ? 0 : finiteDemand
            ? Math.max(0, demand(target, targetEdges[0].toPort) - supply(key, input.item_id)) : Infinity;
          const capacities = targetEdges.map((edge) => ({
            id: edge.id, weight: 1, cap: rules.get(edge.id).maxRate ?? Infinity,
          }));
          const caps = Number.isFinite(need) ? splitCapped(need, capacities) : new Map(capacities.map((entry) => [entry.id, entry.cap]));
          for (const edge of targetEdges) {
            const cap = caps.get(edge.id) || 0;
            // Unbounded receivers request the available amount; equal unbounded paths split equally.
            claims.push({ id: edge.id, cap, weight: Number.isFinite(need) ? need / targetEdges.length : total });
          }
        }
        const shares = splitCapped(total, claims);
        for (const [id, rate] of shares) { rates.set(id, rate); total = Math.max(0, total - rate); }
      }
      const weighted = list.filter((edge) => rules.get(edge.id).mode === "weight");
      const shares = splitCapped(total, weighted.map((edge) => ({ id: edge.id, weight: rules.get(edge.id).weight, cap: Infinity })));
      for (const [id, rate] of shares) rates.set(id, rate);
    }
    if (edges.every((edge) => Math.abs(rates.get(edge.id) - before.get(edge.id)) <= 1e-7)) {
      converged = true;
      break;
    }
  }
  return { rates, converged };
}
