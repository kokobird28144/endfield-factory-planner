// 浏览器级显示偏好，独立于方案及机器速度；导出区域继承同一组 CSS 变量。
const SETTINGS = [
  { id: "portFontSize", key: "zmd_port_font_size", css: "--port-font-size", defaultValue: 11 },
  { id: "edgeFontSize", key: "zmd_edge_font_size", css: "--flow-label-font-size", defaultValue: 10.5 },
];

export function initFontSettings(graph) {
  const panel = document.getElementById("fontSettings");
  let frame = 0;
  const refresh = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const id of graph.state.keys()) graph._alignPorts(id);
      graph._scheduleEdgeRefresh();
    });
  };
  const controls = SETTINGS.map((setting) => {
    const input = document.getElementById(setting.id);
    const output = document.getElementById(`${setting.id}Value`);
    const apply = (raw, save) => {
      const parsed = raw == null || String(raw).trim() === "" ? NaN : Number(raw);
      const value = Number.isFinite(parsed)
        ? Math.min(Number(input.max), Math.max(Number(input.min), Math.round(parsed * 2) / 2))
        : setting.defaultValue;
      input.value = String(value);
      output.value = `${value} px`;
      input.setAttribute("aria-valuetext", `${value} 像素`);
      document.documentElement.style.setProperty(setting.css, `${value}px`);
      if (save) {
        try { localStorage.setItem(setting.key, String(value)); }
        catch { /* 存储不可用时仍允许当前页面调整字号。 */ }
      }
      refresh();
    };
    let saved = null;
    try { saved = localStorage.getItem(setting.key); } catch { /* 使用默认值。 */ }
    apply(saved, false);
    input.addEventListener("input", () => apply(input.value, true));
    return () => apply(setting.defaultValue, true);
  });
  document.getElementById("resetFontSizes").addEventListener("click", () => controls.forEach((reset) => reset()));
  document.addEventListener("pointerdown", (event) => {
    if (!panel.contains(event.target)) panel.open = false;
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    panel.open = false;
    panel.querySelector("summary").focus();
  });
}
