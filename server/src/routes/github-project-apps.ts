import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { githubProjectAppRoleSchema as role, githubProjectAppConfirmationSchema as confirmation,
  githubProjectAppSettingsInputSchema as settings, githubProjectAppRotateInputSchema as rotate,
  githubProjectAppActivateInputSchema as activate, githubProjectAppVerificationSchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { githubProjectAppAdmin } from "../services/github-project-app-admin.js";

export function githubProjectAppRoutes(db: Db, service = githubProjectAppAdmin(db), options: { publicOrigin?: string } = {}) {
  const router = Router();
  async function access(req: Request, write = false) {
    assertBoard(req); const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const canManage = Boolean(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
      && await canManageAiConnections(db, req, companyId);
    if (write) {
      assertInstanceAdmin(req);
      if (!canManage) throw forbidden("Instance administration and connection management are required");
      if (req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw forbidden("Invalid settings origin"); }
        const expected = options.publicOrigin ? new URL(options.publicOrigin).origin : `${req.protocol}://${req.get("host")}`;
        if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== expected)
          throw forbidden("GitHub App administration requires a same-origin request");
      }
    }
    return { companyId, canManage };
  }
  router.use("/companies/:companyId/github-project-apps", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/companies/:companyId/github-project-apps", async (req, res) => {
    const { companyId, canManage } = await access(req);
    res.json(await service.settings(companyId, canManage));
  });
  async function audit(req: Request, action: string, details: Record<string, unknown> = {}) {
    await logActivity(db, { companyId: req.params.companyId as string, actorType: "user", actorId: req.actor.userId ?? "board",
      action, entityType: "company", entityId: req.params.companyId as string, details });
  }
  router.post("/companies/:companyId/github-project-apps/verify", async (req, res) => {
    const { companyId } = await access(req, true); const input = githubProjectAppVerificationSchema.parse(req.body);
    await service.verify(companyId, input.revision);
    await audit(req, "github_project_app.settings_verified");
    res.json(await service.settings(companyId, true));
  });
  router.put("/companies/:companyId/github-project-apps", async (req, res) => {
    const { companyId } = await access(req, true); const input = settings.parse(req.body);
    await audit(req, "github_project_app.settings_change_requested", { enabled: input.enabled, bindings: input.bindings, releaseAgentId: input.releaseAgentId });
    await service.configure(companyId, input.revision, input);
    await audit(req, "github_project_app.settings_changed");
    res.json(await service.settings(companyId, true));
  });
  router.post("/companies/:companyId/github-project-apps/migrate", async (req, res) => {
    const { companyId } = await access(req, true); const input = confirmation.strict().parse(req.body);
    await audit(req, "github_project_app.native_secret_migration_requested");
    const migration = await service.migrate(companyId, input.revision, req.actor.userId ?? "board");
    await audit(req, "github_project_app.native_secret_migrated", { cleanupPending: migration.cleanupPending });
    res.json({ ...await service.settings(companyId, true), migration });
  });
  router.post("/companies/:companyId/github-project-apps/keys/:role/rotate", async (req, res) => {
    const { companyId } = await access(req, true); const selected = role.parse(req.params.role);
    const input = rotate.parse(req.body); delete req.body.privateKey;
    await audit(req, "github_project_app.key_rotation_requested", { role: selected, expectedLatestVersion: input.expectedLatestVersion });
    await service.rotate(companyId, input.revision, selected, input.privateKey, input.expectedLatestVersion, req.actor.userId ?? "board");
    await audit(req, "github_project_app.key_rotated", { role: selected });
    res.json(await service.settings(companyId, true));
  });
  router.post("/companies/:companyId/github-project-apps/keys/:role/activate", async (req, res) => {
    const { companyId } = await access(req, true); const selected = role.parse(req.params.role), input = activate.parse(req.body);
    await audit(req, "github_project_app.key_activation_requested", { role: selected, version: input.version });
    await service.activateVersion(companyId, input.revision, selected, input.version);
    await audit(req, "github_project_app.key_activated", { role: selected, version: input.version });
    res.json(await service.settings(companyId, true));
  });
  return router;
}
