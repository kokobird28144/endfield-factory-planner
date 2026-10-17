// main.js —— 入口：加载配方数据，初始化画布与界面。
import { recipes } from "./recipes.js";
import { graph } from "./graph.js";
import { ui } from "./ui.js";

async function boot() {
  try {
    await recipes.init();
  } catch (err) {
    const empty = document.getElementById("canvasEmpty");
    if (empty) {
      empty.querySelector(".empty-title").textContent = "配方数据加载失败";
      empty.querySelector(".empty-desc").textContent =
        "请确认已通过 `python server.py` 启动本地后端，然后刷新页面。（" + err.message + "）";
    }
    return;
  }
  graph.init(document.getElementById("drawflow"));
  ui.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
