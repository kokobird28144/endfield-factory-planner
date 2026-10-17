// The Pages build sets this marker; a failed local API never changes storage mode.
export const isPages = typeof document !== "undefined" &&
  document.querySelector('meta[name="storage-mode"]')?.content === "browser";
