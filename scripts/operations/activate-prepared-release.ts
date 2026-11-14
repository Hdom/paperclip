import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertManagedInstallStore, resolveInstallStorePaths, withInstallStoreLock, flipCurrentAtomic, writeInstallManifestAtomic, buildNextManifest } from '../../cli/src/install-store.ts';

interface ActivationInput { expectedCurrentSha: string; newSourceSha: string; releaseManifestPath: string; expectedWorkflowRun: string; paperclipHome: string; homeDir: string; }
export async function activatePreparedRelease(input: ActivationInput) {
  if (!/^[a-f0-9]{40}$/.test(input.expectedCurrentSha ?? '') || !/^[a-f0-9]{40}$/.test(input.newSourceSha ?? '')) throw new Error('Exact source identities required');
  const manifest = JSON.parse(fs.readFileSync(input.releaseManifestPath, 'utf8'));
  if (manifest.repository !== 'Hdom/paperclip' || manifest.sourceCommit !== input.newSourceSha
      || manifest.workflowCommit !== input.newSourceSha || !/^\d+$/.test(manifest.workflowRun ?? '')
      || String(manifest.workflowRun) !== String(input.expectedWorkflowRun)) throw new Error('Hdom release provenance differs from the approved run');
  const paths = resolveInstallStorePaths({ paperclipHome: input.paperclipHome, homeDir: input.homeDir });
  const payload = path.join(paths.installsRoot, 'git', input.newSourceSha.slice(0,12));
  if (fs.realpathSync(payload) !== payload) throw new Error('Prepared payload must be a physical directory');
  const stamp = JSON.parse(fs.readFileSync(path.join(payload,'node_modules/@paperclipai/server/dist/build-info.json'),'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(payload,'node_modules/paperclipai/package.json'),'utf8')).version;
  if (stamp.commit !== input.newSourceSha || version !== manifest.packageVersion) throw new Error('Prepared payload identity differs from release');
  return withInstallStoreLock(async () => {
    const current = assertManagedInstallStore(paths), target = fs.realpathSync(paths.currentPath);
    if (current.sha === input.newSourceSha) {
      if (target !== payload) throw new Error('Manifest/current link mismatch');
      return { activated:false, replay:true, sourceCommit:current.sha };
    }
    if (current.sha !== input.expectedCurrentSha || ![fs.realpathSync(current.payloadPath),payload].includes(target)) throw new Error('Managed payload changed');
    const record = { source:'git' as const,version,channel:'pinned' as const,payloadPath:payload,repo:'Hdom/paperclip',ref:input.newSourceSha,sha:input.newSourceSha,installedAt:new Date().toISOString() };
    flipCurrentAtomic(payload,paths);
    writeInstallManifestAtomic(buildNextManifest(record,current),paths);
    return { activated:true,replay:false,sourceCommit:record.sha,previousCommit:current.sha };
  },paths,{initialize:false});
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await activatePreparedRelease(JSON.parse(process.env.PAPERCLIP_OFFLINE_ACTIVATION ?? '{}')))); }
  catch { console.error(JSON.stringify({error:'Prepared release activation failed; inspect the protected manager state before retrying'}));process.exitCode=1; }
}
