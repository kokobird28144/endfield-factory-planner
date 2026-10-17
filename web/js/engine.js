// engine.js —— 纯计算引擎（无 DOM 依赖）。
// 输入：规范化的图模型 { nodes, edges }；输出：各端口速率、供需警告、产消与最终产出统计。
// 口径：端口级流量聚合。扇出先分固定目标，再按优先级分配，剩余按权重分配（默认 1）。
// 告警：输入口供不应求告警；输出口若有产出但既无下游消耗、又无产物箱兜底（产物没去处/未被处理）也告警。
import { recipes } from "./recipes.js";
import { normalizeFlowRule, allocateFlows } from "./flowRules.js";

const EPS = 1e-6;
export const WARN_TOLERANCE = 0.01;
const MAX_ITER = 80;

// 解析运行速度：支持 "2"、"0.5"、"1/3" 等非负分数/小数。
export function parseSpeed(str, fallback = 1) {
  if (typeof str === "number") return str >= 0 ? str : fallback;
  const t = String(str == null ? "" : str).trim();
  if (t === "") return fallback;
  const n = Number(t);
  if (Number.isFinite(n)) return n >= 0 ? n : fallback;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b !== 0 && Number.isFinite(a) && Number.isFinite(b)) {
      const r = a / b;
      if (r >= 0) return r;
    }
  }
  return fallback;
}

// 速率格式化：最多 2 位小数、去尾零。
export function fmt(n) {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  return String(r);
}

/**
 * @param {object} model
 *   model.nodes: [{ id, type, speed, auto_slow,
 *                   inputPorts:[{item_id, baseRate, fixed}], outputPorts:[{item_id, baseRate, fixed}] }]
 *   端口的 fixed=true 表示「恒定消耗/产出」：机器运转时按 baseRate × ⌈速度⌉（物理台数，向上取整）
 *   恒定计量，不随节流后的有效速度缩放（类似耗电量，每台机器一份）；机器停机（有效速度=0）则为 0。
 *   此类端口也不参与自动降速节流。
 *   model.edges: [{ id, from, fromPort, to, toPort, mode?, weight?, fixedRate?, priority?, maxRate? }]
 * @returns 计算结果（见文件尾部结构说明）
 */
