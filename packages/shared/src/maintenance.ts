import { z } from "zod";

export const maintenanceStartSchema = z.object({ expectedGeneration: z.number().int().nonnegative(),
  requestId: z.string().uuid(), operatorNote: z.string().trim().min(1).max(2000),
  continuationPolicy: z.enum(["review_all", "requires_readiness_decision"]).optional() }).strict();
export const maintenanceReleaseSchema = z.object({ generation: z.number().int().nonnegative(),
  ownerId: z.string().uuid(), requestId: z.string().uuid(), reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const maintenanceRecoverySchema = maintenanceReleaseSchema.extend({ companyId: z.string().uuid(),
  issueId: z.string().uuid(), runId: z.string().uuid(), actionId: z.string().uuid() }).strict();
export type MaintenanceStatus = {
  state: "released" | "acquiring" | "held";
  generation: number; canManage: boolean; message: string; checkedAt: string;
  admin?: { ownerId: string | null; operatorNote: string | null; actorId: string | null; startedAt: string | null;
    blockers: { operations: number; runs: number; leases: number; finalizations: number; workspaces: number };
    savedWork: Array<{ companyId: string; issueId: string | null; requestId: string; status: string; identifier?: string;
      recovery?: { actionId: string; runId: string } }>;
    activeRecoveries: number;
    releaseReview: { fingerprint: string; savedIntentCount: number; blockedReason: string | null };
  };
};
