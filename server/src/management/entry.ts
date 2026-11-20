import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, lstatSync, type BigIntStats } from "node:fs";
import { resolve, dirname, join, basename, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { managementServer, type Asset } from "./server.js";
import { need, object, strictJson } from "./projection.js";

function pinnedFile(path: string, max: number): Buffer {
  const absolute = resolve(path); need(realpathSync(absolute) === absolute);
  const held: { fd: number; path: string; stat: BigIntStats }[] = [];
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME;
  const stable = (a: BigIntStats, b: BigIntStats) => (["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const).every(k => a[k] === b[k]);
  let fd = -1;
  try {
    let current: string = sep;
    for (const part of ["", ...dirname(absolute).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const dir = openSync(held.length ? `/proc/self/fd/${held.at(-1)!.fd}/${part}` : sep, 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = fstatSync(dir, { bigint: true }); held.push({ fd: dir, path: current, stat });
      need(stat.isDirectory() && !(stat.mode & 0o022n) && [0n, BigInt(process.getuid!())].includes(stat.uid));
    }
    fd = openSync(`/proc/self/fd/${held.at(-1)!.fd}/${basename(absolute)}`, flags);
    const before = fstatSync(fd, { bigint: true }); need(before.isFile() && before.nlink === 1n && !(before.mode & 0o022n) && [0n, BigInt(process.getuid!())].includes(before.uid) && before.size <= BigInt(max));
    const bytes = Buffer.alloc(Number(before.size)); let read = 0;
    while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, null); need(n > 0); read += n; }
    for (const s of [fstatSync(fd, { bigint: true }), lstatSync(absolute, { bigint: true })]) need(stable(before, s));
    for (const item of held) { need(stable(item.stat, fstatSync(item.fd, { bigint: true })) && stable(item.stat, lstatSync(item.path, { bigint: true }))); }
    need(realpathSync(absolute) === absolute && realpathSync(`/proc/self/fd/${fd}`) === absolute); return bytes;
  } finally { if (fd >= 0) closeSync(fd); for (const item of held.reverse()) closeSync(item.fd); }
}
export function loadManagement(projectionPath: string, authPath: string, uiPath: string) {
  const manifest = strictJson(pinnedFile(join(uiPath, "management-assets.json"), 32768), 32768);
  object(manifest, ["schema", "assets"]); need(manifest.schema === "paperclip.management-assets.v1" && Array.isArray(manifest.assets) && manifest.assets.length > 0 && manifest.assets.length <= 64);
  const assets = new Map<string, Asset>(); let total = 0;
  const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", woff: "font/woff", svg: "image/svg+xml", png: "image/png", webp: "image/webp", ico: "image/x-icon" };
  for (const item of manifest.assets) {
    object(item, ["file", "sha256", "bytes"]); need(typeof item.file === "string" && /^(?:management\.html|assets\/[a-zA-Z0-9_-]+\.(?:js|css)|fonts\/(?:InterVariable|InterVariable-Italic|PaperMono-Variable)\.woff2)$/.test(item.file));
    need(typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.bytes) && (item.bytes as number) > 0);
    const bytes = pinnedFile(join(uiPath, item.file), 8 * 1024 * 1024); total += bytes.length; need(total <= 16 * 1024 * 1024 && bytes.length === item.bytes && createHash("sha256").update(bytes).digest("hex") === item.sha256);
    const route = item.file === "management.html" ? "/management.html" : item.file.startsWith("fonts/") ? `/${item.file}` : `/management-assets/${item.file}`; need(!assets.has(route)); assets.set(route, { bytes, type: types[item.file.split(".").pop()!] });
  }
  return managementServer(pinnedFile(projectionPath, 1024 * 1024), pinnedFile(authPath, 16384), assets);
}
export async function main(args = process.argv.slice(2)) {
  need(process.platform === "linux" && args.length === 8 && args[0] === "--projection" && args[2] === "--auth" && args[4] === "--ui" && args[6] === "--port" && /^\d{1,5}$/.test(args[7]));
  const port = Number(args[7]); need(port >= 1024 && port <= 65535);
  const { server } = loadManagement(args[1], args[3], args[5]);
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
  process.stdout.write("management_ready_read_only\n");
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { process.stderr.write("management_start_refused\n"); process.exitCode = 1; });
