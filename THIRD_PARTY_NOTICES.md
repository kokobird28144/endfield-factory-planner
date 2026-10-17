# 第三方代码与资源

根目录 MIT 许可证适用于本项目有权授权的原创代码。第三方代码按其自身许可提供；游戏图标及外部配方数据不因本项目的 MIT 许可证而获得重新授权。

## 随项目分发的库

| 库 | 用途 | 本地文件 | 许可 |
| --- | --- | --- | --- |
| [Drawflow](https://github.com/jerosoler/Drawflow) | 节点画布、端口连线 | `web/vendor/drawflow.min.js`、`drawflow.min.css` | MIT |
| [Preact](https://github.com/preactjs/preact) | 界面组件渲染 | `web/vendor/preact-standalone.module.js` | MIT |
| [html2canvas](https://github.com/niklasvh/html2canvas/tree/v1.4.1) 1.4.1 | 图片导出 | `web/vendor/html2canvas.min.js` | MIT |
| [highs-js](https://github.com/lovasoa/highs-js) / [HiGHS](https://github.com/ERGO-Code/HiGHS)，npm `highs@1.15.3` | 原料扫描的优化求解 | `web/vendor/highs/` | MIT |

当前 Drawflow、Preact 本地文件未保留可确认的版本号，故不推断其精确版本。HiGHS 的来源和校验值见 [VENDORED.md](web/vendor/highs/VENDORED.md)，完整许可见 [LICENSE](web/vendor/highs/LICENSE)。

## Drawflow、Preact 与 html2canvas 许可

以下版权声明分别属于对应库，适用其后的 MIT 条款：

- Drawflow: Copyright (c) 2020 Jero Soler
- Preact: Copyright (c) 2015-present Jason Miller
- html2canvas: Copyright (c) 2012 Niklas von Hertzen（v1.4.1 LICENSE）；分发文件头另保留 Copyright (c) 2022 Niklas von Hertzen。

许可来源：[Drawflow](https://github.com/jerosoler/Drawflow/blob/master/LICENSE)、[Preact](https://github.com/preactjs/preact/blob/main/LICENSE)、[html2canvas 1.4.1](https://github.com/niklasvh/html2canvas/blob/v1.4.1/LICENSE)。

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

html2canvas 分发文件内另含 Microsoft Corporation 的辅助代码许可声明，保留于原文件头部。

## 图标与配方数据

本项目使用的物品图标和基础配方数据来源于 [warfarin.wiki（华法琳 Wiki）](https://warfarin.wiki/)。

- `data/item_icons/`：游戏物品图标，抓取来源为华法琳 Wiki 及其静态资源站点（<https://warfarin.wiki/>、<https://static.warfarin.wiki/>）。图像权利归相应权利人所有。
- `data/recipes/`：包含从 [华法琳 Wiki 设备目录](https://warfarin.wiki/cn/facilities) 整理的配方数据及项目维护的特殊配方。

上述来源说明不构成第三方资源的授权声明。本项目未确认这些资源具有 MIT 许可；其使用和再分发须依据相应权利人的授权或适用条款。
