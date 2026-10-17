import { recipes } from "../recipes.js";
import { compute, parseSpeed, fmt } from "../engine.js";
import { renderCard } from "../nodeCard.js";
import { esc, iconImg } from "../dom.js";
import { CANVAS_GRID_SIZE, HISTORY_LIMIT, NODE_MARKER_COLORS, BOARD_COLORS, BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT, NODE_MIN_WIDTH, NODE_MAX_WIDTH } from "./constants.js";

export const pngExportMethods = {
  async renderPng() {
    if (!this.editor || !this.editor.precanvas || !this.hasContent()) {
      throw new Error("当前画布没有可导出的内容");
    }
    if (typeof window.html2canvas !== "function") {
      throw new Error("PNG 渲染组件未加载，请刷新网页后重试");
    }

    const source = this.editor.precanvas;
    // 导出前强制按当前端口位置重建全部连线并转为正交折线，避免复制到旧的贝塞尔路径或拖动中的中间状态。
    for (const id of this.state.keys()) this._alignPorts(id);
    if (this.lastResult) this._refreshEdges(this.lastResult);
    const contentEls = [...source.querySelectorAll(".drawflow-node, .canvas-board")];
    if (!contentEls.length) throw new Error("当前画布没有可导出的内容");
    const padding = 90;
    const bounds = contentEls.reduce((acc, el) => {
      const left = Number.parseFloat(el.style.left) || 0;
      const top = Number.parseFloat(el.style.top) || 0;
      acc.minX = Math.min(acc.minX, left);
      acc.minY = Math.min(acc.minY, top);
      acc.maxX = Math.max(acc.maxX, left + el.offsetWidth);
      acc.maxY = Math.max(acc.maxY, top + el.offsetHeight);
      return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    // 反向折线可能绕到卡片或底板之外，导出范围必须把真实线路外接框也算进去，避免边缘线路被截断。
    source.querySelectorAll("svg.connection .main-path").forEach((path) => {
      try {
        const box = path.getBBox();
        bounds.minX = Math.min(bounds.minX, box.x);
        bounds.minY = Math.min(bounds.minY, box.y);
        bounds.maxX = Math.max(bounds.maxX, box.x + box.width);
        bounds.maxY = Math.max(bounds.maxY, box.y + box.height);
      } catch { /* 尚未完成布局的空路径忽略 */ }
    });
    const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX + padding * 2));
    const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY + padding * 2));
    // 控制最终位图尺寸：单边不超过 12000 像素，总像素不超过约 3600 万。
    // 不能强制设 0.5 下限，否则超大画布仍会突破浏览器 Canvas 限制并导致导出失败。
    const scale = Math.min(2, 12000 / width, 12000 / height, Math.sqrt(36_000_000 / (width * height)));
    if (!Number.isFinite(scale) || scale < 0.05) {
      throw new Error("画布范围过大，请将相距很远的节点或底板移近后再导出");
    }

    const stage = document.createElement("div");
    stage.className = "png-export-stage";
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    const clone = source.cloneNode(true);
    clone.classList.remove("node-dragging");
    clone.style.width = `${width}px`;
    clone.style.height = `${height}px`;
    clone.style.transformOrigin = "0 0";
    clone.style.transform = `translate(${padding - bounds.minX}px, ${padding - bounds.minY}px) scale(1)`;

    // 导出的是干净画面，不携带节点/底板/连线的选中态和端点重接控件。
    clone.querySelectorAll(".drawflow-node.selected, .drawflow-node.multi-sel, .canvas-board.selected").forEach((el) => {
      el.classList.remove("selected", "multi-sel");
    });
    clone.querySelectorAll(".main-path.selected").forEach((path) => path.classList.remove("selected"));
    clone.querySelectorAll("svg.connection.edge-retarget-selected").forEach((svg) => svg.classList.remove("edge-retarget-selected"));
    clone.querySelectorAll(".edge-retarget-handle, .edge-retarget-preview, .drawflow-delete").forEach((el) => el.remove());
    clone.querySelectorAll(".canvas-board-title").forEach((title) => title.setAttribute("contenteditable", "false"));

    // Drawflow 为每条线创建一个无尺寸 SVG，页面靠 overflow:visible 显示；直接放大每个 SVG 会破坏坐标系。
    // 导出时把所有路径汇总到同一个、覆盖完整逻辑画布的 SVG 中，保持折线原始坐标和层级。
    const svgLeft = bounds.minX - padding;
    const svgTop = bounds.minY - padding;
    const NS = "http://www.w3.org/2000/svg";
    const connectionLayer = document.createElementNS(NS, "svg");
    connectionLayer.classList.add("png-connection-layer");
    connectionLayer.style.position = "absolute";
    connectionLayer.style.left = `${svgLeft}px`;
    connectionLayer.style.top = `${svgTop}px`;
    connectionLayer.style.width = `${width}px`;
    connectionLayer.style.height = `${height}px`;
    connectionLayer.style.zIndex = "1";
    connectionLayer.style.overflow = "visible";
    connectionLayer.setAttribute("width", String(width));
    connectionLayer.setAttribute("height", String(height));
    // html2canvas 对带负数/非零原点的 SVG viewBox 支持不稳定。使用 0 原点，
    // 再由统一 group 平移逻辑画布坐标，避免线路整体错位、缩放或互相交叠。
    connectionLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    connectionLayer.setAttribute("preserveAspectRatio", "xMinYMin meet");
    const routesGroup = document.createElementNS(NS, "g");
    routesGroup.setAttribute("transform", `translate(${-svgLeft} ${-svgTop})`);
    const sourceConnections = [...source.querySelectorAll("svg.connection")];
    clone.querySelectorAll("svg.connection").forEach((svg, connectionIndex) => {
      const sourceSvg = sourceConnections[connectionIndex];
      const group = document.createElementNS(NS, "g");
      const flowClasses = [...svg.classList].filter((name) => name.startsWith("flow-"));
      group.setAttribute("class", ["png-connection-group", ...flowClasses].join(" "));
      [...svg.children].forEach((child) => {
        if (!child.matches(".main-path, .flow-label")) return;
        const copied = child.cloneNode(true);
        // 独立 SVG 图片无法读取页面 CSS 变量，因此把当前实际渲染样式固化到元素上。
        const sourceChild = sourceSvg && sourceSvg.querySelector(child.matches(".main-path") ? ".main-path" : ".flow-label");
        if (sourceChild) {
          const style = getComputedStyle(sourceChild);
          copied.setAttribute("style", [
            `fill:${style.fill}`,
            `stroke:${style.stroke}`,
            `stroke-width:${style.strokeWidth}`,
            `stroke-dasharray:${style.strokeDasharray}`,
            `stroke-linecap:${style.strokeLinecap}`,
            `stroke-linejoin:${style.strokeLinejoin}`,
            `font-family:${style.fontFamily}`,
            `font-size:${style.fontSize}`,
            `font-weight:${style.fontWeight}`,
            `paint-order:${style.paintOrder}`,
          ].join(";"));
        }
        group.appendChild(copied);
      });
      routesGroup.appendChild(group);
      svg.remove();
    });
    connectionLayer.appendChild(routesGroup);
    connectionLayer.setAttribute("xmlns", NS);
    // 根 SVG 作为图片内容时不能保留原先为 DOM 图层设置的 absolute/left/top；
    // 否则会在外部 <img> 定位之外再偏移一次，造成线路错位并伸出图片边缘。
    connectionLayer.removeAttribute("style");

    // html2canvas 对复杂内联 SVG 的坐标/分组仍可能处理错误。先交给浏览器原生 SVG
    // 渲染器生成透明图片，再让 html2canvas 合成，从根本上避免线路散乱。
    const svgMarkup = new XMLSerializer().serializeToString(connectionLayer);
    const connectionImage = document.createElement("img");
    connectionImage.className = "png-connection-image";
    connectionImage.alt = "";
    connectionImage.style.position = "absolute";
    connectionImage.style.left = `${svgLeft}px`;
    connectionImage.style.top = `${svgTop}px`;
    connectionImage.style.width = `${width}px`;
    connectionImage.style.height = `${height}px`;
    connectionImage.style.zIndex = "1";
    connectionImage.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
    clone.prepend(connectionImage);

    // cloneNode 对正在编辑的输入值并非始终可靠；逐项复制实时值，且不擅自四舍五入。
    const sourceInputs = [...source.querySelectorAll("input")];
    clone.querySelectorAll("input").forEach((input, index) => {
      let value = sourceInputs[index] ? sourceInputs[index].value : input.value;
      if (input.matches('[data-role="speed"]')) {
        const speed = parseSpeed(value, Number.NaN);
        if (Number.isFinite(speed)) value = speed.toFixed(2);
      }
      input.value = value;
      input.setAttribute("value", value);
    });
    stage.appendChild(clone);
    document.body.appendChild(stage);

    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const images = [...clone.querySelectorAll("img")];
      await Promise.all(images.map((img) => img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            setTimeout(done, 5000);
          })));
      const canvas = await window.html2canvas(stage, {
        backgroundColor: "#0B1220",
        scale,
        width,
        height,
        useCORS: true,
        logging: false,
        imageTimeout: 5000,
      });
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 编码失败")), "image/png");
      });
      return { blob, width: canvas.width, height: canvas.height, scale };
    } finally {
      stage.remove();
    }
  }
};
