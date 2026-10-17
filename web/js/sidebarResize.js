export function initSidebarResize() {
  const root = document.getElementById("leftShellRoot");
  let preferred = 240, gesture = null;
  try { const saved = Number(localStorage.getItem("zmd_component_height")); if (saved >= 100) preferred = saved; } catch { /* 默认高度。 */ }
  const apply = () => {
    const max = Math.max(100, root.clientHeight - 300);
    const height = Math.min(max, Math.max(100, preferred));
    root.style.setProperty("--component-height", `${height}px`);
    const handle = document.getElementById("componentResizeHandle");
    handle.setAttribute("aria-valuenow", String(Math.round(height)));
    handle.setAttribute("aria-valuemin", "100");
    handle.setAttribute("aria-valuemax", String(max));
    return height;
  };
  const save = () => { try { localStorage.setItem("zmd_component_height", String(preferred)); } catch { /* 仍可即时调整。 */ } };
  root.addEventListener("pointerdown", event => {
    if (!event.target.closest("#componentResizeHandle") || event.button !== 0) return;
    event.preventDefault();
    gesture = { y: event.clientY, height: apply(), id: event.pointerId };
    root.setPointerCapture(event.pointerId);
  });
  root.addEventListener("pointermove", event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    preferred = gesture.height + gesture.y - event.clientY;
    preferred = apply();
  });
  const finish = () => { if (!gesture) return; const id = gesture.id; gesture = null; if (root.hasPointerCapture(id)) root.releasePointerCapture(id); save(); };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  root.addEventListener("dblclick", event => { if (event.target.closest("#componentResizeHandle")) { preferred = 240; apply(); save(); } });
  root.addEventListener("keydown", event => {
    if (!event.target.closest("#componentResizeHandle") || !["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    preferred = event.key === "Home" ? 240 : apply() + (event.key === "ArrowUp" ? 20 : -20);
    preferred = apply(); save();
  });
  new ResizeObserver(apply).observe(root);
  apply();
}
