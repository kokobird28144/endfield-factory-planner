import { solveConstraints } from './scanHighs.js';
import { normalizeFlowRule } from './flowRules.js';
import { parseSpeed } from './engine.js';

const constant = value => ({ terms: new Map(), value, low: value, high: value });
const add = (...args) => {
  const result = constant(0);
  for (const a of args) {
    result.value += a.value; result.low += a.low; result.high += a.high;
    for (const [name, coefficient] of a.terms) {
      const value = (result.terms.get(name) || 0) + coefficient;
      if (value === 0) result.terms.delete(name); else result.terms.set(name, value);
    }
  }
  return result;
};
const times = (a, factor) => ({ terms: new Map([...a.terms].map(([k, v]) => [k, v * factor])),
  value: a.value * factor, low: (factor >= 0 ? a.low : a.high) * factor, high: (factor >= 0 ? a.high : a.low) * factor });
const minus = (a, b) => add(a, times(b, -1));
const signature = a => JSON.stringify([a.value, [...a.terms].sort(([a], [b]) => a.localeCompare(b))]);
const evaluate = (a, values) => a.value + [...a.terms].reduce((s, [k, v]) => s + v * (values[k] ?? 0), 0);

class LinearSystem {
  constructor() {
    this.variables = {}; this.binaries = {};
    this.count = 0; this.rows = []; this.minimums = new Map();
  }
  variable(low, high, binary = false) {
    if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) throw new Error('约束范围无效。');
    if (high === low) return constant(low);
    const name = `v${this.count++}`;
    this.variables[name] = true;
    if (binary) this.binaries[name] = true;
    const result = { terms: new Map([[name, 1]]), value: low, low, high };
    this.constraint(result, 'max', constant(high));
    return result;
  }
  constraint(a, type, b) {
    if (this.rows.length >= 50000) throw new Error('分配约束过多，请缩小扫描产线。');
    const row = minus(a, b);
    this.rows.push({ row, type });
  }
  min(a, b) {
    if (a.high <= b.low) return a;
    if (b.high <= a.low) return b;
    const ka = signature(a), kb = signature(b);
    if (ka === kb) return a;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (this.minimums.has(key)) return this.minimums.get(key);
    const z = this.variable(Math.min(a.low, b.low), Math.min(a.high, b.high));
    const choose = this.variable(0, 1, true);
    this.constraint(z, 'max', a); this.constraint(z, 'max', b);
    this.constraint(z, 'min', minus(a, times(minus(constant(1), choose), a.high - z.low)));
    this.constraint(z, 'min', minus(b, times(choose, b.high - z.low)));
    this.minimums.set(key, z);
    return z;
  }
  max(a, b) {
    const result = minus(add(a, b), this.min(a, b));
    result.low = Math.max(a.low, b.low); result.high = Math.max(a.high, b.high);
    return result;
  }
  residual(values) {
    if (Object.keys(this.variables).some(name => !Number.isFinite(values[name]))) return Infinity;
    let residual = 0;
    for (const { row, type } of this.rows) {
      const v = evaluate(row, values);
      residual = Math.max(residual, type === 'equal' ? Math.abs(v) : type === 'max' ? v : -v);
    }
    for (const name of Object.keys(this.variables)) residual = Math.max(residual, -values[name]);
    for (const name of Object.keys(this.binaries)) residual = Math.max(residual, Math.abs(values[name] - Math.round(values[name])));
    return residual;
  }
}

// Compile capped allocation into linear pieces. A group's water level enforces
// the original proportions; it is not an objective that maximizes production.
function allocation(system, total, edges, ceilings, target, receiving) {
  const groups = new Map();
  for (const e of edges) {
    const weight = receiving ? 1 : e.mode === 'fixed' ? e.fixedRate : e.mode === 'weight' ? e.weight : 1;
    if (weight <= 0) continue;
    const priority = receiving ? e.receivePriority : e.mode === 'fixed' ? 0 : e.mode === 'priority' ? e.priority : Infinity;
    if (!groups.has(priority)) groups.set(priority, []);
    groups.get(priority).push({ e, weight, cap: ceilings.get(e.id) });
  }
  for (const [, entries] of [...groups].sort(([a], [b]) => a - b)) {
    const wanted = entries.find(x => x.e.id === target.id);
    const capacity = add(...entries.map(x => x.cap));
    if (!wanted) { total = system.max(constant(0), minus(total, capacity)); continue; }
    if (entries.length === 1) return system.min(total, wanted.cap);
    const scale = Math.max(...entries.map(x => x.weight));
    entries.forEach(x => { x.weight /= scale; });
    const weights = entries.reduce((s, x) => s + x.weight, 0);
    if (entries.length === 2) {
      const other = entries.find(x => x !== wanted);
      return system.min(wanted.cap, system.max(times(total, wanted.weight / weights), minus(total, other.cap)));
    }
    const amount = system.min(total, capacity);
    const level = system.variable(0, amount.high / Math.min(...entries.map(x => x.weight)));
    const shares = entries.map(x => system.min(x.cap, times(level, x.weight)));
    system.constraint(add(...shares), 'equal', amount);
    return shares[entries.indexOf(wanted)];
  }
  return constant(0);
}

