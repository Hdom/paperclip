import type { CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { registerMaintenanceChannel, type MaintenanceChannelBinding } from "./instance-maintenance.js";

/** The route and process lifetime outlive open(). Never certify a transport
 * close as a physical exit. Stop/close remain available with admissions shut. */
export async function openMaintenanceProviderChannel(db: Db,
  input: MaintenanceChannelBinding,
  factory: () => Promise<CommandManagedDuplexChannel>): Promise<CommandManagedDuplexChannel> {
  const owner = await registerMaintenanceChannel(db,input);
  // An open failure may have spawned a process before losing its reply. Keep
  // its durable obligation instead of inventing an absence receipt.
  const channel = await factory();
  type Exit = Parameters<Parameters<CommandManagedDuplexChannel["onExit"]>[0]>[0];
  let exit: Exit | undefined, listener: ((value: Exit) => void) | undefined;
  let queue = Promise.resolve(), closing: Promise<void> | undefined, settlement: Promise<void> | undefined;
  let closed = false, routeClosed = false, inputRefused = false;
  let pendingBytes = 0;
  const settleIfProven = () => {
    if (!routeClosed || !exit || typeof exit.exitCode !== "number" || exit.transportClosed)
      return Promise.reject(conflict("Provider channel physical exit is unconfirmed; its maintenance obligation is retained."));
    return settlement ??= owner.settleVerifiedExitAndClose();
  };
  const close = () => closing ??= (async () => {
    closed = true;
    await queue;
    await channel.close();
    routeClosed = true;
    await settleIfProven();
  })();
  channel.onExit(value => {
    if (exit) return;
    exit = value;
    try { listener?.(value); }
    finally {
      // Close the route after physical exit, including an exit buffered before
      // the caller installs its listener. Unknown closure keeps the DB hold.
      void (routeClosed ? settleIfProven() : close()).catch(error => logger.warn({ operationId: owner.id, err: error }, "Provider channel maintenance settlement remains unconfirmed"));
    }
  });
  return {
    write(data) {
      if (closed || inputRefused) throw conflict("Provider channel input is closed.");
      if (pendingBytes + data.byteLength > 16 * 1024 * 1024) throw conflict("Provider channel admission queue is full.");
      const bytes = Uint8Array.from(data); pendingBytes += bytes.byteLength;
      queue = queue.then(async () => {
        try {
          if (inputRefused) return;
          await owner.assertWritable();
          if (!inputRefused) channel.write(bytes);
        }
        finally { pendingBytes -= bytes.byteLength; }
      }).catch(error => {
        inputRefused = true;
        try { channel.stop(); }
        catch (stopError) { logger.warn({operationId:owner.id,err:stopError},"Provider channel Stop remains unconfirmed"); }
        logger.warn({operationId:owner.id,err:error},"Provider channel input was refused; stopping the original channel");
      });
    },
    onData: callback => channel.onData(callback),
    onExit(callback) { listener=callback; if(exit) callback(exit); },
    stop: () => channel.stop(),
    close,
  };
}
