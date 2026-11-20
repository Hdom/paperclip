import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/StatusBadge";
import type { Projection } from "../../../server/src/management/projection";

export function ManagementApp() {
  const [data, setData] = useState<Projection>(); const [error, setError] = useState(false);
  const [path, setPath] = useState(window.location.pathname); const [search, setSearch] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/management/projection", { cache: "no-store", credentials: "same-origin", signal: abort.signal })
      .then(r => { if (!r.ok) throw new Error("unavailable"); return r.json(); }).then(setData).catch(e => { if (e.name !== "AbortError") setError(true); });
    const pop = () => setPath(window.location.pathname); window.addEventListener("popstate", pop);
    return () => { abort.abort(); window.removeEventListener("popstate", pop); };
  }, []);
  function go(next: string) { window.history.pushState(null, "", next); setPath(next); setSearch(""); }
  const prefix = data ? `/${data.company.issuePrefix}` : "";
  const tab = path.startsWith(`${prefix}/projects`) ? "projects" : path.startsWith(`${prefix}/work`) ? "work" : "issues";
  const selectedId = path.split("/")[3];
  const selected = tab === "projects" ? data?.projects.find(p => p.id === selectedId) : tab === "issues" ? data?.issues.find(i => i.identifier === selectedId) : data?.work.find(w => w.id === selectedId);
  const filtered = useMemo(() => data?.[tab].filter(row => Object.values(row).some(value => String(value ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase()))) ?? [], [data, tab, search]);
  const label = (value: string) => value.replaceAll("_", " ");
  function taskLink(id: string) { const issue = data?.issues.find(i => i.id === id); return issue ? <Button variant="link" size="sm" onClick={() => go(`${prefix}/issues/${issue.identifier}`)}>{issue.identifier}</Button> : "—"; }
  if (error) return <main className="p-6"><h1 className="text-xl font-semibold">Management access unavailable</h1><p className="text-muted-foreground">Human authorization or the approved snapshot is unavailable. No live runtime was started.</p></main>;
  if (!data) return <main className="p-6" aria-busy="true">Loading management view…</main>;
  return <div className="min-h-screen bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-3 border-b px-6 py-4"><strong>Paperclip</strong><span className="text-muted-foreground">{data.company.name}</span><Badge variant="secondary">Read only</Badge></header>
    <div className="flex flex-col md:flex-row">
      <nav aria-label="Company navigation" className="flex gap-2 border-b p-4 md:min-h-screen md:flex-col md:border-r md:border-b-0">
        {([['projects', 'Projects'], ['issues', 'Tasks'], ['work', 'Work status']] as const).map(([key, name]) => <Button key={key} variant={key === tab ? "secondary" : "ghost"} onClick={() => go(`${prefix}/${key}`)} aria-current={key === tab ? "page" : undefined}>{name}</Button>)}
      </nav>
      <main className="min-w-0 flex-1 space-y-6 p-6">
        <div><h1 className="text-2xl font-semibold">{tab === "issues" ? "Tasks" : tab === "work" ? "Work status" : "Projects"}</h1><p className="mt-2 text-sm text-muted-foreground">Saved snapshot · <time className="font-mono" dateTime={data.source.capturedAt}>{data.source.capturedAt}</time> · Not live telemetry</p></div>
        <p className="rounded-md border bg-muted p-3 text-sm">Execution remains unavailable. This view cannot edit tasks, retry work, release holds or perform recovery.</p>
        <Input aria-label="Search snapshot" placeholder="Search this snapshot" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">{tab} snapshot</caption><thead className="border-b text-left text-muted-foreground"><tr><th className="p-3 font-medium">{tab === "work" ? "Run" : "Name"}</th><th className="p-3 font-medium">Status</th><th className="p-3 font-medium">{tab === "work" ? "Recovery" : tab === "projects" ? "Tasks" : "Assignee"}</th></tr></thead><tbody>
          {filtered.map(row => {
            const id = "identifier" in row ? row.identifier : row.id;
            const title = "title" in row ? `${row.identifier} · ${row.title}` : "name" in row ? row.name : row.id;
            return <tr key={row.id} className="border-b hover:bg-accent/50"><td className="p-3"><Button variant="link" className="h-auto whitespace-normal px-0 text-left" onClick={() => go(`${prefix}/${tab}/${id}`)}>{title}</Button></td><td className="p-3"><StatusBadge status={row.status} /></td><td className="p-3">{"recoveryStatus" in row ? label(row.recoveryStatus) : "assigneeId" in row ? data.agents.find(a => a.id === row.assigneeId)?.name ?? "Unassigned" : data.issues.filter(i => i.projectId === row.id).length}</td></tr>;
          })}
        </tbody></table>{filtered.length === 0 && <p className="p-6 text-muted-foreground">No matching items in this snapshot.</p>}</div>
        {tab === "work" && <section><h2 className="mb-3 text-lg font-medium">Agents</h2><ul className="space-y-2">{data.agents.map(a => <li key={a.id} className="flex items-center gap-3"><span>{a.name}</span><StatusBadge status={a.status} /></li>)}</ul></section>}
      </main>
    </div>
    <Sheet open={!!selected} onOpenChange={open => { if (!open) go(`${prefix}/${tab}`); }}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>{selected && ("title" in selected ? selected.title : "name" in selected ? selected.name : "Run status")}</SheetTitle><SheetDescription>Saved management fields only. Task content and execution controls are unavailable.</SheetDescription></SheetHeader>
      {selected && <div className="space-y-4 px-4 pb-6"><dl className="space-y-3">{Object.entries(selected).map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{key}</dt><dd className="break-all font-mono text-sm">{value ?? "—"}</dd></div>)}</dl>
        {tab === "projects" && <section><h3 className="font-medium">Tasks</h3>{data.issues.filter(i => i.projectId === selected.id).map(i => <div key={i.id}>{taskLink(i.id)} <span>{i.title}</span></div>)}</section>}
        {tab === "work" && "issueId" in selected && <div>Task {taskLink(selected.issueId)}</div>}
        {tab === "issues" && <section><h3 className="font-medium">Work status</h3>{data.work.filter(w => w.issueId === selected.id).map(w => <div key={w.id}><Button variant="link" onClick={() => go(`${prefix}/work/${w.id}`)}>{w.status} · {label(w.recoveryStatus)}</Button></div>)}</section>}
      </div>}
    </SheetContent></Sheet>
  </div>;
}
