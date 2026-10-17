import { recipes } from "./recipes.js";
import { parseSpeed } from "./engine.js";

export function cloneValue(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function mergePorts(ports) {
  const merged = new Map();
  for (const port of ports || []) {
    if (!port || !port.item_id) continue;
    merged.set(port.item_id, (merged.get(port.item_id) || 0) + (Number(port.rate) || 0));
  }
  return [...merged].map(([item_id, rate]) => ({ item_id, rate }));
}

function portRate(node, side, index) {
  const speed = parseSpeed(node.speed, 1);
  if (node.type === "machine") {
    const recipe = recipes.resolveRef(node.recipe_ref);
    const port = recipe && recipe[side] && recipe[side][index];
    if (!port) return 1;
    return (Number(port.rate_per_min) || 0) * (port.fixed ? Math.ceil(speed) : speed);
  }
  if (node.type === "blackbox") {
    const key = side === "inputs" ? "external_inputs" : "external_outputs";
    const port = node.box && node.box[key] && node.box[key][index];
    return (Number(port && port.rate) || 0) * speed;
  }
  return 1;
}

export function withBoundaryNodes(context, internal) {
  const nodes = cloneValue((internal && internal.nodes) || []);
  const edges = cloneValue((internal && internal.edges) || []);
  const boards = cloneValue((internal && internal.boards) || []);
  const box = context.originalBox || {};
  const inputs = mergePorts(box.external_inputs || []);
  const outputs = mergePorts(box.external_outputs || []);
  const xs = nodes.map((node) => Number(node.x) || 0);
  const ys = nodes.map((node) => Number(node.y) || 0);
  const minX = xs.length ? Math.min(...xs) : 60;
  const maxX = xs.length ? Math.max(...xs) : 360;
  const midY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 120;
  const inputId = "__module_input__";
  const outputId = "__module_output__";
  nodes.push({
    id: inputId, type: "source", boundary: "input", label: "模块输入",
    x: minX - 300, y: midY, speed: "1", auto_slow: false,
    source_item: inputs[0] ? inputs[0].item_id : "",
    source_rate: inputs[0] ? String(inputs[0].rate) : "0",
    source_outputs: inputs.map((port) => ({ item_id: port.item_id, rate: String(port.rate) })),
    ports: { inputs: [], outputs: inputs.map((port) => port.item_id) },
  });
  nodes.push({
    id: outputId, type: "sink", boundary: "output", label: "模块输出",
    x: maxX + 340, y: midY, speed: "1", auto_slow: false,
    sink_inputs: outputs.map((port) => ({ item_id: port.item_id, rate: Number(port.rate) || 0 })),
    ports: { inputs: outputs.map((port) => port.item_id), outputs: [] },
  });

  const connectedInputs = new Set(edges.map((edge) => `${edge.to}#${edge.toPort}`));
  const connectedOutputs = new Set(edges.map((edge) => `${edge.from}#${edge.fromPort}`));
  const addEdge = (from, fromPort, to, toPort, weight) => edges.push({
    id: `${from}.output_${fromPort + 1}->${to}.input_${toPort + 1}`,
    from, fromPort, to, toPort, weight: Math.max(Number(weight) || 1, 0.000001), boundary: true,
  });
  inputs.forEach((port, boundaryPort) => {
    nodes.forEach((node) => {
      if (node.boundary) return;
      const nodeInputs = node.ports && node.ports.inputs || [];
      nodeInputs.forEach((item, index) => {
        if (item === port.item_id && !connectedInputs.has(`${node.id}#${index}`)) {
          addEdge(inputId, boundaryPort, node.id, index, portRate(node, "inputs", index));
        }
      });
    });
  });
  outputs.forEach((port, boundaryPort) => {
    nodes.forEach((node) => {
      if (node.boundary) return;
      const nodeOutputs = node.ports && node.ports.outputs || [];
      nodeOutputs.forEach((item, index) => {
        if (item === port.item_id && !connectedOutputs.has(`${node.id}#${index}`)) {
          addEdge(node.id, index, outputId, boundaryPort, portRate(node, "outputs", index));
        }
      });
    });
  });
  return { nodes, edges, boards };
}

export function applyBoxToParentFrame(frame, box) {
  if (!frame || !frame.targetNodeId) return 0;
  const node = frame.snapshot.nodes.find((item) => String(item.id) === frame.targetNodeId);
  if (!node) throw new Error("返回父画布时找不到原模块节点");
  const oldInputs = (node.box && node.box.external_inputs || []).map((port) => port.item_id);
  const oldOutputs = (node.box && node.box.external_outputs || []).map((port) => port.item_id);
  const newInputs = (box.external_inputs || []).map((port) => port.item_id);
  const newOutputs = (box.external_outputs || []).map((port) => port.item_id);
  let disconnected = 0;
  frame.snapshot.edges = frame.snapshot.edges.filter((edge) => {
    if (String(edge.to) === frame.targetNodeId) {
      const next = newInputs.indexOf(oldInputs[edge.toPort]);
      if (next < 0) { disconnected += 1; return false; }
      edge.toPort = next;
    }
    if (String(edge.from) === frame.targetNodeId) {
      const next = newOutputs.indexOf(oldOutputs[edge.fromPort]);
      if (next < 0) { disconnected += 1; return false; }
      edge.fromPort = next;
    }
    return true;
  });
  node.box = cloneValue(box);
  node.label = box.name;
  node.ports = { inputs: newInputs, outputs: newOutputs };
  return disconnected;
}
