// dom.js —— 共享的安全 HTML 与物品图标工具。
export const PLACEHOLDER_ICON =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
    '<rect width="40" height="40" rx="6" fill="#1E293B"/>' +
    '<text x="20" y="27" font-size="20" text-anchor="middle" fill="#64748B" font-family="sans-serif">?</text>' +
    "</svg>"
  );

export function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function iconUrl(itemId) {
  return `/item_icons/${itemId}.webp`;
}

export function iconImg(itemId, className = "") {
  const url = itemId ? iconUrl(itemId) : PLACEHOLDER_ICON;
  return `<img class="${esc(className)}" src="${esc(url)}" alt="" draggable="false" onerror="this.onerror=null;this.src='${PLACEHOLDER_ICON}'" />`;
}
