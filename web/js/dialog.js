let activeFinish = null;

function ensureRoot() {
  let root = document.getElementById("appDialog");
  if (root) return root;
  root = document.createElement("div");
  root.id = "appDialog";
  root.className = "modal";
  root.hidden = true;
  root.innerHTML = `
    <div class="modal-backdrop" data-dialog-cancel></div>
    <div class="modal-panel modal-narrow dialog-panel" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle">
      <div class="modal-head"><span id="appDialogTitle" class="modal-title"></span><button class="icon-btn" type="button" data-dialog-cancel aria-label="关闭">✕</button></div>
      <div class="modal-body">
        <div class="dialog-message"></div>
        <input class="input dialog-input" type="text" hidden />
        <div class="editor-actions dialog-actions"><span class="grow"></span><button class="btn" type="button" data-dialog-cancel>取消</button><button class="btn btn-primary" type="button" data-dialog-confirm>确定</button></div>
      </div>
    </div>`;
  document.body.appendChild(root);
  return root;
}

function openDialog(message, { title, defaultValue, danger = false, prompt = false } = {}) {
  const root = ensureRoot();
  if (activeFinish) activeFinish(null);
  const titleElement = root.querySelector(".modal-title");
  const messageElement = root.querySelector(".dialog-message");
  const input = root.querySelector(".dialog-input");
  const confirmButton = root.querySelector("[data-dialog-confirm]");
  titleElement.textContent = title || (prompt ? "请输入" : "请确认");
  messageElement.textContent = String(message || "");
  input.hidden = !prompt;
  input.value = prompt ? String(defaultValue == null ? "" : defaultValue) : "";
  confirmButton.classList.toggle("btn-danger", danger);
  root.hidden = false;

  return new Promise((resolve) => {
    const finish = (value) => {
      if (activeFinish !== finish) return;
      activeFinish = null;
      root.hidden = true;
      root.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };
    const onClick = (event) => {
      if (event.target.closest("[data-dialog-confirm]")) finish(prompt ? input.value : true);
      else if (event.target.closest("[data-dialog-cancel]")) finish(prompt ? null : false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(prompt ? null : false);
      } else if (event.key === "Enter" && (!prompt || document.activeElement === input)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(prompt ? input.value : true);
      }
    };
    activeFinish = finish;
    root.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => (prompt ? input : confirmButton).focus());
  });
}

export const dialog = {
  confirm(message, options = {}) {
    return openDialog(message, { ...options, prompt: false });
  },
  prompt(message, options = {}) {
    return openDialog(message, { ...options, prompt: true });
  },
};
