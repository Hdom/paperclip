import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GitHubProjectAppIdentity, GitHubProjectAppSettings } from "@paperclipai/shared";
import { githubProjectAppsApi } from "@/api/github-project-apps";
import { githubProjectAppsQueryKey } from "@/components/GitHubProjectAppControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A single consuming service's verified lifecycle; never an all-Apps management dialog. */
export function GitHubAppKeyLifecycle({ companyId, app, settings }: {
  companyId: string; app: GitHubProjectAppIdentity; settings: GitHubProjectAppSettings;
}) {
  const client = useQueryClient();
  const [file, setFile] = useState<File>();
  const [version, setVersion] = useState(app.pinnedVersion ?? 1);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = JSON.stringify([companyId, settings.revision, app.role, app.appId, app.installationId, app.secretId,
    app.pinnedVersion, app.latestVersion, app.keyStatus, version, file?.name, file?.size, file?.lastModified]);
  const confirmed = identity === confirmation;
  const currentReview = useRef<string | null>(identity); currentReview.current = identity;
  useEffect(() => { currentReview.current = identity; return () => { currentReview.current = null; }; }, [identity]);
  useEffect(() => { setFile(undefined); setConfirmation(null); setVersion(app.pinnedVersion ?? 1); setError(null); },
    [companyId, settings.revision, app.role, app.appId, app.installationId, app.secretId, app.pinnedVersion, app.latestVersion, app.keyStatus]);
  async function change(operation: () => Promise<GitHubProjectAppSettings>) {
    if (!confirmed || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await operation();
      client.setQueryData(githubProjectAppsQueryKey(companyId), result);
      await client.invalidateQueries({ queryKey: ["signing-keys", companyId] });
      await client.invalidateQueries({ queryKey: ["signing-key-versions", companyId, app.secretId] });
      setFile(undefined); setConfirmation(null);
    } catch { setError("Could not confirm the key change. Refresh the connection before retrying and check the displayed active version."); }
    finally { setBusy(false); setConfirmation(null); }
  }
  if (!settings.canManage) return <p className="text-sm text-muted-foreground">Key changes require an administrator with connection management access.</p>;
  return <section aria-label="GitHub signing key lifecycle" className="flex flex-col gap-3">
    <h3 className="text-sm font-medium">Replace signing key</h3>
    <p className="text-xs text-muted-foreground">Generate the replacement in this App’s GitHub settings. Paperclip verifies and stores it before you activate the new version.</p>
    <label className="flex flex-col gap-1 text-sm">Replacement private key file
      <Input key={`${app.secretId}-${app.latestVersion}`} type="file" accept=".pem" disabled={busy} aria-label="Replacement GitHub App signing key"
        onChange={event => { const next = event.target.files?.[0]; setFile(next && next.size <= 16384 ? next : undefined); setConfirmation(null); setError(next && next.size > 16384 ? "Key files must be no larger than 16 KiB." : null); }} />
    </label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy}
      onChange={event => setConfirmation(event.target.checked ? identity : null)} />I confirm this key/version change for the {app.role} App.</label>
    <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Active v{app.pinnedVersion} · latest stored v{app.latestVersion}</span>
      <Button disabled={busy || !confirmed || !file || !app.latestVersion} onClick={() => void change(async () => {
        const authorized = identity;
        const privateKey = await file!.text();
        if (currentReview.current !== authorized) throw new Error("Signing key review changed");
        return githubProjectAppsApi.rotate(companyId, app.role, { revision: settings.revision, confirmed: true, privateKey, expectedLatestVersion: app.latestVersion! });
      })}>Verify replacement</Button></div>
    <label className="flex flex-col gap-1 text-sm">Version to activate
      <Input aria-label="Signing key version to activate" type="number" min={1} max={app.latestVersion ?? undefined} value={version} disabled={busy}
        onChange={event => { setVersion(Number(event.target.value)); setConfirmation(null); }} />
    </label>
    <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Activation verifies this version again. Revoke old keys separately in GitHub after cutover.</p>
      <Button variant="outline" disabled={busy || !confirmed || !Number.isSafeInteger(version) || version < 1 || version > (app.latestVersion ?? 0) || version === app.pinnedVersion}
        onClick={() => void change(() => githubProjectAppsApi.activate(companyId, app.role, { revision: settings.revision, confirmed: true, version }))}>Verify and activate version</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
