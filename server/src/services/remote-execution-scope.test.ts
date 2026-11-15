import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt, remoteTerminationScopeMatches, remoteTerminationScopeSql } from "./remote-execution-termination.js";

const scope={schema:"paperclip.ssh-run-scope.v1",generation:randomUUID(),bootId:randomUUID()};
const cases:Array<{name:string;metadata:Record<string,unknown>;receipt:Record<string,unknown>;valid:boolean}>=[
  {name:"legacy absence",metadata:{},receipt:{},valid:true},
  {name:"exact scope",metadata:{remoteExecutionScope:scope,remoteExecutionScopeRequired:true},receipt:{resourceScope:scope},valid:true},
  {name:"changed generation",metadata:{remoteExecutionScope:scope},receipt:{resourceScope:{...scope,generation:randomUUID()}},valid:false},
  {name:"changed opaque boot identity",metadata:{remoteExecutionScope:scope},receipt:{resourceScope:{...scope,bootId:randomUUID()}},valid:false},
  {name:"scope removed",metadata:{},receipt:{resourceScope:scope},valid:false},
  {name:"receipt scope removed",metadata:{remoteExecutionScope:scope},receipt:{},valid:false},
  {name:"required scope missing",metadata:{remoteExecutionScopeRequired:true},receipt:{},valid:false},
  {name:"numeric required marker",metadata:{remoteExecutionScopeRequired:1,remoteExecutionScope:scope},receipt:{resourceScope:scope},valid:false},
  {name:"false required marker",metadata:{remoteExecutionScopeRequired:false},receipt:{},valid:false},
  ...[null,[],"scope",{schema:"",generation:randomUUID()},{schema:"scope",generation:2},{schema:"scope",generation:"old"},{schema:"😀",generation:randomUUID()}]
    .map((value,index)=>({name:`malformed scope ${index}`,metadata:{remoteExecutionScope:value},receipt:{resourceScope:value},valid:false})),
];
const support=await getEmbeddedPostgresTestSupport();
(support.supported?describe:describe.skip)("opaque termination-scope JavaScript/SQL contract",()=>{
  let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
  beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("scope-proof-");db=createDb(database.connectionString);},90000);
  afterAll(async()=>{await database?.cleanup();});
  it.each(cases)("matches strict scope semantics for $name",async({metadata,receipt,valid})=>{
    expect(remoteTerminationScopeMatches(metadata,receipt)).toBe(valid);
    const rows=await db.execute(sql`SELECT coalesce(${sql.raw(remoteTerminationScopeSql("lease"))},false) AS matches
      FROM (SELECT ${JSON.stringify({...metadata,remoteExecutionTermination:receipt})}::jsonb metadata) lease`);
    expect(rows[0]?.matches).toBe(valid);
    const identity={id:randomUUID(),companyId:randomUUID(),heartbeatRunId:randomUUID(),provider:"ssh",providerLeaseId:"ssh://fixture/work",metadata};
    const canonical=remoteTerminationReceipt(identity,{providerLeaseId:identity.providerLeaseId,state:"stopped",...receipt});
    expect(Boolean(canonical)).toBe(valid);
    if(canonical){
      expect(hasRemoteTerminationReceipt({...identity,releasedAt:new Date(),cleanupStatus:"success",status:"released",metadata:{...metadata,remoteExecutionTermination:canonical}})).toBe(true);
    }
  });
});
