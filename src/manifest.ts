import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getManifestPath } from "./utils";

/** Read manifest.json -> Record<key, envVar>. Returns {} if missing. */
export async function loadManifest(cwd?: string): Promise<Record<string, string>> {
  try {
    const path = getManifestPath(cwd);
    if (!existsSync(path)) return {};
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const safe: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (typeof value !== "string") continue;
      safe[key] = value;
    }
    return safe;
  } catch {
    return {};
  }
}

/** Write manifest.json atomically. */
export async function saveManifest(manifest: Record<string, string>, cwd?: string): Promise<void> {
  const path = getManifestPath(cwd);
  await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
}
