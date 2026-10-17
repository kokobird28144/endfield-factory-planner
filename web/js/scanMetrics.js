export function scanMetrics(rows, model, itemName) {
  const products = [...new Set(rows.flatMap(r => Object.keys(r.finalOutput)))].sort()
    .map(item => ({ key: item, kind: 'product', item, label: itemName(item) }));
  const ports = model.nodes.flatMap(n => n.type === 'source'
    ? n.outputPorts.map((p, i) => ({ node: n, item: p.item_id, portIndex: i })) : []);
  const unused = ports.map(({ node, item, portIndex }) => {
    const origin = ports.filter(p => p.item === item).length > 1 ? `（${node.label || node.id} · ${node.id} [${portIndex + 1}]）` : '';
    let key = `unused:${JSON.stringify([node.id, portIndex])}`;
    while (products.some(p => p.key === key)) key = `unused:${key}`;
    return { key, kind: 'unused', sourceId: node.id, portIndex, label: `${itemName(item)}${origin} 拒收` };
  });
  return [...products, ...unused];
}

// Missing source data is a gap, never a valid zero. Products may be sparse.
export function metricValue(row, metric) {
  if (!row?.valid || !metric) return null;
  const value = typeof metric === 'string' ? row.finalOutput[metric] ?? 0
    : metric.kind === 'product' ? row.finalOutput[metric.item] ?? 0
    : row.sources?.[metric.sourceId]?.[metric.portIndex]?.unused;
  return Number.isFinite(value) ? Math.max(0, value) : null;
}
