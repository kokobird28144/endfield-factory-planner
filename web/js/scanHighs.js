import loadHighs from '../vendor/highs/build/highs.mjs';

const highs = await loadHighs({ locateFile: file => new URL(`../vendor/highs/build/${file}`, import.meta.url).href });

export function solveConstraints(rows, variables, binaries, timeout) {
  const names = Object.keys(variables);
  if (!names.length) return { status: rows.every(({ row, type }) => type === 'equal' ? row.value === 0 : type === 'max' ? row.value <= 0 : row.value >= 0) ? 'Optimal' : 'Infeasible', values: {} };
  const columns = new Map(names.map((name, i) => [name, i])), integer = new Set(binaries);
  const starts = [0], indices = [], values = [];
  for (const { row } of rows) {
    for (const [name, value] of row.terms) { indices.push(columns.get(name)); values.push(value); }
    starts.push(indices.length);
  }
  const model = highs.createModel({
    numCols: names.length, numRows: rows.length,
    colCost: names.map(() => 0), colLower: names.map(() => 0),
    colUpper: names.map(name => integer.has(name) ? 1 : highs.infinity),
    integrality: names.map(name => integer.has(name) ? 1 : 0),
    rowLower: rows.map(({ row, type }) => type === 'max' ? -highs.infinity : -row.value),
    rowUpper: rows.map(({ row, type }) => type === 'min' ? highs.infinity : -row.value),
    matrix: { format: 'csr', numCols: names.length, numRows: rows.length, starts, indices, values },
  });
  try {
    model.options.set({ time_limit: timeout / 1000, mip_rel_gap: 0, output_flag: false,
      primal_feasibility_tolerance: 1e-9, mip_feasibility_tolerance: 1e-9, random_seed: 0 });
    model.run();
    const code = model.getModelStatus();
    const status = code === highs.constants.modelStatus.optimal ? 'Optimal'
      : code === highs.constants.modelStatus.timeLimit ? 'Time limit reached'
      : Object.entries(highs.constants.modelStatus).find(([, value]) => value === code)?.[0] || 'Unknown';
    const solution = model.getSolution().colValue;
    return { status, values: Object.fromEntries(names.map((name, i) => [name, solution[i]])) };
  } finally { model.dispose(); }
}
