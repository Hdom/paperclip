/** Root-only offline operator entry point. Deliberately absent from the public
 * CLI and HTTP router. DATABASE_URL is the controller's existing local database
 * credential, supplied by the root maintenance launcher, never a desktop token.
 */
import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDb, closeRegisteredClients } from "@paperclipai/db/client";
import { prepareSshHostStop, recordSshHostStop, type SshHostStopObservation, type SshHostStopPreparation } from "../services/ssh-host-stop-receipt.js";

const directory = "/var/lib/paperclip-maintenance/ssh-host-stop";
function rootOnly() { if (process.getuid?.() !== 0) throw new Error("Root-only offline maintenance"); }
function assertFenced() {
  const state = execFileSync("/usr/bin/systemctl", ["show", "paperclip.service", "--property=ActiveState,SubState,MainPID,UnitFileState"],
    { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  const values = Object.fromEntries(state.trim().split("\n").map(line => line.split("=")));
  if (values.ActiveState !== "inactive" || values.SubState !== "dead" || values.MainPID !== "0" ||
      !["masked", "masked-runtime"].includes(values.UnitFileState ?? "")) throw new Error("Controller must be stopped and masked");
}
function secureDirectory(path: string) {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw new Error("Unsafe maintenance directory");
}
function ensureDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  secureDirectory(path);
}
function readRootJson(path: string): unknown {
  if (!path.startsWith(directory + "/") || path.slice(directory.length + 1).includes("/")) throw new Error("Use the root maintenance directory");
  secureDirectory("/var"); secureDirectory("/var/lib"); secureDirectory("/var/lib/paperclip-maintenance"); secureDirectory(directory);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Unsafe maintenance file"); throw error; }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o077) || s.size > 65536) throw new Error("Unsafe maintenance file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
async function main() {
  rootOnly(); assertFenced();
  const [command, inputFile, ...extra] = process.argv.slice(2);
  if (!inputFile || extra.length || !["prepare", "apply"].includes(command ?? "")) throw new Error("Usage: ssh-host-stop <prepare|apply> ROOT_JSON_FILE");
  // Refuse implicit development databases, migrations and config repair.
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:/.test(url)) throw new Error("Existing controller DATABASE_URL required");
  secureDirectory("/var"); secureDirectory("/var/lib");
  ensureDirectory("/var/lib/paperclip-maintenance");
  ensureDirectory(directory);
  const input = readRootJson(inputFile) as Record<string, unknown>;
  const db = createDb(url, { maxConnections: 1, applicationName: "paperclip-ssh-host-stop-maintenance" });
  try {
    if (command === "prepare") {
      const operationId = randomUUID();
      const preparation = await prepareSshHostStop(db, {
        operationId, companyId: String(input.companyId), environmentId: String(input.environmentId),
        leaseIds: input.leaseIds as string[], requestIds: input.requestIds as string[],
      }, assertFenced);
      writeFileSync(`${directory}/${operationId}.prepared.json`, JSON.stringify(preparation) + "\n", { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify(preparation));
    } else {
      const proof = input as unknown as SshHostStopObservation;
      if (!/^[a-f0-9-]{36}$/.test(proof.operationId)) throw new Error("Invalid operation ID");
      const prepared = readRootJson(`${directory}/${proof.operationId}.prepared.json`) as SshHostStopPreparation;
      console.log(JSON.stringify(await recordSshHostStop(db, prepared, proof, assertFenced)));
    }
  } finally { await closeRegisteredClients(url); }
}
const safeErrors = new Set(["Root-only offline maintenance", "Controller must be stopped and masked", "Unsafe maintenance directory",
  "Use the root maintenance directory", "Unsafe maintenance file", "Existing controller DATABASE_URL required", "Invalid operation ID"]);
main().catch(error => { console.error(safeErrors.has(error?.message) ? error.message : "SSH host-stop maintenance rejected; no continuation authority inferred"); process.exitCode = 1; });