export function compute(model) {
  const nodes = model.nodes || [];
  const edges = (model.edges || []).map((edge) => ({ ...edge, ...normalizeFlowRule(edge) }));
  const hasFlowModes = edges.some((edge) => edge.mode !== "weight");
  let mixedFlows = null;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const portalInputByPair = new Map();
  for (const node of nodes) {
    if (node.type === "portal_in" && node.pair_id && !portalInputByPair.has(node.pair_id)) {
      portalInputByPair.set(node.pair_id, node);
    }
  }

  // 入边索引： "nodeId#portIdx" -> [edge...]
  const incomingByPort = new Map();
  // 出边索引： "nodeId#portIdx" -> [edge...]
  const outgoingByPort = new Map();
  for (const e of edges) {
    const inKey = `${e.to}#${e.toPort}`;
    const outKey = `${e.from}#${e.fromPort}`;
    if (!incomingByPort.has(inKey)) incomingByPort.set(inKey, []);
    if (!outgoingByPort.has(outKey)) outgoingByPort.set(outKey, []);
    incomingByPort.get(inKey).push(e);
    outgoingByPort.get(outKey).push(e);
  }

  // 每条边的权重（默认 1，可小数，非法值兜底为 1；显式 0 表示该边不分流）。
  const edgeWeight = (e) => {
    const w = (e && e.weight == null) ? 1 : Number(e.weight);
    return Number.isFinite(w) && w >= 0 ? w : 1;
  };
  // 每个输出端口出边的权重之和：产量按各连线权重占比分摊到下游。
  const outWeightSum = new Map();
  for (const [key, list] of outgoingByPort) {
    let s = 0;
    for (const e of list) s += edgeWeight(e);
    outWeightSum.set(key, s);
  }

  // 初始有效速度
  const eff = new Map();
  for (const n of nodes) {
    eff.set(n.id, n.type === "source" ? 1 : parseSpeed(n.speed, 1));
  }

  // 恒定端口的物理台数：按节点配置的运行速度向上取整（半速也算 1 台，3.5x 算 4 台）。
  // 每台机器运转时按 baseRate 恒定计量，故恒定消耗/产出 = baseRate × ⌈速度⌉，不随节流后的有效速度缩放。
  const machineCount = (n) => Math.ceil(parseSpeed(n.speed, 1));

  // 某端口在给定有效速度下的计量值（消耗或产出）。
  // 恒定端口：机器运转（有效速度 > 0）时 = baseRate × ⌈速度⌉台数；停机为 0。
  // 普通端口：= baseRate × 有效速度。
  const portRate = (n, port, effSpeed) => {
    if (!port) return 0;
    if (port.fixed) return effSpeed > EPS ? port.baseRate * machineCount(n) : 0;
    return port.baseRate * effSpeed;
  };
  const refreshMixedFlows = () => {
    if (!hasFlowModes) return;
    // A throttled input must still be able to request more when another consumer
    // releases capacity. Bound its demand by OTHER ingredients, not its own shortage.
    const priorityDemand = (node, index) => {
      let speed = eff.get(node.id) || 0;
      if (node.auto_slow && ["machine", "blackbox"].includes(node.type)) {
        speed = parseSpeed(node.speed, 1);
        if (mixedFlows) node.inputPorts.forEach((input, otherIndex) => {
          if (otherIndex === index || input.fixed || input.baseRate <= 0) return;
          const incoming = incomingByPort.get(`${node.id}#${otherIndex}`) || [];
          const available = incoming.reduce((sum, edge) => {
            const item = nodeById.get(edge.from)?.outputPorts[edge.fromPort]?.item_id;
            return sum + (item === input.item_id ? mixedFlows.rates.get(edge.id) || 0 : 0);
          }, 0);
          speed = Math.min(speed, available / input.baseRate);
        });
      }
      return portRate(node, node.inputPorts[index], speed);
    };
    mixedFlows = allocateFlows(nodes, edges,
      (node, index) => node.type === "source" ? node.outputPorts[index].baseRate
        : portRate(node, node.outputPorts[index], eff.get(node.id) || 0),
      priorityDemand);
  };
  refreshMixedFlows();

  // 汇流分配器的产量取实际总流入；递归缓存支持连续多个分配器，访问标记防止回流环栈溢出。
  const mergerMemo = new Map();
  const mergerVisiting = new Set();
  let edgeFlow;
  let portSupply;
  const portSupplyMemo = new Map();
  const outProd = (n, portIdx) => {
    const port = n.outputPorts[portIdx];
    if (!port) return 0;
    if (n.type === "source") return port.baseRate; // 固定源不受速度/降速影响
    if (n.type === "merger" || n.type === "portal_out") {
      if (mergerMemo.has(n.id)) return mergerMemo.get(n.id);
      if (mergerVisiting.has(n.id)) return 0;
      mergerVisiting.add(n.id);
      const sourceNode = n.type === "portal_out" ? portalInputByPair.get(n.pair_id) : n;
      const total = sourceNode ? portSupply(sourceNode.id, 0, port.item_id) : 0;
      mergerVisiting.delete(n.id);
      mergerMemo.set(n.id, total);
      return total;
    }
    return portRate(n, port, eff.get(n.id) || 0);
  };

  // 单条边的实际流量 = 源端口产量 × 该边权重 / 该端口出边权重之和（同口径分摊）。
  edgeFlow = (e) => {
    if (mixedFlows) return mixedFlows.rates.get(e.id) || 0;
    const fn = nodeById.get(e.from);
    if (!fn) return 0;
    const total = outProd(fn, e.fromPort);
    if (total <= 0) return 0;
    const sumW = outWeightSum.get(`${e.from}#${e.fromPort}`) || 0;
    if (sumW <= 0) return 0;
    return total * edgeWeight(e) / sumW;
  };

  // 计算某输入端口的总供给；expectedItem 非空时只统计物品匹配的入边。
  portSupply = (nodeId, portIdx, expectedItem = null) => {
    const key = `${nodeId}#${portIdx}#${expectedItem || ""}`;
    if (portSupplyMemo.has(key)) return portSupplyMemo.get(key);
    const list = incomingByPort.get(`${nodeId}#${portIdx}`) || [];
    let supply = 0;
    for (const e of list) {
      const fn = nodeById.get(e.from);
      if (!fn) continue;
      const item = fn.outputPorts[e.fromPort] ? fn.outputPorts[e.fromPort].item_id : null;
      if (expectedItem && item !== expectedItem) continue;
      supply += edgeFlow(e);
    }
    portSupplyMemo.set(key, supply);
    return supply;
  };

  // 有限迭代：自动降速与流量联动；混合模式允许余量释放后恢复速度。
  let speedConverged = false;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    mergerMemo.clear();
    mergerVisiting.clear();
    portSupplyMemo.clear();
    let changed = false;
    for (const n of nodes) {
      if (!n.auto_slow) continue;
      if (n.type !== "machine" && n.type !== "blackbox") continue;
      const base = parseSpeed(n.speed, 1);
      let throttle = base;
      let has = false;
      n.inputPorts.forEach((p, i) => {
        if (p.fixed) return; // 恒定消耗端口不参与降速节流（类似耗电，不代表配方吞吐）
        if (p.baseRate > 0) {
          const ratio = portSupply(n.id, i, p.item_id) / p.baseRate;
          throttle = has ? Math.min(throttle, ratio) : Math.min(base, ratio);
          has = true;
        }
      });
      const next = has ? Math.min(base, throttle) : base;
      if (Math.abs(next - (eff.get(n.id) || 0)) > EPS) {
        eff.set(n.id, next);
        refreshMixedFlows();
        mergerMemo.clear();
        portSupplyMemo.clear();
        changed = true;
      }
    }
    if (!changed) { speedConverged = true; break; }
  }

  // 汇总结构
  const nodeResults = new Map();
  const edgeResults = new Map();
  const produced = new Map();
  const consumed = new Map();
  const finalOutput = new Map();
  let warnCount = 0;

  const bump = (map, item, val) => map.set(item, (map.get(item) || 0) + val);
  const isShort = (supply, required) => required > EPS && required - supply > WARN_TOLERANCE + EPS;

  mergerMemo.clear();
  mergerVisiting.clear();
  portSupplyMemo.clear();
  for (const n of nodes) {
    const speed = eff.get(n.id) || 0;
    const res = { effectiveSpeed: speed, inputs: [], outputs: [], inflow: [], warn: false };

    // 输入端口
    n.inputPorts.forEach((p, i) => {
      if (n.type === "sink") {
        // 最终产物箱：照单全收，仅统计流入，不产生需求不足警告
        const list = incomingByPort.get(`${n.id}#${i}`) || [];
        for (const e of list) {
          const fn = nodeById.get(e.from);
          if (!fn) continue;
          const item = fn.outputPorts[e.fromPort] ? fn.outputPorts[e.fromPort].item_id : null;
          const rate = edgeFlow(e);
          if (item) {
            bump(finalOutput, item, rate);
            const exist = res.inflow.find((x) => x.item_id === item);
            if (exist) exist.rate += rate;
            else res.inflow.push({ item_id: item, rate });
          }
        }
        return;
      }
      const supply = portSupply(n.id, i, p.item_id);
      if (n.type === "merger" || n.type === "portal_in") {
        res.throughput = supply;
        res.inputs.push({ item_id: p.item_id, required: supply, supply, warn: false });
        return;
      }
      const required = portRate(n, p, speed);
      const warn = isShort(supply, required);
      if (warn) { res.warn = true; warnCount++; }
      res.inputs.push({ item_id: p.item_id, required, supply, warn });
      if (required > 0) bump(consumed, p.item_id, required);
    });

    // 输出端口
    n.outputPorts.forEach((p, i) => {
      const production = outProd(n, i);
      // 下游请求之和（产物箱不计入需求）；同时记录是否有产物箱兜底、下游是否真的欠供。
      const outs = outgoingByPort.get(`${n.id}#${i}`) || [];
      let demand = 0;
      let hasSink = false;
      let downstreamShort = false;
      for (const e of outs) {
        const tn = nodeById.get(e.to);
        if (!tn) continue;
        if (tn.type === "sink") {
          if (edgeFlow(e) > WARN_TOLERANCE + EPS) hasSink = true;
          continue;
        }
        if (tn.type === "merger" || tn.type === "portal_in") {
          demand += edgeFlow(e);
          continue;
        }
        const tp = tn.inputPorts[e.toPort];
        if (!tp) continue;
        const req = portRate(tn, tp, eff.get(tn.id) || 0);
        demand += req;
        // 关键：按下游输入口的「全部来源合计供给」判断是否欠供，
        // 避免同一输入口有多个供货方（如回收流 + 新鲜流合流）时，把每个上游都误报为产出不足。
        if (req > EPS) {
          const sup = portSupply(tn.id, e.toPort, tp.item_id);
          if (isShort(sup, req)) downstreamShort = true;
        }
      }
      // 供不应求：本产物所供的某个下游输入口，合计供给仍不足其需求
      const shortage = downstreamShort;
      // 产物未被处理：有产出，但没有产物箱兜底、也没有任何下游消耗（完全没去处）
      const allocated = outs.reduce((sum, edge) => sum + edgeFlow(edge), 0);
      const unallocated = Math.max(0, production - allocated);
      const unhandled = (hasFlowModes && unallocated > WARN_TOLERANCE + EPS) ||
        (production > WARN_TOLERANCE + EPS && !hasSink && demand <= WARN_TOLERANCE + EPS);
      const warn = shortage || unhandled;
      if (warn) { res.warn = true; warnCount++; }
      res.outputs.push({
        item_id: p.item_id, production, demand, warn, unallocated,
        reason: shortage ? "shortage" : (unhandled ? "unhandled" : null),
      });
      if (production > 0 && n.type !== "merger" && n.type !== "portal_out") bump(produced, p.item_id, production);
    });

    nodeResults.set(n.id, res);
  }

  // 边着色与警告
  for (const e of edges) {
    const fn = nodeById.get(e.from);
    const item = fn && fn.outputPorts[e.fromPort] ? fn.outputPorts[e.fromPort].item_id : null;
    const state = item ? recipes.itemState(item) : "solid";
    // 目标输入端口若供给不足，则该边标警告
    let warn = false;
    const tn = nodeById.get(e.to);
    if (tn && tn.type !== "sink") {
      const tr = nodeResults.get(e.to);
      const ip = tr && tr.inputs[e.toPort];
      if (ip && ip.warn) warn = true;
    }
    // 使用与供给统计一致的分配结果。
    const rate = edgeFlow(e);
    const shortfall = e.mode === "fixed" ? Math.max(0, e.fixedRate - rate) : 0;
    if (shortfall > WARN_TOLERANCE + EPS || (mixedFlows && (!mixedFlows.converged || !speedConverged))) {
      warn = true;
      warnCount++;
    }
    edgeResults.set(e.id, { item_id: item, state, warn, rate, ...normalizeFlowRule(e), shortfall });
  }

  // 产消表
  const itemSet = new Set([...produced.keys(), ...consumed.keys(), ...finalOutput.keys()]);
  const balanceItems = [...itemSet].map((item) => {
    const p = produced.get(item) || 0;
    const c = consumed.get(item) || 0;
    const f = finalOutput.get(item) || 0;
    return { item_id: item, produced: p, consumed: c, finalOutput: f, net: p - c - f };
  }).sort((a, b) => a.net - b.net);

  const finalOutputs = [...finalOutput.entries()]
    .filter(([, v]) => v > EPS)
    .map(([item_id, rate]) => ({ item_id, rate }))
    .sort((a, b) => b.rate - a.rate);

  return { nodes: nodeResults, edges: edgeResults, balance: { items: balanceItems, finalOutputs }, warnCount,
    flowConverged: mixedFlows ? mixedFlows.converged && speedConverged : true };
}
