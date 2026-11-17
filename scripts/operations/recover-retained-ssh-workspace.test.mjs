import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRetainedSshOptions,selectedProtectionProfile} from './recover-retained-ssh-workspace.mjs';
const id='00000000-0000-4000-8000-000000000001';
const options={command:'preserve',confirm:true,companyId:id,issueId:id,runId:id,actionId:id,actorId:'operator',
 sourceCommit:'a'.repeat(40),payload:'/opt/paperclip-data/cli/installs/git/'+'a'.repeat(12),
 config:'/opt/paperclip-data/instances/default/config.json',receipt:'/var/lib/paperclip/operator-receipts/'+id+'.json'};
test('requires a concrete confirmed source and known released controller paths',()=>{
 assert.doesNotThrow(()=>validateRetainedSshOptions(options));
 for(const changed of [{confirm:false},{command:'run'},{companyId:'other'},{payload:'/tmp/local-build'},
  {config:'/etc/private'},{receipt:'/tmp/unguarded-receipt'},{command:'retire-wake'},{command:'attest'}])
  assert.throws(()=>validateRetainedSshOptions({...options,...changed}));
});
test('requires exact historical clone proof and public digest for legacy attestation',()=>{
 const attest={...options,command:'attest',cloneDatabase:'paperclip_qualify_'+'a'.repeat(12),historicalBackup:'/var/backups/paperclip/prior-release/quiet-pre-activation.dump',
 expectedRestoreSha256:'b'.repeat(64),expectedHostKeyPolicySha256:'c'.repeat(64)};
 assert.doesNotThrow(()=>validateRetainedSshOptions(attest));
 assert.throws(()=>validateRetainedSshOptions({...attest,cloneDatabase:'paperclip'}));
 assert.throws(()=>validateRetainedSshOptions({...attest,historicalBackup:'/tmp/old.dump'}));
 assert.throws(()=>validateRetainedSshOptions({...attest,historicalBackup:'/var/backups/paperclip/../old.dump'}));
 assert.throws(()=>validateRetainedSshOptions({...attest,expectedHostKeyPolicySha256:'unverified'}));
});
test('selects only effective named protection settings, never credentials or unrelated environment',()=>{
 const env=Buffer.from('PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS=1\0PAPERCLIP_HOME=/opt/paperclip-data\0'+
 'PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS=[]\0PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT=/var/lib/paperclip/controller-assets\0'+
 'DATABASE_URL=synthetic-private-url\0PAPERCLIP_OPERATOR_API_TOKEN=synthetic-desktop-token\0PAPERCLIP_SECRETS_MASTER_KEY=synthetic-master-bytes\0');
 const profile=selectedProtectionProfile(env);
 assert.equal(profile.PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS,'1');
 assert.equal(profile.PAPERCLIP_HOME,'/opt/paperclip-data');
 assert.equal(Object.values(profile).some(v=>v.includes('synthetic-')),false);
 assert.equal(Object.hasOwn(profile,'DATABASE_URL'),false);
 assert.equal(Object.hasOwn(profile,'PAPERCLIP_OPERATOR_API_TOKEN'),false);
 assert.equal(Object.hasOwn(profile,'PAPERCLIP_SECRETS_MASTER_KEY'),false);
 assert.throws(()=>selectedProtectionProfile(Buffer.from('PAPERCLIP_HOME=/opt/paperclip-data\0')));
});
