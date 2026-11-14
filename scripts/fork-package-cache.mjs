import fs from 'node:fs';
import path from 'node:path';
/** Public npm cache only. This does not reuse credentials, payloads, or HOME. */
export function preparePackageCache(input, source, output) {
  if (!path.isAbsolute(input)) throw new Error('Package cache must be an absolute directory');
  const cache = path.resolve(input);
  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  if (overlaps(cache, source) || overlaps(cache, output)) throw new Error('Package cache must be separate from source and output');
  // Refuse aliases rather than following a link into source, output or secrets.
  let part = cache;
  while (part !== path.dirname(part)) {
    if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) throw new Error('Package cache path must not contain symlinks');
    part = path.dirname(part);
  }
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(cache);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error('Package cache must be owned by the builder and not writable by others');
  return fs.realpathSync(cache);
}
