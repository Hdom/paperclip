import { z } from "zod";

const signingFolderPath = z.string().trim().max(1000).refine(value => value === "" || (
  !value.startsWith("/") && !value.endsWith("/") && value.split("/").every(segment =>
    segment.length > 0 && segment === segment.trim() && segment !== "." && segment !== ".." && !/[\\\x00-\x1f\x7f]/.test(segment))
), "Use slash-separated folder names without empty, dot, or control-character segments");
export const signingKeyOrganizationSchema = z.object({ folderPath: signingFolderPath,
  expectedLatestVersion: z.number().int().positive(), expectedUpdatedAt: z.string().datetime(), expectedOrganizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), confirmed: z.literal(true) }).strict();

const confirmation = z.object({ confirmed: z.literal(true) });
const expected = { expectedLatestVersion: z.number().int().positive(), expectedRevision: z.number().int().positive() };
export const signingKeyCreateSchema = confirmation.extend({ name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullable().optional(), privateKey: z.string().min(1).max(16384) }).strict();
export const signingKeyRotateSchema = confirmation.extend({ ...expected, privateKey: z.string().min(1).max(16384) }).strict();
export const signingKeyUpdateSchema = confirmation.extend({ ...expected, name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(), status: z.enum(["active", "disabled", "archived"]).optional() }).strict();
