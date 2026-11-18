// Spawned only by the owned, loopback-only maintenance startup qualification.
import { startServer } from "../../index.js";
if(process.env.PAPERCLIP_TEST_MAINTENANCE_STARTUP_ISOLATED!=="1"||!process.send)throw Error("Isolated maintenance startup fixture required");
let notifyRecovery: ((hint:string)=>Promise<void>) | undefined;
const started=await startServer({workspaceRecoveryOwnerReady:notify=>{notifyRecovery=notify;},workspaceRecoveryPass:hints=>{if(process.connected)process.send?.({kind:"recovery_pass",hints:[...hints]});}});
process.send({kind:"ready",port:started.listenPort});
process.on("message",async message=>{
  if(message&&typeof message==='object'&&(message as {kind?:string}).kind==='notify-recovery'){
    const hint=(message as {hint?:string}).hint;
    if(!hint||!/^[a-f0-9-]{36}$/.test(hint)||!notifyRecovery)throw Error('Exact isolated notification request required');
    await notifyRecovery(hint);return;
  }
  if(message!=="stop")return;
  try{await started.shutdown();process.send?.({kind:"stopped"});process.disconnect?.();}
  catch{process.send?.({kind:"stop_failed"});process.exitCode=1;process.disconnect?.();}
});
