"""Actual root verification -> unprivileged fixed entry exec, synthetic only.
Must run in the owned loopback namespace; fixture tree is a new root-owned
/opt directory with exact identity-bound cleanup. No service or DB access.
"""
import argparse, importlib.util, json, os, pathlib, pwd, shutil, stat, subprocess, sys, uuid
sys.dont_write_bytecode=True
def main():
    p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--user',required=True);a=p.parse_args()
    if os.geteuid()!=0 or pwd.getpwnam(a.user).pw_uid<1000:raise ValueError('Root fixture and nonprivileged owner required')
    routes=json.loads(subprocess.check_output(['/usr/sbin/ip','-j','route','show','table','all']))
    if any(r.get('dst')=='default' for r in routes):raise ValueError('Owned loopback-only namespace required')
    script=pathlib.Path(__file__).resolve().parents[1]/'operations/maintenance-host.py'
    fixture=pathlib.Path('/opt')/('paperclip-maintenance-qualification-'+uuid.uuid4().hex);fixture.mkdir(mode=0o755);identity=fixture.stat()
    try:
        capsule=fixture/'capsule';capsule.mkdir(mode=0o755)
        shutil.copyfile(a.node,capsule/'node');(capsule/'node').chmod(0o755)
        entry=capsule/'entry.mjs';entry.write_text("import {value} from './dependency.mjs';import fs from 'node:fs';console.log(JSON.stringify({value,uid:process.getuid(),groups:process.getgroups(),argv:process.argv.slice(2),cwd:process.cwd(),noNewPrivileges:/NoNewPrivs:\\s+1/.test(fs.readFileSync('/proc/self/status','utf8')),nodeOptions:process.env.NODE_OPTIONS??null}));");entry.chmod(0o644)
        dep=capsule/'dependency.mjs';dep.write_text("export const value='verified-fixed-capsule';");dep.chmod(0o644)
        # A different mutable current selector is intentionally never used.
        current=fixture/'current';current.symlink_to(capsule);current.unlink();current.symlink_to('/not-the-verified-capsule')
        bridge="import importlib.util,pathlib,sys,json;spec=importlib.util.spec_from_file_location('host',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);root=pathlib.Path(sys.argv[2]);manifest={'node':'node','entry':'entry.mjs','files':{p.name:m.digest(p.read_bytes()) for p in root.iterdir()},'links':{}};m.verified_tree(root,manifest);m.drop_and_exec(root,manifest,{},service_name=sys.argv[3],working_directory=str(root))"
        result=subprocess.run(['/usr/bin/python3','-I','-S','-B','-c',bridge,str(script),str(capsule),a.user],capture_output=True,text=True)
        if result.returncode:raise ValueError('Actual privilege-drop child refused: '+result.stderr[-1000:])
        observed=json.loads(result.stdout)
        # Node reports the effective gid in getgroups; the host primitive also
        # asserts Linux supplementary groups empty before exec.
        assert observed=={'value':'verified-fixed-capsule','uid':pwd.getpwnam(a.user).pw_uid,'groups':[pwd.getpwnam(a.user).pw_gid],'argv':['run','--no-repair'],'cwd':str(capsule),'noNewPrivileges':True,'nodeOptions':None},observed
        spec=importlib.util.spec_from_file_location('host',script);host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
        # Actual ESM metadata resolution through a contained package-directory
        # link. Candidate module throws if evaluated; resolver must not run it.
        cli=capsule/'node_modules/paperclipai/dist';cli.mkdir(parents=True,mode=0o755);(cli/'index.js').write_text("throw Error('must not evaluate candidate');")
        package=capsule/'.store/server';(package/'dist').mkdir(parents=True,mode=0o755)
        (package/'package.json').write_text(json.dumps({'name':'@paperclipai/server','type':'module','exports':{'.':{'import':'./dist/index.js'}}}))
        (package/'dist/index.js').write_text("throw Error('must not evaluate server');")
        scope=capsule/'node_modules/@paperclipai';scope.mkdir(mode=0o755);(scope/'server').symlink_to('../../.store/server')
        closure={'entry':'node_modules/paperclipai/dist/index.js','files':{'.store/server/dist/index.js':'unused-by-resolver'}}
        host.verify_server_resolution({'operatorRoot':str(capsule)},capsule,closure)
        (package/'package.json').write_text(json.dumps({'exports':{'.':{'import':'./dist/missing.js'}}}))
        try:host.verify_server_resolution({'operatorRoot':str(capsule)},capsule,closure)
        except host.Refusal:pass
        else:raise AssertionError('Changed package resolution admitted')
        private=fixture/'private';private.mkdir(mode=0o700);host.POLICY=private/'policy.json';host.EPOCH=private/'epoch.json'
        policy={'identity':{'database':'synthetic','databaseOid':42,'instanceId':'synthetic-instance'},'requestId':str(uuid.uuid4()),'expectedGeneration':0}
        result={'identity':policy['identity'],'generation':1,'ownerId':str(uuid.uuid4()),'state':'held','policy':'requires_readiness_decision','inventoryDigest':'a'*64}
        first=host.install_epoch(policy,result);assert host.install_epoch(policy,result)==first
        assert host.EPOCH.stat().st_nlink==1
        try:host.install_epoch(policy,{**result,'ownerId':str(uuid.uuid4())})
        except host.Refusal:pass
        else:raise AssertionError('Changed epoch replaced protected receipt')
        assert json.loads(host.EPOCH.read_text())==first
        print(json.dumps({'actualPrivilegeDropExec':True,'fixedEntryUnaffectedByCurrentSwap':True,'dependencyLoadedAfterDrop':True,'esmResolutionWithoutCandidateEvaluation':True,'epochAtomicReplayAndReplacementRefusal':True,'productionAccess':False}))
    finally:
        actual=fixture.lstat()
        if (actual.st_dev,actual.st_ino)!=(identity.st_dev,identity.st_ino) or not stat.S_ISDIR(actual.st_mode):raise RuntimeError('Owned fixture changed; retain it')
        shutil.rmtree(fixture)
if __name__=='__main__':main()
