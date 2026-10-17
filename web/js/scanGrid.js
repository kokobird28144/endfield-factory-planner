export function scanValues(min, max, step) {
  if (![min, max, step].every(Number.isFinite) || min < 0 || max < min || step <= 0)
    throw new Error("范围须满足 0 ≤ 起点 ≤ 终点，步长必须大于 0。");
  const count = Math.floor((max - min) / step + 1e-10) + 1;
  if (count > 301) throw new Error("最多扫描 301 个点，请增大步长。");
  const values = Array.from({ length: count }, (_, i) => Math.min(max, min + i * step));
  if (max - values.at(-1) > 1e-8) values.push(max);
  if (values.length > 301) throw new Error("最多扫描 301 个点，请增大步长。");
  return values;
}

export const MAX_GRID_POINTS = 2500;

export function prepareScanAxes(model, axes) {
  if (!Array.isArray(axes) || axes.length < 1 || axes.length > 2) throw new Error('请选择一个或两个扫描输入。');
  const seen = new Set();
  const result = axes.map(axis => {
    const n = model.nodes.find(n => n.id === axis.sourceId && n.type === 'source');
    if (!Number.isInteger(axis.portIndex) || axis.portIndex < 0 || !n?.outputPorts[axis.portIndex])
      throw new Error('请选择有效的原料输出口。');
    const key = JSON.stringify([axis.sourceId, axis.portIndex]);
    if (seen.has(key)) throw new Error('两个扫描输入不能选择同一个输出口。');
    seen.add(key);
    return { ...axis, values: scanValues(axis.min, axis.max, axis.step) };
  });
  const count = result.reduce((total, axis) => total * axis.values.length, 1);
  if (count > MAX_GRID_POINTS) throw new Error(`双原料扫描最多 ${MAX_GRID_POINTS} 个组合，请增大步长。`);
  return result;
}

export function gridRowIndex(xIndex, yIndex, width) { return yIndex * width + xIndex; }

export function gridSlice(rows, axes, xIndex, yIndex, varyingAxis = 0) {
  if (axes.length === 1) return rows;
  const width = axes[0].values.length;
  return varyingAxis === 0
    ? rows.slice(yIndex * width, (yIndex + 1) * width)
    : axes[1].values.map((_, y) => rows[gridRowIndex(xIndex, y, width)]);
}

export function nearestIndex(values, value) {
  let index = 0;
  values.forEach((v, i) => { if (Math.abs(v - value) < Math.abs(values[index] - value)) index = i; });
  return index;
}
