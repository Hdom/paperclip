/** Internal, independently bundled operator mechanism. Not a public CLI.
 * The protected host launcher supplies validated input through stdin; this
 * module never resolves candidate code, signs a key or starts an agent.
 */
import { createHash } from 'node:crypto';
import { sql, createDb, applyPendingMigrations, inspectMigrations } from './maintenance-db-entry.js';
import { readMaintenance, startMaintenance, reconcileMaintenance, maintenanceBlockers } from '../../server/src/services/maintenance-state-core.js';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ident=(name:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(name))throw Error('Unsafe database identifier');return '"'+name+'"';};
type Identity={database:string;databaseOid:number;instanceId:string};
type Input={mode:'inspect'|'initialize'|'guard';databaseUrl:string;identity:Identity;expectedGeneration:number;requestId:string;approvalReference:string;operatorNote:string;baseline?:Record<string,unknown>;expectedOwnerId?:string};

async function identity(db:Pick<ReturnType<typeof createDb>,'execute'>):Promise<Identity>{
  const [r]=await db.execute(sql`select current_database() as database, (select oid::int from pg_database where datname=current_database()) as "databaseOid", (select id::text from instance_settings where singleton_key='default') as "instanceId"`);
  if(!r?.instanceId)throw Error('Existing instance identity required');
  return r as unknown as Identity;
}
async function alone(db:ReturnType<typeof createDb>){
  const [r]=await db.execute(sql`select count(*)::int as n from pg_stat_activity where datid=(select oid from pg_database where datname=current_database()) and pid<>pg_backend_pid() and backend_type='client backend'`);
  if(r.n!==0)throw Error('Another database client exists; offline ownership is not established');
}
/** Hash rows inside PostgreSQL. Encrypted secret rows never leave the DB.
 * Every existing public domain is retained, not only the incident subset.
 * UTC and a repeatable-read transaction make row encoding deterministic.
 */
export async function retainedInventory(db:Pick<ReturnType<typeof createDb>,'execute'>){
  const tables=await db.execute(sql`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name not in ('instance_maintenance','instance_maintenance_operations','instance_maintenance_events') order by table_name`);
  if(tables.length>1000)throw Error('Inventory table bound exceeded');
  const result:Record<string,unknown>=Object.create(null);
  for(const row of tables){
    const table=String(row.table_name);
    const [size]=await db.execute(sql.raw(`select count(*)::int as count from public.${ident(table)}`));
    if(typeof size.count!=='number'||!Number.isSafeInteger(size.count)||size.count<0||size.count>250000)throw Error('Inventory row bound exceeded; preserve containment');
    const [r]=await db.execute(sql.raw(`select count(*)::int as count, sha256(convert_to(coalesce(string_agg(h, '' order by h), ''), 'UTF8'))::text as digest from (select encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')),'hex') h from public.${ident(table)} t) q`));
    result[table]={count:r.count,digest:r.digest};
  }
  return result;
}
function same(a:unknown,b:unknown,message:string){if(hash(a)!==hash(b))throw Error(message);}
function retainedDomains(actual:Record<string,unknown>,baseline:Record<string,unknown>){
  // Reviewed old467->471 adds these domains, with no initial rows. Every old
  // domain stays byte-for-byte equivalent. Never accept an arbitrary new
  // table or silently exclude a domain from the operator's captured baseline.
  const additions=new Set(['github_app_settings','issue_workflow_handoffs']);
  for(const [table,value] of Object.entries(baseline)){
    if(!(table in actual))throw Error('Retained domain baseline differs: '+table);
    same(actual[table],value,'Retained domain baseline differs: '+table);
  }
  for(const [table,value] of Object.entries(actual))if(!(table in baseline)){
    const summary=value as {count?:number;digest?:string};
    if(!additions.has(table)||summary.count!==0||summary.digest!=='\\x'+createHash('sha256').update('').digest('hex'))throw Error('Unreviewed added domain or nonempty schema delta');
  }
}
export async function operate(input:Input){
  const u=new URL(input.databaseUrl);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','[::1]'].includes(u.hostname)||u.search||u.hash||decodeURIComponent(u.pathname.slice(1))!==input.identity.database)
    throw Error('Explicit loopback PostgreSQL identity required');
  if(!['inspect','initialize','guard'].includes(input.mode)||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<0)throw Error('Invalid operation');
  const db=createDb(input.databaseUrl,{maxConnections:1,applicationName:'paperclip-maintenance-offline-v1'});
  try{
    same(await identity(db),input.identity,'Database/instance identity differs');
    if(input.mode==='guard')return await db.transaction(async tx=>{
      await tx.execute(sql`set transaction isolation level repeatable read, read only`);
      same(await identity(tx),input.identity,'Database identity changed');
      const state=await readMaintenance(tx);
      if(state.generation!==input.expectedGeneration||state.state!=='held'||state.continuationPolicy!=='requires_readiness_decision'||state.ownerId!==input.expectedOwnerId)
        throw Error('The protected closed maintenance epoch cannot be verified');
      return {mode:'guard',identity:input.identity,state:'held',generation:state.generation,ownerId:state.ownerId};
    });
    await alone(db);
    const before=await db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read, read only`);await tx.execute(sql`set local time zone 'UTC'`);return retainedInventory(tx);});
    if(input.mode==='inspect'){
      const migration=await inspectMigrations(input.databaseUrl);
      return {mode:'inspect',identity:input.identity,inventory:before,inventoryDigest:hash(before),migration};
    }
    if(!input.baseline||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)||!input.approvalReference?.trim()||!input.operatorNote?.trim())throw Error('Approved exact baseline and stable request identity required');
    retainedDomains(before,input.baseline);
    const pending=await inspectMigrations(input.databaseUrl);
    if(pending.status==='needsMigrations'&&pending.pendingMigrations.some(name=>!/^046[89]_|^047[01]_/.test(name)))throw Error('Unreviewed migration floor; preserve containment');
    await alone(db);
    await applyPendingMigrations(input.databaseUrl);
    if((await inspectMigrations(input.databaseUrl)).status!=='upToDate')throw Error('Migration did not settle');
    same(await identity(db),input.identity,'Database identity changed during migration');
    const afterMigration=await db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read, read only`);await tx.execute(sql`set local time zone 'UTC'`);return retainedInventory(tx);});
    retainedDomains(afterMigration,before);
    await alone(db);
    await startMaintenance(db,{actorId:'offline-root:'+input.approvalReference,requestId:input.requestId,expectedGeneration:input.expectedGeneration,
      operatorNote:input.operatorNote,continuationPolicy:'requires_readiness_decision'});
    await alone(db);
    const state=await reconcileMaintenance(db),blockers=await maintenanceBlockers(db);
    const final=await db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read, read only`);await tx.execute(sql`set local time zone 'UTC'`);return retainedInventory(tx);});
    same(final,afterMigration,'Retained domains changed while closing maintenance; stay contained');
    if(state.state!=='held'||state.generation!==input.expectedGeneration+1||Object.values(blockers).some(n=>n!==0))throw Error('Maintenance remains acquiring; preserve containment and inspect blockers');
    return {mode:'initialize',identity:input.identity,generation:state.generation,ownerId:state.ownerId,state:state.state,policy:state.continuationPolicy,inventory:final,inventoryDigest:hash(final),blockers};
  }finally{await db.$client.end();}
}
