import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { githubAppSettings, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { projectAppsConfigSchema, projectAppsConfigSnapshot, saveProjectAppsConfig, type ProjectAppsConfig } from "./github-project-apps.js";

export function appConfigRevision(config: ProjectAppsConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function appConfigSnapshot(db: Db, companyId: string) {
  const [native] = await db.select({ settings: githubAppSettings.settings, revision: githubAppSettings.revision }).from(githubAppSettings).where(eq(githubAppSettings.companyId, companyId));
  if (native) {
    const config = projectAppsConfigSchema.parse(native.settings);
    if (config.companyId !== companyId || (config.revision ?? 0) !== native.revision || Object.values(config.apps).some(app => !app.signingKeySecret || app.privateKeyPath))
      throw forbidden("Native GitHub App configuration needs reconciliation");
    return { config, revision: appConfigRevision(config), storage: "native" as const };
  }
  const legacy = await projectAppsConfigSnapshot();
  return legacy?.config.companyId === companyId ? { ...legacy, storage: "legacy" as const } : null;
}

/** Native callers pass their transaction: assignment and configuration commit together. */
export async function saveAppConfig(db: Db, config: ProjectAppsConfig, expectedRevision: string) {
  const active = await appConfigSnapshot(db, config.companyId);
  if (!active || active.revision !== expectedRevision) throw conflict("GitHub App settings changed. Reload and confirm again");
  const candidate = projectAppsConfigSchema.parse({ ...config, revision: (config.revision ?? 0) + 1 });
  if (active.storage === "legacy") { await saveProjectAppsConfig(candidate, expectedRevision); return; }
  const [updated] = await db.update(githubAppSettings).set({ settings: candidate, revision: candidate.revision!, verification: null, updatedAt: new Date() })
    .where(and(eq(githubAppSettings.companyId, config.companyId), eq(githubAppSettings.revision, active.config.revision ?? 0), eq(githubAppSettings.settings, active.config))).returning({ companyId: githubAppSettings.companyId });
  if (!updated) throw conflict("GitHub App settings changed. Reload and confirm again");
}
