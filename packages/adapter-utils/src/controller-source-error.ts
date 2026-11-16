/** Explicit policy refusals are permanent; unexpected I/O keeps its original retry semantics. */
export const CONTROLLER_SOURCE_PROTECTION_FAILURE_CODE = "controller_source_protection_refused";
export class ControllerSourceProtectionError extends Error {
  readonly code = CONTROLLER_SOURCE_PROTECTION_FAILURE_CODE;
  constructor(message = "Controller signing-key protection refused an unapproved source path or unsafe Git metadata") {
    super(message);
    this.name = "ControllerSourceProtectionError";
  }
}
