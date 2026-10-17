export function blueDrugExample(store) {
  const port = (item_id, baseRate) => ({ item_id, baseRate });
  const machine = (id, label, facility, input, output) => {
    const recipe = store.getAll().find(r => r.facility_id === facility &&
      r.inputs.some(p => p.item_id === input) && r.outputs.some(p => p.item_id === output));
    if (!recipe) throw new Error(`示例缺少配方：${label}`);
    return { id, label, type: 'machine', speed: 1, maxSpeed: 1,
      inputPorts: recipe.inputs.map(p => port(p.item_id, p.rate_per_min)),
      outputPorts: recipe.outputs.map(p => port(p.item_id, p.rate_per_min)) };
  };
  const nodes = [
    { id: 'iron', label: '蓝铁矿供给', type: 'source', inputPorts: [], outputPorts: [port('item_iron_ore', 120)] },
    { id: 'plant', label: '芽针溶液供给', type: 'source', inputPorts: [], outputPorts: [port('item_liquid_plant_grass_2', 300)], abundant: [0] },
    machine('upper', '上路精炼炉', 'furnance_1', 'item_iron_ore', 'item_iron_nugget'),
    machine('lower', '下路精炼炉', 'furnance_1', 'item_iron_ore', 'item_iron_nugget'),
    machine('shape', '塑形机', 'shaper_1', 'item_iron_nugget', 'item_iron_bottle'),
    machine('parts', '配件机', 'component_mc_1', 'item_iron_nugget', 'item_iron_cmpt'),
    machine('fill', '灌装机', 'filling_powder_mc_1', 'item_iron_bottle', 'item_fbottle_iron_grass_2'),
    machine('pack', '封装机', 'tools_assebling_mc_1', 'item_fbottle_iron_grass_2', 'item_bottled_rec_hp_4'),
    { id: 'out', label: '蓝药成品', type: 'sink', inputPorts: [port(null, 0)], outputPorts: [] },
  ];
  const edges = [];
  const connect = (from, to, item, settings = {}) => {
    const a = nodes.find(n => n.id === from), b = nodes.find(n => n.id === to);
    edges.push({ id: `${from}-${to}`, from, to,
      fromPort: a.outputPorts.findIndex(p => p.item_id === item),
      toPort: b.type === 'sink' ? 0 : b.inputPorts.findIndex(p => p.item_id === item),
      mode: 'weight', weight: 1, receivePriority: 1, ...settings });
  };
  connect('iron', 'upper', 'item_iron_ore');
  connect('iron', 'lower', 'item_iron_ore', { weight: 2 });
  connect('upper', 'shape', 'item_iron_nugget');
  connect('lower', 'shape', 'item_iron_nugget', { receivePriority: 2 });
  connect('lower', 'parts', 'item_iron_nugget');
  connect('shape', 'fill', 'item_iron_bottle');
  connect('plant', 'fill', 'item_liquid_plant_grass_2');
  connect('fill', 'pack', 'item_fbottle_iron_grass_2');
  connect('parts', 'pack', 'item_iron_cmpt');
  connect('pack', 'out', 'item_bottled_rec_hp_4');
  return { nodes, edges };
}
