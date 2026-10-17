---
name: factory-plan-json
description: 为本项目节点式工厂配平编辑器生成、修改或检查可导入的生产流程 JSON。用于用户要求产线规划、生成方案文件、指定产量配平、转换生产流程或检查配方引用与节点连线时。
---

# 可导入的生产流程方案

## 目标与适用范围

交付 UTF-8 `.json` 文件，用户通过编辑器“文件 → 导入方案 JSON”导入，随后在方案列表打开。适用于本地服务与 GitHub Pages 两种模式。普通方案不是完整备份、Drawflow 内部状态、扫描模型或 zmd_dyn 导出。

仓库根目录是本文件向上四级。相对路径均以仓库根目录为基准。优先阅读实现：

- `web/js/topology.js`：`toPlan` 与 `fromPlan`。
- `web/js/recipes.js`：配方规范化、`makeRef` 与 `resolveRef`。
- `web/js/graph/serializer.js`：节点复原、端口及组件内部格式。
- `web/js/flowRules.js`：流量分配规则。
- `web/js/examples.js`：四个已验证的生成范例。

不要依赖仓库外工具或本地未发布文档。实现与说明冲突时以实现为准，并说明差异。

## 工作流程

1. 明确最终产品、目标产量（单位/分）、允许的原料来源、机器上限和分流策略。缺少产量时可选单机基准并明确假设；不要把未确认的供给当成无限。
2. 从 `data/recipes/recipes_industrial.json` 和 `special_recipes.json` 查找真实配方。按设施、输入、输出一起筛选；中文名称或产物 ID 单独不足以唯一定位。
3. 优先在已初始化的应用中使用 `recipes.getAll()` 选择规范化配方，再调用 `recipes.makeRef(recipe)`。原始数据经过规范化可能增加固定消耗端口或高效变体，不能机械复制原始数据后猜测运行时端口。
4. 先按实际配方速率算清每条支路，创建节点，再按物品查找输入输出索引生成连线。检查所有副产物、缺料和回流。
5. 序列化为下述普通方案格式；可以用 `toPlan(meta, nodes, runtimeEdges, boards)` 自动转换连线字段。不要直接把运行时边数组保存成文件。
6. 按“验证与交付”执行。没有浏览器验证条件时如实说明只做了静态检查。

## 顶层格式

```json
{
  "version": 1,
  "app": "zmd_recipe",
  "meta": {"name": "示例-铁制零件基础产线", "icon_item_id": "item_iron_cmpt"},
  "nodes": [],
  "edges": [],
  "boards": []
}
```

- 名称要描述产品或工艺；**示例方案名称必须以 `示例-` 开头**。所有交付方案设置 `meta.icon_item_id`，使用 `data/item_icons/` 中确实存在的文件名（不带 `.webp`）。
- 普通文件导入时会删除原有方案 ID 并创建独立副本；新文件可省略 `meta.id` 和时间戳。不要伪造用户 ID 或写入私有路径。
- `nodes`、`edges` 必须为数组，空底板使用 `boards: []`。不要把说明文字写在 JSON 外或加入 JSON 注释。
- `symbols`、边的 `length/speed/state` 是序列化兼容信息，最小方案可以省略。正常保存会由 `toPlan` 重建。

## 节点

所有节点：`id` 使用文件内唯一字符串；`type` 合法；`x/y` 使用有限数值。建议从左到右布局，列间距 310–360，分支垂直间距至少 320；多端口卡片需更大间距。

| 类型 | 必需业务字段与注意事项 |
| --- | --- |
| `source` | `source_outputs: [{item_id, rate: "30"}]`；速率单位/分。`ports.inputs: []`，`ports.outputs` 与输出表顺序一致。若写旧字段 `source_item/source_rate`，应与第一路输出一致。 |
| `machine` | `recipe_ref`、`speed: "1"`、`auto_slow`；`ports.inputs/outputs` 与规范化配方顺序完全一致。`speed` 可用 `"2"`、`"0.5"`、`"1/3"` 等非负字符串；整数倍表示聚合机器规模。 |
| `sink` | `box_kind: "final"`、`ports: {inputs: [null], outputs: []}`。普通产物箱只有一个通配输入，连线目标索引为 0。不要给普通箱生成 `sink_inputs`。 |

