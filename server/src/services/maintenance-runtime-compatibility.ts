import type { Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { readMaintenance } from "./instance-maintenance.js";

/** A protected, version-independent service preflight must call this before
 * selecting a candidate. A pre-fence binary cannot protect a persisted hold.
 * This check is not installed on a host by importing the new application. */
export async function assertMaintenanceRuntimeCompatibility(db: Db, candidate: unknown) {
  const state=await readMaintenance(db);
  const value=candidate as {schema?:unknown;instanceMaintenance?:unknown}|null;
  if(value?.schema!=="paperclip.runtime-capabilities.v1" || value.instanceMaintenance!==state.protocolVersion)
    throw conflict("The selected runtime cannot honor persisted maintenance. Keep service containment in place; do not start this rollback candidate.",
      {code:"maintenance_runtime_incompatible"});
}
