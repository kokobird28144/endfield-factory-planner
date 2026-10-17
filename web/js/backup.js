import { api } from "./api.js";
import { isPages } from "./storageMode.js";
import { exportBrowserBackup, importBrowserBackup, validateBackup } from "./browserStorage.js";

export function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[<>:"/\\|?*]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function selectJson(onRead, onError) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    try {
      if (input.files[0]) await onRead(JSON.parse(await input.files[0].text()));
    } catch (error) { onError(error); }
  };
  input.click();
}

export async function exportBackup() {
  if (isPages) return exportBrowserBackup();
  const summaries = await api.listPlans();
  return { format: "endfield-factory-backup", version: 1, exported_at: new Date().toISOString(),
    plans: await Promise.all(summaries.map(plan => api.getPlan(plan.id))),
    components: await api.listComponents(), tempRecipes: await api.getTempRecipes() };
}

export async function importBackup(data) {
  validateBackup(data);
  if (isPages) return importBrowserBackup(data);
  // The local API commits each file independently; leave the backup available for retry.
  for (const item of data.plans) await api.updatePlan(item.meta?.id || item.id, item);
  for (const item of data.components) await api.updateComponent(item.meta?.id || item.id, item);
  const merged = new Map((await api.getTempRecipes()).map(item => [item.id, item]));
  for (const item of data.tempRecipes) merged.set(item.id, item);
  await api.saveTempRecipes([...merged.values()]);
}
