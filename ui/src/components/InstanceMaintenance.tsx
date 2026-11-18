import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { maintenanceApi, type MaintenanceRequestReceipt } from "@/api/maintenance";
import { ApiError } from "@/api/client";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Link } from "@/lib/router";
import { useAccountIdentity } from "@/api/companies-query";

const key = ["instance-maintenance"] as const;
export function InstanceMaintenance({ task = false }: { task?: boolean }) {
  const client = useQueryClient();
  const account = useAccountIdentity();
  const query = useQuery({ queryKey: [...key, account.userId, task ? "task" : "admin"], queryFn: () => maintenanceApi.status(task), enabled: account.settled, retry: false });
  const [dialog, setDialog] = useState<"start" | "release" | "saved" | "recover" | null>(null);
  const [recoveryRequestId, setRecoveryRequestId] = useState<string | null>(null);
  const requestIds=useRef(new Map<string,string>());
  const originalRequest=useRef<string|null>(null);
  const [receipt,setReceipt]=useState<MaintenanceRequestReceipt|null>(null);
  const [uncertain,setUncertain]=useState(false);
  const checkOriginal=async()=>{
    if(!originalRequest.current)return;
    try {setReceipt(await maintenanceApi.receipt(originalRequest.current));setUncertain(false);}
    catch {setUncertain(true);}
  };
  const [note, setNote] = useState("");
  useEffect(()=>{setDialog(null);setNote("");setReceipt(null);setUncertain(false);originalRequest.current=null;requestIds.current.clear();},[account.userId]);
  const mutation = useMutation({ mutationFn: async (action: "start" | "release" | "recover") => {
    const state = query.data;
    if (!state?.canManage || query.isError || query.isFetching) throw Error("Refresh maintenance before continuing.");
    const scope=JSON.stringify({action,generation:state.generation,ownerId:state.admin?.ownerId,
      note:action==="start"?note:null,source:action==="recover"?state.admin?.savedWork.filter(wake=>wake.requestId===recoveryRequestId).map(wake=>({companyId:wake.companyId,issueId:wake.issueId,...wake.recovery})):null});
    const requestId=requestIds.current.get(scope)??crypto.randomUUID();requestIds.current.set(scope,requestId);
    originalRequest.current=requestId;setReceipt(null);setUncertain(false);
    if (action === "start") await maintenanceApi.start({ requestId, expectedGeneration: state.generation, operatorNote: note });
    else if (action === "recover") {
      const source = state.admin?.savedWork.find(wake => wake.requestId === recoveryRequestId);
      if (!source?.issueId || !source.recovery || !state.admin?.ownerId || state.state !== "held") throw Error("The exact recovery source changed. Refresh before continuing.");
      await maintenanceApi.recover({requestId,generation:state.generation,ownerId:state.admin.ownerId,
        companyId:source.companyId,issueId:source.issueId,...source.recovery});
    } else {
      if (!state.admin?.ownerId || !state.admin.releaseReview) throw Error("The current resumption review is unavailable. Refresh before acting.");
      await maintenanceApi.release({ requestId, generation: state.generation, ownerId: state.admin.ownerId, reviewFingerprint: state.admin.releaseReview.fingerprint });
    }
  }, onSuccess: async () => { setDialog(null); setNote(""); await client.invalidateQueries({ queryKey: key }); },
  onError: async error => {
    const body=error instanceof ApiError ? error.body as {details?:{code?:string;requestId?:string}} : null;
    if(body?.details?.code==="maintenance_recovery_request_exists" && /^[a-f0-9-]{36}$/i.test(body.details.requestId??""))
      originalRequest.current=body.details.requestId!;
    setUncertain(true);await checkOriginal();await client.invalidateQueries({ queryKey: key });
  } });
  const state = query.data;
  if (task && (!state && !query.isError || state?.state === "released" && !query.isError)) return null;
  const stale = query.isError || query.isFetching || !state;
  const canManage = Boolean(state?.canManage && !task && !stale);
  const closed = state?.state !== "released";
  const pending = state?.admin?.savedWork ?? [];
  const releaseBlocked = state?.admin && !state.admin.releaseReview ? "The current resumption review is unavailable. Refresh before acting." : state?.admin?.releaseReview?.blockedReason ?? ((state?.admin?.releaseReview?.savedIntentCount ?? 0)>pending.length ? "The saved-work inventory exceeds this view. Resumption requires a complete operator inventory review." : null);
  const selectedRecovery = pending.find(wake => wake.requestId === recoveryRequestId);
  const originalAccepted=Boolean(receipt?.found);
  const activeRecovery = (state?.admin?.activeRecoveries ?? 0) > 0;
  const blockers = state?.admin?.blockers;
  const unsettled = blockers ? Object.values(blockers).reduce((a, b) => a + b, 0) : null;
  const label = query.isError ? "Connection required" : !state ? "Loading" : state.state === "released" ? "Off" : state.state === "acquiring" ? "Waiting for settlement" : "Held";
  return <section id="maintenance" className="space-y-3 scroll-mt-6" aria-label="Maintenance">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1.5">
        <h2 className="text-sm font-semibold">Maintenance <span className="text-xs font-normal text-muted-foreground">{label}</span></h2>
        <p className="text-sm text-muted-foreground">{query.isError ? "The current maintenance state cannot be confirmed. Reconnect before acting." : !state ? "Loading maintenance status." : task ? "Maintenance temporarily holds new agent work. Saved work is preserved." : closed ? "New agent work and automatic workspace recovery remain held across restarts. Saved work and company settings are preserved." : "New work follows normal task, permission and recovery gates."}</p>
      </div>
      {!task && <Button variant="outline" disabled={!canManage || mutation.isPending} onClick={() => {setReceipt(null);setUncertain(false);setDialog(closed ? "release" : "start");}}>{!state?.canManage ? "Instance administrator required" : closed ? "Review resumption" : "Start maintenance"}</Button>}
    </div>
    {!task && <p className="text-sm text-muted-foreground">Applies to all companies on this instance. Only instance administrators can change maintenance.</p>}
    {canManage && closed && state?.admin && <>
      <p className="text-sm">Private operator note · {state.admin.operatorNote}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm"><dt>Execution admission</dt><dd>Closed</dd><dt>Automatic recovery</dt><dd>{activeRecovery ? "Exact approved source only" : "Closed"}</dd><dt>In-flight operations</dt><dd>{activeRecovery ? "Approved recovery in progress" : state.state === "held" && unsettled === 0 ? "Settled and verified" : `${unsettled ?? "Unknown"} still unsettled`}</dd><dt>Release</dt><dd>Explicit review required · No automatic expiry</dd></dl>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setDialog("saved")}>View saved work</Button><Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh progress</Button></div>
    </>}
    {task && <Link className="text-sm underline" to="/company/settings#maintenance">View maintenance</Link>}
    {query.isError && <Button variant="outline" onClick={() => void query.refetch()}>Reconnect</Button>}
    {mutation.error && <p role="alert" className="text-sm text-destructive">{describeError(mutation.error).body}</p>}
    <Dialog open={dialog !== null && Boolean(state?.canManage) && !task} onOpenChange={open => { if (!open && !mutation.isPending) setDialog(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{dialog === "start" ? "Start maintenance" : dialog === "saved" ? "Saved work" : dialog === "recover" ? "Review exact-source recovery" : "Review resumption"}</DialogTitle><DialogDescription>{dialog === "start" ? "Hold new runs and automatic workspace recovery for every company. Existing stop and settlement work may finish. Saved work is preserved. Maintenance has no automatic expiry." : "Maintenance does not replay stopped runs or discard saved review and Retry requests."}</DialogDescription></DialogHeader>
        {dialog === "start" && <label className="space-y-2 text-sm">Private operator note<Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Visible only to instance administrators" maxLength={2000} /></label>}
        {dialog === "saved" && <div className="space-y-3">{pending.length ? pending.map(wake => <div className="flex flex-wrap items-center justify-between gap-2 text-sm" key={wake.requestId}><div className="min-w-0 space-y-1">{wake.issueId ? <Link className="underline" to={`/issues/${wake.issueId}`}>{wake.identifier ?? "Open saved task"}</Link> : <span>Saved agent wake</span>}<p className="break-all text-xs text-muted-foreground">{wake.requestId} · {wake.status}</p></div>{wake.recovery && <Button variant="outline" disabled={!canManage || activeRecovery || state?.state !== "held" || unsettled !== 0} onClick={() => {setReceipt(null);setUncertain(false);setRecoveryRequestId(wake.requestId);setDialog("recover");}}>Review recovery request</Button>}</div>) : <p className="text-sm">No saved work was found in this view.</p>}</div>}
        {dialog === "recover" && <div className="space-y-3 text-sm"><p>Preserve and canonically recover only this original source. New execution, other recovery and both saved wakes stay held.</p><dl className="space-y-2 font-mono break-all"><dt>Task</dt><dd>{selectedRecovery?.identifier ?? selectedRecovery?.issueId}</dd><dt>Source run</dt><dd>{selectedRecovery?.recovery?.runId}</dd><dt>Recovery action</dt><dd>{selectedRecovery?.recovery?.actionId}</dd></dl><p>The backend revalidates the maintenance generation, original lease, stop receipt, source ownership and snapshot evidence. This grants no new repository or filesystem access.</p></div>}
        {dialog === "release" && <p className="text-sm">{releaseBlocked ?? (pending.length ? "Ending maintenance permits the saved work shown in this review to pass through normal admission checks. The backend revalidates this exact inventory and its task and source bindings. Permission, ownership, dependency and approval gates still apply." : "Ending maintenance permits normal admission and recovery checks. All current permission, ownership, dependency and approval gates still apply.")}</p>}
        {mutation.error && <p role="alert" className="text-sm text-destructive">{describeError(mutation.error).body}</p>}
        {(uncertain||receipt) && <div className="space-y-2 text-sm"><p>{uncertain ? "The original request outcome is uncertain. Check its receipt before acting." : receipt?.found ? `Original request ${receipt.state}. Settlement confirms a joined operation, not permission to continue the task.` : "No original receipt was found. Retry retains the same request identity."}</p><Button variant="outline" onClick={()=>void checkOriginal()}>Check original request</Button></div>}
        {stale && <p role="alert" className="text-sm text-destructive">Refresh the current maintenance state before acting.</p>}
        <DialogFooter className="flex-row justify-between"><Button variant="ghost" disabled={mutation.isPending} onClick={() => setDialog(null)}>Close</Button>{dialog !== "saved" && <Button disabled={!canManage || mutation.isPending || uncertain || originalAccepted || (dialog === "start" ? !note.trim() : dialog === "recover" ? !selectedRecovery?.recovery || activeRecovery || unsettled !== 0 : state?.state !== "held" || unsettled !== 0 || Boolean(releaseBlocked))} onClick={() => mutation.mutate(dialog === "start" ? "start" : dialog === "recover" ? "recover" : "release")}>{dialog === "start" ? "Start maintenance" : dialog === "recover" ? "Recover exact source" : releaseBlocked ? "Resumption unavailable" : "End maintenance"}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
