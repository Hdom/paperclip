/** Canonical SQL-only stop proof, shared by live and offline readiness. */
export function remoteTerminationScopeSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Fixed SQL alias required");
  const metadata = `coalesce(${alias}.metadata, '{}'::jsonb)`;
  const receipt = `coalesce(${alias}.metadata->'remoteExecutionTermination', '{}'::jsonb)`;
  const scope = `${metadata}->'remoteExecutionScope'`;
  return `((NOT (${metadata} ? 'remoteExecutionScopeRequired') OR ${metadata}->'remoteExecutionScopeRequired' = 'true'::jsonb)
    AND ((NOT (${metadata} ? 'remoteExecutionScope') AND NOT (${receipt} ? 'resourceScope')
      AND NOT (${metadata} ? 'remoteExecutionScopeRequired'))
    OR (${metadata} ? 'remoteExecutionScope' AND ${receipt} ? 'resourceScope'
      AND jsonb_typeof(${scope}) = 'object' AND jsonb_typeof(${scope}->'schema') = 'string'
      AND ${scope}->>'schema' ~ '^[a-zA-Z0-9_.:/-]{1,128}$' AND jsonb_typeof(${scope}->'generation') = 'string'
      AND ${scope}->>'generation' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND ${scope} = ${receipt}->'resourceScope'))) `;
}

/** Fixed SQL aliases only. Never infer physical stop from status or expiry. */
export function remoteTerminationReceiptSql(alias: string): string {
  const scope = remoteTerminationScopeSql(alias);
  const receipt = `${alias}.metadata->'remoteExecutionTermination'`;
  return `coalesce(${alias}.released_at is not null and ${alias}.cleanup_status = 'success'
    and ${alias}.status in ('released', 'expired', 'failed')
    and ${alias}.heartbeat_run_id is not null and ${alias}.provider is not null and ${alias}.provider <> 'local'
    and ${alias}.provider_lease_id is not null and ${alias}.provider_lease_id <> ''
    and ${receipt}->>'schema' = 'paperclip.remote-termination.v1'
    and ${receipt}->>'companyId' = ${alias}.company_id::text
    and ${receipt}->>'runId' = ${alias}.heartbeat_run_id::text
    and ${receipt}->>'leaseId' = ${alias}.id::text
    and ${receipt}->>'provider' = ${alias}.provider
    and ${receipt}->>'providerLeaseId' = ${alias}.provider_lease_id
    and ${receipt}->>'state' in ('stopped', 'destroyed') and ${scope}, false)`;
}
