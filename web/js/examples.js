import { recipes } from "./recipes.js";
import { toPlan } from "./topology.js";

export const examplePlans = [
  {
    id: "iron-parts", name: "示例-铁制零件基础产线", icon: "item_iron_cmpt",
    description: "30/分蓝铁矿 → 精炼炉 → 配件机 → 30/分铁制零件。适合了解节点、端口和供需配平。",
  },
  {
    id: "weighted-split", name: "示例-蓝铁权重分流", icon: "item_iron_bottle",
    description: "90/分蓝铁矿经精炼后按 1:2 分流，分别生产 30/分铁制零件和 30/分蓝铁瓶。右键连线可调整权重。",
  },
  {
    id: "priority-split", name: "示例-缺料优先级分配", icon: "item_iron_nugget",
    description: "60/分蓝铁矿先满足铁制零件支路，剩余蓝铁块供给塑形机，产出 30/分铁制零件和 15/分蓝铁瓶。塑形机自动降速；可增加供给或交换优先级观察变化。",
  },
  {
    id: "blue-drug", name: "示例-双原料芽针针剂", icon: "item_bottled_rec_hp_4",
    description: "120/分蓝铁矿与 30/分芽针溶液，经过精炼、分流、塑形、灌装和封装，生产 6/分芽针针剂。打开原料扫描可查看两种供给对产出的影响。",
  },
];

// Build from the active built-in recipe library so exact recipe signatures and
// port indices remain consistent with the planner's own serialization format.
export function createExamplePlan(id) {
  const example = examplePlans.find(item => item.id === id);
  if (!example) throw new Error("未找到示例方案");
  const nodes = [], edges = [];
  const source = (id, label, item, rate, x, y) => {
    nodes.push({ id, type: "source", label, custom_label: true, x, y,
      source_outputs: [{ item_id: item, rate: String(rate) }],
      ports: { inputs: [], outputs: [item] } });
  };
  const machine = (id, facility, input, output, speed, x, y) => {
    const matches = recipes.getAll().filter(recipe => !recipe.temporary && !recipe.special &&
      recipe.facility_id === facility && recipe.inputs.some(port => port.item_id === input) &&
      recipe.outputs.some(port => port.item_id === output));
    if (matches.length !== 1) throw new Error(`示例配方缺失或不唯一：${facility} / ${output}`);
    const recipe = matches[0];
    nodes.push({ id, type: "machine", label: recipe.recipe_name, x, y,
      speed: String(speed), auto_slow: true, recipe_ref: recipes.makeRef(recipe),
      ports: { inputs: recipe.inputs.map(port => port.item_id), outputs: recipe.outputs.map(port => port.item_id) } });
  };
  const sink = (id, label, item, x, y) => {
    nodes.push({ id, type: "sink", label, custom_label: true, x, y,
      box_kind: "final", ports: { inputs: [item], outputs: [] } });
  };
  const connect = (from, to, item, settings = {}) => {
    const a = nodes.find(node => node.id === from), b = nodes.find(node => node.id === to);
    const fromPort = a.ports.outputs.indexOf(item), toPort = b.ports.inputs.indexOf(item);
    if (fromPort < 0 || toPort < 0) throw new Error("示例物料端口不匹配");
    edges.push({ from, to, fromPort, toPort, mode: "weight", weight: 1, ...settings });
  };
  const ore = "item_iron_ore", iron = "item_iron_nugget", parts = "item_iron_cmpt", bottle = "item_iron_bottle";

  if (id === "iron-parts") {
    source("ore", "蓝铁矿 · 30/分", ore, 30, 40, 160);
    machine("refine", "furnance_1", ore, iron, 1, 350, 160);
    machine("parts", "component_mc_1", iron, parts, 1, 660, 160);
    sink("out", "铁制零件 · 30/分", parts, 970, 160);
    connect("ore", "refine", ore);
    connect("refine", "parts", iron);
    connect("parts", "out", parts);
  } else if (id === "weighted-split" || id === "priority-split") {
    const priority = id === "priority-split";
    const supply = priority ? 60 : 90;
    source("ore", `蓝铁矿 · ${supply}/分`, ore, supply, 40, 280);
    machine("refine", "furnance_1", ore, iron, 3, 350, 280);
    machine("parts", "component_mc_1", iron, parts, 1, 690, 80);
    machine("bottle", "shaper_1", iron, bottle, 1, 690, 460);
    sink("parts-out", "铁制零件 · 30/分", parts, 1030, 80);
    sink("bottle-out", `蓝铁瓶 · ${priority ? 15 : 30}/分`, bottle, 1030, 460);
    connect("ore", "refine", ore);
    connect("refine", "parts", iron, priority ? { mode: "priority", priority: 1, maxRate: 30 } : { weight: 1 });
    connect("refine", "bottle", iron, priority ? { mode: "priority", priority: 2, maxRate: 60 } : { weight: 2 });
    connect("parts", "parts-out", parts);
    connect("bottle", "bottle-out", bottle);
  } else {
    const solution = "item_liquid_plant_grass_2", filled = "item_fbottle_iron_grass_2", drug = "item_bottled_rec_hp_4";
    source("ore", "蓝铁矿 · 120/分", ore, 120, 40, 80);
    source("solution", "芽针溶液 · 30/分", solution, 30, 660, 820);
    machine("refine", "furnance_1", ore, iron, 4, 350, 80);
    machine("parts", "component_mc_1", iron, parts, 2, 660, 80);
    machine("bottle", "shaper_1", iron, bottle, 1, 660, 440);
    machine("fill", "filling_powder_mc_1", bottle, filled, 1, 970, 440);
    machine("pack", "tools_assebling_mc_1", parts, drug, 1, 1280, 80);
    sink("out", "芽针针剂 · 6/分", drug, 1590, 80);
    connect("ore", "refine", ore);
    connect("refine", "parts", iron);
    connect("refine", "bottle", iron);
    connect("bottle", "fill", bottle);
    connect("solution", "fill", solution);
    connect("parts", "pack", parts);
    connect("fill", "pack", filled);
    connect("pack", "out", drug);
  }
  return toPlan({ name: example.name, icon_item_id: example.icon }, nodes, edges);
}