export function solveLinearScan(model, { timeout = 1000 } = {}) {
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('求解时间上限必须为非负有限数。');
  const nodes = model.nodes;
  const cap = n => parseSpeed(n.maxSpeed ?? n.speed, 1);
  const edges = model.edges.map(e => ({ ...e, ...normalizeFlowRule(e), receivePriority: Math.max(1, Number(e.receivePriority) || 1) }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const bound = Math.max(1, nodes.reduce((s, n) => s + n.outputPorts.reduce((v, p) => v + p.baseRate * (n.type === 'source' ? 1 : cap(n)), 0), 0));
  if (!Number.isFinite(bound) || bound > 1e10) throw new Error('扫描规模过大，请降低供给或机器产能。');
  const scale = Math.max(1, ...nodes.flatMap(n => [...n.inputPorts, ...n.outputPorts].map(p => p.baseRate * (n.type === 'source' ? 1 : cap(n)))));
  const system = new LinearSystem(), inputs = new Map(), outputs = new Map();
  const key = (id, port) => JSON.stringify([id, port]);
  const offers = new Map(), requests = new Map(), flows = new Map(), speeds = new Map();
  const limit = e => Math.min(bound, e.maxRate ?? bound, e.mode === 'fixed' ? e.fixedRate : bound) / scale;
  for (const e of edges) {
    const a = key(e.from, e.fromPort), b = key(e.to, e.toPort);
    if (!outputs.has(a)) outputs.set(a, []);
    if (!inputs.has(b)) inputs.set(b, []);
    outputs.get(a).push(e); inputs.get(b).push(e);
    const source = byId.get(e.from), target = byId.get(e.to);
    const outputCap = source.type === 'source' ? source.outputPorts[e.fromPort].baseRate : source.type === 'machine' ? source.outputPorts[e.fromPort].baseRate * cap(source) : bound;
    const inputCap = target.type === 'machine' ? target.inputPorts[e.toPort].baseRate * cap(target) : bound;
    offers.set(e.id, system.variable(0, e.mode === 'weight' && e.weight === 0 ? 0 : Math.min(limit(e), outputCap / scale)));
    requests.set(e.id, system.variable(0, Math.min(limit(e), inputCap / scale)));
  }
  const sumAt = (groups, id, index, values) => add(...(groups.get(key(id, index)) || []).map(e => values.get(e.id)));
  for (const n of nodes) {
    const available = n.inputPorts.map((p, i) => sumAt(inputs, n.id, i, offers));
    const room = n.outputPorts.map((p, i) => sumAt(outputs, n.id, i, requests));
    const potential = (skipInput, skipOutput) => {
      let value = constant(cap(n));
      n.inputPorts.forEach((p, i) => { if (i !== skipInput && p.baseRate > 0) value = system.min(value, times(available[i], scale / p.baseRate)); });
      n.outputPorts.forEach((p, i) => { if (i !== skipOutput && p.baseRate > 0) value = system.min(value, times(room[i], scale / p.baseRate)); });
      return value;
    };
    const allocate = (list, total, messages, values, receiving) => {
      for (const e of list) {
        const ceilings = new Map(list.map(other => [other.id,
          system.min(other === e ? constant(bound / scale) : messages.get(other.id), constant(limit(other)))]));
        system.constraint(values.get(e.id), 'equal', allocation(system, total, list, ceilings, e, receiving));
      }
    };
    n.outputPorts.forEach((p, i) => {
      const total = n.type === 'source' ? constant(p.baseRate / scale) : n.type === 'merger' ? available[0] : times(potential(-1, i), p.baseRate / scale);
      allocate(outputs.get(key(n.id, i)) || [], total, requests, offers, false);
    });
    n.inputPorts.forEach((p, i) => {
      const total = n.type === 'sink' ? constant(bound / scale) : n.type === 'merger' ? room[0] : times(potential(i, -1), p.baseRate / scale);
      allocate(inputs.get(key(n.id, i)) || [], total, offers, requests, true);
    });
  }
  for (const e of edges) flows.set(e.id, system.min(offers.get(e.id), requests.get(e.id)));
  for (const n of nodes) {
    const inflow = n.inputPorts.map((p, i) => sumAt(inputs, n.id, i, flows));
    const outflow = n.outputPorts.map((p, i) => sumAt(outputs, n.id, i, flows));
    if (n.type === 'machine') {
      const speed = system.variable(0, cap(n)); speeds.set(n.id, speed);
      n.inputPorts.forEach((p, i) => system.constraint(inflow[i], 'equal', times(speed, p.baseRate / scale)));
      n.outputPorts.forEach((p, i) => system.constraint(outflow[i], 'equal', times(speed, p.baseRate / scale)));
    } else if (n.type === 'merger') system.constraint(inflow[0], 'equal', outflow[0]);
    else if (n.type === 'source') n.outputPorts.forEach((p, i) => system.constraint(outflow[i], 'max', constant(p.baseRate / scale)));
  }
  const solution = timeout > 0 ? solveConstraints(system.rows, system.variables, Object.keys(system.binaries), timeout) : { status: 'Time limit reached', values: {} };
  const result = solution.values;
  const residual = solution.status === 'Optimal' ? system.residual(result) : Infinity;
  const valid = residual * Math.max(scale, 1) < 1e-5;
  return { valid, status: solution.status, residual: residual * scale, scale, bound, edges,
    offers: new Map(edges.map(e => [e.id, evaluate(offers.get(e.id), result) * scale])),
    requests: new Map(edges.map(e => [e.id, evaluate(requests.get(e.id), result) * scale])),
    flows: new Map(edges.map(e => [e.id, evaluate(flows.get(e.id), result) * scale])),
    speeds: Object.fromEntries([...speeds].map(([id, expression]) => [id, evaluate(expression, result)])),
    variables: system.count, constraints: system.rows.length, binaries: Object.keys(system.binaries).length };
}
