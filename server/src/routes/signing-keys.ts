import { Router, type Request } from "express";
import { signingKeyCreateSchema, signingKeyRotateSchema, signingKeyUpdateSchema, signingKeyOrganizationSchema } from "@paperclipai/shared";
export { signingKeyCreateSchema, signingKeyRotateSchema, signingKeyUpdateSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import type { SigningKeySummary } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { forbidden } from "../errors.js";
import { secretService } from "../services/secrets.js";
import { logActivity } from "../services/activity-log.js";
import { readSigningKeyPublicMetadata } from "../secrets/signing-key-material.js";


export function signingKeySummary(row: Awaited<ReturnType<ReturnType<typeof secretService>["listSigningKeys"]>>[number]): SigningKeySummary {
  const metadata = row.providerMetadata;
  const info = readSigningKeyPublicMetadata(metadata?.signingPublicKey, row.latestVersion);
  const role = metadata?.role;
  const githubApp: SigningKeySummary["githubApp"] = metadata?.consumer === "github_project_apps"
    && (role === "coordinator" || role === "implementer" || role === "reviewer")
    && typeof metadata.appId === "number" && Number.isSafeInteger(metadata.appId) && metadata.appId > 0
    ? { role, appId: metadata.appId } : null;
  const generic = metadata?.purpose === "signing_key" && metadata?.type === "generic" && metadata?.consumer === undefined;
  // Compatibility read model: normalize only the exact old system-generated
  // description for recognized GitHub keys. Never rewrite stored/user text.
  const description = githubApp && row.description === "Controller signing only. Never available to agents, environment bindings or connection credentials."
    ? "Used by Paperclip for signing. Unavailable to agent variables and connection credentials." : row.description;
  return { id: row.id, name: row.name, description, status: row.status,
    type: githubApp ? "github_app" : generic ? "generic" : "managed", githubApp,
    algorithm: info?.algorithm ?? null, publicFingerprint: info?.publicFingerprint ?? null,
    folderPath: typeof metadata?.signingFolderPath === "string" ? metadata.signingFolderPath : null,
    canOrganize: Boolean(githubApp || generic),
    organizationRevision: Number.isSafeInteger(metadata?.signingOrganizationRevision) ? Number(metadata!.signingOrganizationRevision) : 0,
    latestVersion: row.latestVersion, revision: generic && Number.isSafeInteger(metadata?.lifecycleRevision) ? Number(metadata!.lifecycleRevision) : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function signingKeyRoutes(db: Db, service: ReturnType<typeof secretService> = secretService(db), options: { publicOrigin?: string } = {}) {
  const router = Router(), base = "/companies/:companyId/signing-keys";
  function access(req: Request, write = false) {
    assertBoard(req); const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const canManage = Boolean(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    if (write) {
      assertInstanceAdmin(req);
      if (req.headers.origin) {
        let origin: URL; try { origin = new URL(req.headers.origin); } catch { throw forbidden("Invalid settings origin"); }
        const expectedOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : `${req.protocol}://${req.get("host")}`;
        if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== expectedOrigin)
          throw forbidden("Signing key changes require a same-origin request");
      }
    }
    return { companyId, canManage };
  }
  router.use(base, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  async function catalog(companyId: string, canManage: boolean) {
    return { canManage, keys: (await service.listSigningKeys(companyId)).map(signingKeySummary) };
  }
  async function audit(req: Request, action: string, id: string) {
    await logActivity(db, { companyId: req.params.companyId as string, actorType: "user", actorId: req.actor.userId ?? "board",
      action, entityType: "secret", entityId: id, details: {} });
  }
  // Discard write-only material from the original request before validation or auditing.
  function takeBody(req: Request) {
    const body = { ...req.body }; if (req.body && typeof req.body === "object") delete req.body.privateKey; return body;
  }
  router.get(base, async (req, res) => { const { companyId, canManage } = access(req); res.json(await catalog(companyId, canManage)); });
  router.get(`${base}/:secretId/versions`, async (req, res) => {
    const { companyId } = access(req);
    res.json(await service.signingKeyVersions(companyId, req.params.secretId as string));
  });
  router.get(`${base}/:secretId/access-events`, async (req, res) => {
    const { companyId } = access(req);
    res.json(await service.signingKeyAccessEvents(companyId, req.params.secretId as string));
  });
  router.post(base, async (req, res) => {
    const { companyId } = access(req, true); const input = signingKeyCreateSchema.parse(takeBody(req));
    const key = await service.createSigningKey(companyId, input, req.actor.userId ?? "board");
    await audit(req, "signing_key.created", key.id); res.status(201).json(signingKeySummary(key));
  });
  router.post(`${base}/:secretId/rotate`, async (req, res) => {
    const { companyId } = access(req, true); const input = signingKeyRotateSchema.parse(takeBody(req));
    const key = await service.rotateSigningKey(companyId, req.params.secretId as string, input.privateKey,
      input.expectedLatestVersion, req.actor.userId ?? "board", input.expectedRevision);
    await audit(req, "signing_key.rotated", key.id); res.json(signingKeySummary(key));
  });
  router.patch(`${base}/:secretId/organization`, async (req, res) => {
    const { companyId } = access(req, true);
    const { confirmed: _confirmed, ...input } = signingKeyOrganizationSchema.parse(req.body);
    const key = await service.organizeSigningKey(companyId, req.params.secretId as string, input);
    await audit(req, "signing_key.organized", key.id);
    res.json(signingKeySummary(key));
  });
  router.patch(`${base}/:secretId`, async (req, res) => {
    const { companyId } = access(req, true); const { confirmed: _confirmed, ...input } = signingKeyUpdateSchema.parse(req.body);
    const key = await service.updateSigningKey(companyId, req.params.secretId as string, input);
    await audit(req, "signing_key.updated", key.id); res.json(signingKeySummary(key));
  });
  return router;
}
