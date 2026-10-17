import { solveScan, validateScanModel } from './scanEngine.js';
import { parseSpeed } from './engine.js';
import { prepareScanAxes } from './scanGrid.js';

export function modelAtSupply(model, sourceId, portIndex, value) {
  return modelAtSupplies(model, [{ sourceId, portIndex, value }]);
}

export function modelAtSupplies(model, supplies) {
  const copy = structuredClone(model);
  // Enough for every installed machine to run at capacity, not an arbitrary infinity.
  const demand = new Map();
  for (const n of copy.nodes.filter(n => n.type === 'machine')) {
    for (const p of n.inputPorts) demand.set(p.item_id, (demand.get(p.item_id) || 0) + p.baseRate * parseSpeed(n.maxSpeed ?? n.speed, 1));
  }
  for (const n of copy.nodes.filter(n => n.type === 'source')) {
    for (const i of n.abundant || []) if (n.outputPorts[i]) n.outputPorts[i].baseRate = demand.get(n.outputPorts[i].item_id) || 0;
  }
  // Apply both scanned ports after abundant inputs, including two ports on one source.
  for (const { sourceId, portIndex, value } of supplies) {
    const source = copy.nodes.find(n => n.id === sourceId && n.type === 'source');
    if (!source?.outputPorts[portIndex]) throw new Error('请选择有效的原料输出口。');
    if (!Number.isFinite(value) || value < 0) throw new Error('供给必须是非负有限数。');
    source.outputPorts[portIndex].baseRate = value;
  }
  return copy;
}

export function runScanJob({ model, axes }, progress = () => {}) {
  validateScanModel(model);
  const prepared = prepareScanAxes(model, axes);
  const xs = prepared[0].values, ys = prepared[1]?.values || [null];
  const total = xs.length * ys.length, rows = [];
  ys.forEach((valueB, yIndex) => xs.forEach((value, xIndex) => {
    const supplies = prepared.map((axis, i) => ({ ...axis, value: i === 0 ? value : valueB }));
    const result = solveScan(modelAtSupplies(model, supplies));
    rows.push({ value, valueB, xIndex, yIndex, ...result });
    if (rows.length % 10 === 0 || rows.length === total) progress(rows.length, total);
  }));
  return { rows, axes: prepared };
}

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = ({ data }) => {
    try {
      const result = runScanJob(data, (completed, total) => self.postMessage({ type: 'progress', completed, total }));
      self.postMessage({ type: 'done', ...result });
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
  };
  // WASM initialization awaits before this handler exists; start jobs only now.
  self.postMessage({ type: 'ready' });
}
