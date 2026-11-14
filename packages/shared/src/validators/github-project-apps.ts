import { z } from "zod";
export const githubProjectAppRoleSchema = z.enum(["coordinator", "implementer", "reviewer"]);
export const githubProjectAppRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const githubProjectAppConfirmationSchema = z.object({ revision: githubProjectAppRevisionSchema, confirmed: z.literal(true) }).strict();
export const githubProjectAppVerificationSchema = z.object({ revision: githubProjectAppRevisionSchema }).strict();
export const githubProjectAppSettingsInputSchema = githubProjectAppConfirmationSchema.extend({ enabled: z.boolean().optional(), bindings: z.object({
  coordinator: z.string().uuid(), implementer: z.string().uuid(), reviewer: z.string().uuid(),
}).strict().optional(), releaseAgentId: z.string().uuid().optional() }).strict();
export const githubProjectAppRotateInputSchema = githubProjectAppConfirmationSchema.extend({
  privateKey: z.string().min(1).max(16384).describe("Write-only PEM input. No response or log includes this value."),
  expectedLatestVersion: z.number().int().positive(),
}).strict();
export const githubProjectAppActivateInputSchema = githubProjectAppConfirmationSchema.extend({ version: z.number().int().positive() }).strict();
