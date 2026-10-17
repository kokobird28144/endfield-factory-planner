# 节点式工厂配平编辑器

通过节点和连线搭建产线，查看物料需求、流量与供需配平结果。支持配方机器、固定原料源、产物箱、黑盒组件、方案保存、图片导出与原料扫描。

## 启动

安装 Python 3.9 或更高版本，在项目目录执行：

```sh
python server.py
```

浏览器打开 <http://127.0.0.1:8770/>。Windows 用户也可双击 `start.bat`。
更改端口可运行 `python server.py 9000`。按 Ctrl+C 停止服务。

运行应用无需安装第三方 Python 包或 Node.js。前端资源随仓库提供。
应用依赖本地 Python 后端，不能直接通过 GitHub Pages 完整运行。

## 使用与备份

从左侧选择配方添加机器节点，添加固定源和产物箱，拖动端口连线搭建产线。
右键机器输入端口可选择上游配方或固定源补齐生产链。

方案、组件与临时配方保存在运行时创建的 `data/runtime/`，不纳入版本控制。
升级前备份此目录，升级后复制到新目录即可保留个人数据。

## 文件结构

- `server.py`：本地服务与数据接口。
- `start.bat`：Windows 启动入口。
- `web/`：网页及所需第三方资源。
- `data/recipes/`：配方库。
- `data/item_icons/`：物品图标。

## 许可证

原创代码采用 [MIT License](LICENSE)。第三方库、游戏图标和外部配方数据的来源与许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
