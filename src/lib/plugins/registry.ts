import type { Plugin, PluginManifest, PluginCapability } from "./types";

const registry = new Map<string, Plugin>();

export function registerPlugin(plugin: Plugin) {
  if (registry.has(plugin.manifest.key)) {
    return;
  }
  registry.set(plugin.manifest.key, plugin);
}

let loadPromise: Promise<void> | null = null;

async function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await import("./builtin/project-digest");
    await import("./builtin/project-smart-fill");
    await import("./builtin/order-smart-fill");
    await import("./builtin/project-auto-draft");
  })();
  return loadPromise;
}

export async function getPlugin(key: string): Promise<Plugin | undefined> {
  await ensureLoaded();
  return registry.get(key);
}

export async function listPlugins(): Promise<PluginManifest[]> {
  await ensureLoaded();
  return Array.from(registry.values()).map((p) => p.manifest);
}

export async function listPluginsByCapability(capability: PluginCapability): Promise<PluginManifest[]> {
  await ensureLoaded();
  return Array.from(registry.values())
    .filter((p) => p.manifest.capability === capability)
    .map((p) => p.manifest);
}
