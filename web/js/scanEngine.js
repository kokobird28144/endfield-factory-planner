import { normalizeFlowRule, splitCapped } from "./flowRules.js";
import { parseSpeed } from "./engine.js";
import { solveLinearScan } from "./scanLinear.js";

const EPS = 1e-7;
const key = (id, port) => `${id}#${port}`;

export function validateScanModel(model) {
  if (!model.nodes.length) throw new Error("画布为空，请选择蓝药示例或添加产线。");
  const ids = new Map();
  for (const n of model.nodes) {
    if (ids.has(n.id)) throw new Error("节点 ID 重复。");
    ids.set(n.id, n);
    if (!["source", "sink", "machine", "merger"].includes(n.type))
      throw new Error(`暂不支持 ${n.label || n.id}（${n.type}），请先展开为普通机器产线。`);
    if (!Number.isFinite(parseSpeed(n.maxSpeed ?? n.speed ?? 1, NaN))) throw new Error("机器最大速度必须是非负有限数。");
    for (const p of [...n.inputPorts, ...n.outputPorts]) {
      if (p.fixed) throw new Error(`暂不支持恒定运转消耗：${n.label || n.id}。`);
      if (!Number.isFinite(p.baseRate) || p.baseRate < 0) throw new Error("端口速率必须是非负有限数。");
    }
    if (n.type === "merger" && (n.inputPorts.length !== 1 || n.outputPorts.length !== 1))
      throw new Error("汇流器必须有一个输入和一个输出。");
  }
  const degree = new Map(model.nodes.map(n => [n.id, 0]));
  const next = new Map(model.nodes.map(n => [n.id, []]));
  const edgeIds = new Set();
  for (const e of model.edges) {
    if (edgeIds.has(e.id)) throw new Error("连线 ID 重复。");
    edgeIds.add(e.id);
    const a = ids.get(e.from), b = ids.get(e.to);
    const out = a?.outputPorts[e.fromPort], input = b?.inputPorts[e.toPort];
    if (!out || !input || !out.item_id || (input.item_id && out.item_id !== input.item_id))
      throw new Error("存在端口缺失或物料不匹配的连线。");
    degree.set(e.to, degree.get(e.to) + 1);
    next.get(e.from).push(e.to);
  }
  const queue = [...degree].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    visited++;
    for (const id of next.get(queue[i])) {
      degree.set(id, degree.get(id) - 1);
      if (degree.get(id) === 0) queue.push(id);
    }
  }
  if (visited !== model.nodes.length) throw new Error("第一版暂不支持物料回流或自连接；请先使用无回流产线。");
}

// Reuse the editor's capped proportional allocator. Receiving priority is a
// separate rule from the priority of destinations sharing an output.
function distribute(total, edges, ceilings, receiving = false) {
  const result = new Map(edges.map(e => [e.id, 0]));
  const groups = new Map();
  for (const e of edges) {
    const level = receiving ? e.receivePriority : e.mode === "fixed" ? 0 : e.mode === "priority" ? e.priority : Infinity;
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level).push(e);
  }
  for (const [, group] of [...groups].sort(([a], [b]) => a - b)) {
    const entries = group.map(e => ({
      id: e.id,
      weight: receiving ? 1 : e.mode === "fixed" ? e.fixedRate : e.mode === "weight" ? e.weight : 1,
      cap: Math.min(ceilings.get(e.id) || 0, e.maxRate ?? Infinity, e.mode === "fixed" ? e.fixedRate : Infinity),
    }));
    for (const [id, value] of splitCapped(total, entries)) {
      result.set(id, value);
      total = Math.max(0, total - value);
    }
  }
  return result;
}

