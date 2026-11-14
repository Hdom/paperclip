import { z } from "zod";

export const WORKER_CHECK_IN_TIMEOUT_MS = 180_000;
export const WORKER_CHECK_IN_INTERVAL_MS = 60_000;
export const workerSupervisionConfigSchema = z.object({ mode: z.literal("check_in") }).strict();
export const workerCheckInSchema = z.object({
  version: z.literal(1),
  generation: z.string().uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const workerSupervisionStateSchema = z.object({
  version: z.literal(1), mode: z.literal("check_in"), runId: z.string().uuid(),
  generation: z.string().uuid(), timeoutMs: z.literal(WORKER_CHECK_IN_TIMEOUT_MS),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["healthy", "suspected_disconnected", "controller_settled"]),
  startedAt: z.string().datetime(), lastCheckInAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime().nullable(), missedAt: z.string().datetime().nullable(),
  controllerSettledAt: z.string().datetime().nullable(),
}).strict();
export type WorkerSupervisionState = z.infer<typeof workerSupervisionStateSchema>;
export function readWorkerSupervision(value: unknown, runId: string): WorkerSupervisionState | null {
  const parsed = workerSupervisionStateSchema.safeParse(value);
  return parsed.success && parsed.data.runId === runId ? parsed.data : null;
}