自定义节点名写 `label` 并设 `custom_label: true`，否则机器标题加载时可能按配方重建。`auto_slow: true` 表示允许缺料时自动降速，不能用它证明目标产量必然达成。

主配方和特殊配方均使用：

```json
{
  "page_item_id": "从实际配方复制",
  "recipe_name": "从实际配方复制",
  "facility_id": "从实际配方复制",
  "recipe_signature": "输入ID:每分钟速率,输入ID:每分钟速率=>输出ID:每分钟速率"
}
```

签名保持原端口顺序，数字按 JavaScript `Number` 字符串表示（30，不是 30.0）。不要猜配方引用：无法解析的机器会被跳过，相关连线也会丢失。当前解析器允许唯一三元组兼容旧签名，但新方案必须生成准确签名。

`page_item_id` 是数据来源页面 ID，**不一定是输出物品 ID**。例如“铁制零件生产”的页面 ID 是 `item_iron_nugget`，产物才是 `item_iron_cmpt`；必须从配方读取。

临时配方使用 `{temp_id, recipe_name}`，但**单个方案 JSON 不会携带临时配方库**。要跨浏览器独立导入，优先使用内置配方；确需临时配方时明确要求先安装相应临时配方，或交付应用导出的完整备份，不能冒充普通方案。

汇流器、传送门和黑盒仅在需求明确时使用。先阅读 `serializer.js` 中相应分支并从应用导出合法模板；传送门需正确配对，黑盒需完整 `box.external_inputs/external_outputs/internal`。不要把内部边界节点 `__module_input__`、`__module_output__` 或 `boundary` 写入持久化方案。

## 连线：最容易出错的部分

普通方案文件使用 **snake_case、零基端口索引**：

```json
{"id":"e1","from":"src","to":"machine","from_port":0,"to_port":0,"mode":"weight","weight":1}
```

`from/to` 必须精确匹配字符串节点 ID。输出物品必须等于目标输入物品（普通产物箱允许通配）。端口索引来自规范化配方顺序，不能按显示行排序或物品名排序重新编号。

| 规则 | 字段 | 含义 |
| --- | --- | --- |
| 权重 | `mode: "weight", weight: 1` | 同一输出端口按权重分配；权重不是目标产量。 |
| 固定 | `mode: "fixed", fixedRate: 30` | 固定目标流量/分；缺供时可能无法满足。 |
| 优先级 | `mode: "priority", priority: 1, maxRate: 30` | 数字越小越优先；同级按需求比例分配。 |

`maxRate: null` 或省略表示无显式上限，`maxRate: 0` 表示封闭。速率和权重使用非负有限数值；`priority` 为大于等于 1 的整数。不同模式的具体混合规则以 `flowRules.js` 为准。

**运行时边和黑盒 `internal.edges` 使用 `fromPort/toPort`，顶层文件边使用 `from_port/to_port`。** `fromPlan` 不读取顶层驼峰字段；误写时端口可能全部落到 0。不要在输出文件中混用这两套格式。

## 验证与交付

1. JSON 解析成功；顶层、名称前缀（示例）、图标文件、唯一节点 ID、有限坐标、非负速率正确。
2. 每台机器能通过 `recipes.resolveRef` 解析，且 `makeRef` 返回的签名与生成引用一致。
3. 检查边端点、端口范围、物品匹配和重复连接；所有最终产品都有明确出口。
4. 在独立浏览器上下文或临时本地服务中，用 `fromPlan` 解析后调用 `graph.loadFromNodesEdges`。加载前后节点数、连线数应相等，防止静默丢节点。不要覆盖用户当前画布或已有方案。
5. 检查 `graph.getLastResult().balance.finalOutputs`，逐项对比目标产量。检查中间物料净额、缺料与警告；若故意演示缺料，在交付说明中写明。含循环的稳态结果不等于启动可行性或动态稳定性证明。
6. 用真实“文件 → 导入方案 JSON”路径验证文件可进入方案库、打开和保存；没有执行的检查不得声称通过。
7. 交付 `.json` 文件路径、方案名、原料输入和预期最终产出，以及验证范围。不要仅贴伪代码或说“已经生成”。不要未经要求提交、推送或部署。

可直接导入的基准文件见 [assets/example-iron-parts.json](assets/example-iron-parts.json)。新增复杂方案应从当前配方库构造，不应只替换样例的中文名称。