export function solveScan(model, { timeout = 1000 } = {}) {
  validateScanModel(model);
  const solution = solveLinearScan(model, { timeout });
  const nodes = model.nodes;
  const edges = model.edges.map(e => ({ ...e, ...normalizeFlowRule(e), receivePriority: Math.max(1, Number(e.receivePriority) || 1) }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const inputs = new Map(), outputs = new Map();
  for (const e of edges) {
    const a = key(e.from, e.fromPort), b = key(e.to, e.toPort);
    if (!outputs.has(a)) outputs.set(a, []);
    if (!inputs.has(b)) inputs.set(b, []);
    outputs.get(a).push(e); inputs.get(b).push(e);
  }
  const cap = n => parseSpeed(n.maxSpeed ?? n.speed, 1);
  const bound = Math.max(1, nodes.reduce((sum, n) => sum + n.outputPorts.reduce((s, p) =>
    s + p.baseRate * (n.type === "source" ? 1 : cap(n)), 0), 0));
  if (!Number.isFinite(bound) || bound > 1e10) throw new Error("扫描规模过大，请降低供给或机器产能。");
  const offers = solution.offers;
  const requests = solution.requests;
  const sumAt = (groups, id, index, values) => (groups.get(key(id, index)) || []).reduce((s, e) => s + values.get(e.id), 0);
  let ruleResidual = 0;
  // Independently verify the compiled allocation constraints using the editor's
  // original numeric allocator. These messages are checked once, not iterated.
  {
    const newOffers = new Map(), newRequests = new Map();
    for (const n of nodes) {
      const available = n.inputPorts.map((p, i) => sumAt(inputs, n.id, i, offers));
      const room = n.outputPorts.map((p, i) => sumAt(outputs, n.id, i, requests));
      const potential = (skipInput, skipOutput) => {
        let speed = cap(n);
        n.inputPorts.forEach((p, i) => { if (i !== skipInput && p.baseRate > 0) speed = Math.min(speed, available[i] / p.baseRate); });
        n.outputPorts.forEach((p, i) => { if (i !== skipOutput && p.baseRate > 0) speed = Math.min(speed, room[i] / p.baseRate); });
        return speed;
      };
      n.outputPorts.forEach((p, i) => {
        const list = outputs.get(key(n.id, i)) || [];
        const total = n.type === "source" ? p.baseRate : n.type === "merger" ? available[0] : p.baseRate * potential(-1, i);
        for (const e of list) {
          // Exclude this edge's own bottleneck, so released capacity can recover.
          const ceilings = new Map(list.map(other => [other.id, other === e ? bound : requests.get(other.id)]));
          newOffers.set(e.id, distribute(total, list, ceilings).get(e.id));
        }
      });
      n.inputPorts.forEach((p, i) => {
        const list = inputs.get(key(n.id, i)) || [];
        const total = n.type === "sink" ? bound : n.type === "merger" ? room[0] : p.baseRate * potential(i, -1);
        for (const e of list) {
          const ceilings = new Map(list.map(other => [other.id, other === e ? bound : offers.get(other.id)]));
          newRequests.set(e.id, distribute(total, list, ceilings, true).get(e.id));
        }
      });
    }
    for (const e of edges) {
      ruleResidual = Math.max(ruleResidual, Math.abs(newOffers.get(e.id) - offers.get(e.id)), Math.abs(newRequests.get(e.id) - requests.get(e.id)));
    }
  }
  const flows = new Map(edges.map(e => [e.id, Math.max(0, Math.min(offers.get(e.id), requests.get(e.id)))]));
  const speeds = {}, finalOutput = {}, sources = {}, bottlenecks = [];
  let residual = 0;
  for (const n of nodes) {
    const inflow = n.inputPorts.map((p, i) => sumAt(inputs, n.id, i, flows));
    const outflow = n.outputPorts.map((p, i) => sumAt(outputs, n.id, i, flows));
    if (n.type === "source") {
      sources[n.id] = n.outputPorts.map((p, i) => ({ available: p.baseRate, used: outflow[i], unused: Math.max(0, p.baseRate - outflow[i]) }));
      outflow.forEach((v, i) => { residual = Math.max(residual, v - n.outputPorts[i].baseRate); });
    } else if (n.type === "sink") {
      for (const e of edges.filter(e => e.to === n.id)) {
        const item = byId.get(e.from).outputPorts[e.fromPort].item_id;
        finalOutput[item] = (finalOutput[item] || 0) + flows.get(e.id);
      }
    } else if (n.type === "merger") {
      residual = Math.max(residual, Math.abs(inflow[0] - outflow[0]));
    } else {
      const ratios = [...n.inputPorts.map((p, i) => p.baseRate > 0 ? inflow[i] / p.baseRate : null),
        ...n.outputPorts.map((p, i) => p.baseRate > 0 ? outflow[i] / p.baseRate : null)].filter(v => v !== null);
      const speed = Math.min(cap(n), ...ratios);
      speeds[n.id] = speed;
      n.inputPorts.forEach((p, i) => { residual = Math.max(residual, Math.abs(inflow[i] - p.baseRate * speed)); });
      n.outputPorts.forEach((p, i) => { residual = Math.max(residual, Math.abs(outflow[i] - p.baseRate * speed)); });
      if (cap(n) > 0 && Math.abs(speed - cap(n)) < 1e-5) bottlenecks.push(n.id);
    }
  }
  const valid = solution.valid && ruleResidual < EPS && residual < 1e-5;
  return { valid, converged: valid, residual, ruleResidual, constraintResidual: solution.residual,
    solver: 'linear-constraints', solverStatus: solution.status, variables: solution.variables, constraints: solution.constraints,
    reason: valid ? null : solution.status === 'Time limit reached' ? 'limit' : 'unresolved',
    flows: Object.fromEntries(flows), speeds,
    finalOutput: valid ? finalOutput : {}, sources, bottlenecks };
}

export { scanValues } from './scanGrid.js';
