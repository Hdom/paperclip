import { z } from "zod";

const confirmation = z.object({ confirmed: z.literal(true) });
const expected = { expectedLatestVersion: z.number().int().positive(), expectedRevision: z.number().int().positive() };
export const signingKeyCreateSchema = confirmation.extend({ name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullable().optional(), privateKey: z.string().min(1).max(16384) }).strict();
export const signingKeyRotateSchema = confirmation.extend({ ...expected, privateKey: z.string().min(1).max(16384) }).strict();
export const signingKeyUpdateSchema = confirmation.extend({ ...expected, name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(), status: z.enum(["active", "disabled", "archived"]).optional() }).strict();

