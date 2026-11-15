import { and, eq, inArray } from "drizzle-orm";
import { connectionGrants, githubAppSettings, toolConnectionInstalls, toolConnections, toolProfiles, toolProfileBindings, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { assertAppConnectionGrant, nativeAppConnection, requirePausedAppAgents } from "./github-app-connections.js";
import type { ProjectAppsConfig } from "./github-project-apps.js";

const roles = ["coordinator", "implementer", "reviewer"] as const;

/** Native policy, grants and installations commit atomically. No reference file is swapped. */
export async function updateNativeAppConnectionSettings(db: Db, previous: ProjectAppsConfig, next: ProjectAppsConfig,
  actorUserId: string, save: (client: Db) => Promise<void>) {
  await db.transaction(async tx => {
    const [nativeSettings] = await tx.select().from(githubAppSettings).where(eq(githubAppSettings.companyId, previous.companyId)).for("update");
    const rows = await tx.select().from(toolConnections).where(and(eq(toolConnections.companyId, previous.companyId),
      inArray(toolConnections.uid, roles.map(role => `github/project-app-${role}`)))).orderBy(toolConnections.uid).for("update");
    if (rows.length !== 0 && (rows.length !== 3 || !nativeSettings)) throw conflict("Complete or reconcile the three native identities before changing assignments");
    if (rows.length === 0 && nativeSettings) throw conflict("Native GitHub App connections are missing; user fallback is blocked");
    if (rows.length === 3) {
      // Fence only authority handovers, not an immediate reduction of issuance.
      // Removing a former-agent block restores ordinary GitHub credential rules
      // and therefore requires the same paused/drained boundary as assignment.
      const affected = roles.filter(role => previous.apps[role].agentId !== next.apps[role].agentId)
        .flatMap(role => [previous.apps[role].agentId, next.apps[role].agentId]);
      if (previous.enabled === false && next.enabled !== false)
        affected.push(...roles.map(role => next.apps[role].agentId));
      affected.push(...(previous.blockedAgentIds ?? []).filter(id => !(next.blockedAgentIds ?? []).includes(id)));
      if (affected.length) await requirePausedAppAgents(tx as unknown as Db, previous.companyId, affected);
      for (const role of roles) {
        const current = await nativeAppConnection(tx as unknown as Db, previous, role, false);
        if (!current) throw conflict("GitHub App connection disappeared");
        const agentId = next.apps[role].agentId;
        if (agentId !== previous.apps[role].agentId) {
          const [profile] = await tx.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, next.companyId),
            eq(toolProfiles.profileKey, `app:${current.connection.id}`))).for("update");
          if (profile) {
            const bindings = await tx.select().from(toolProfileBindings).where(and(eq(toolProfileBindings.companyId, next.companyId), eq(toolProfileBindings.profileId, profile.id)));
            if (bindings.some(binding => binding.targetType !== "agent" || binding.targetId !== previous.apps[role].agentId))
              throw conflict("Reconcile this App's dedicated action profile before reassignment");
            await tx.update(toolProfileBindings).set({ targetId: agentId }).where(and(eq(toolProfileBindings.companyId, next.companyId), eq(toolProfileBindings.profileId, profile.id)));
          }
          const now = new Date();
          await tx.update(connectionGrants).set({ status: "revoked", revokedAt: now, revokedByUserId: actorUserId, updatedAt: now })
            .where(and(eq(connectionGrants.id, current.grant.id), eq(connectionGrants.companyId, previous.companyId), eq(connectionGrants.status, "active")));
          const [priorGrant] = await tx.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, next.companyId),
            eq(connectionGrants.connectionId, current.connection.id), eq(connectionGrants.subjectAgentId, agentId)));
          const providerTenant = { githubApp: { ...current.grant.providerTenant!.githubApp!, tools: "unverified" as const } };
          if (priorGrant) {
            assertAppConnectionGrant({ ...priorGrant, status: "active" }, current.connection, next, role);
            await tx.update(connectionGrants).set({ status: "active", revokedAt: null, revokedByUserId: null, revokedByAgentId: null,
              providerTenant, updatedAt: now }).where(and(eq(connectionGrants.id, priorGrant.id), eq(connectionGrants.companyId, next.companyId)));
          } else await tx.insert(connectionGrants).values({ companyId: next.companyId, connectionId: current.connection.id, kind: "agent",
            subjectAgentId: agentId, providerTenant, status: "active", createdByUserId: actorUserId });
          await tx.delete(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, next.companyId), eq(toolConnectionInstalls.connectionId, current.connection.id)));
          await tx.insert(toolConnectionInstalls).values({ companyId: next.companyId, connectionId: current.connection.id,
            targetType: "agent", targetId: agentId, createdByUserId: actorUserId });
        }
        await tx.update(toolConnections).set({ enabled: next.enabled !== false, updatedAt: new Date() })
          .where(and(eq(toolConnections.companyId, next.companyId), eq(toolConnections.id, current.connection.id)));
      }
    }
    // Before native import this retains the legacy single-file behavior with
    // no connection rows to synchronize. After import the callback updates the
    // native settings row using this exact transaction.
    await save(tx as unknown as Db);
  });
}
