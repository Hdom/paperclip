import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { reconcileMaintenance } from "./instance-maintenance.js";

/** One startup reconstruction and committed-work signals; no idle polling. */
export function registerMaintenanceWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>) {
  let requested = 1, reconciled = 0;
  const worker = coordinator.register(DELIVERY_QUEUES.instanceMaintenance, {
    retryMs: 5000, runDuringDrain: true,
    run: async () => { const generation = requested; await reconcileMaintenance(db); reconciled = generation; },
    hasPending: async () => requested !== reconciled,
    nextRunAt: () => null,
  });
  const subscriptions = [DELIVERY_QUEUES.instanceMaintenance, DELIVERY_QUEUES.executionFinalization,
    DELIVERY_QUEUES.environmentCleanup, DELIVERY_QUEUES.nativeResultCommit, DELIVERY_QUEUES.agentLifecycle]
    .map(queue => subscribeDeliveryWork(db, queue, () => { requested++; worker.wake(); }));
  return { ready: worker.ready, async stop() { for (const stop of subscriptions) stop(); await worker.stop(); } };
}
