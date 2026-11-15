// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubProjectAppSettings, ToolConnection } from "@paperclipai/shared";
import { AgentAllowedConnectors } from "./AgentAllowedConnectors";
import { githubProjectAppsQueryKey } from "@/components/GitHubProjectAppControls";
import { queryKeys } from "@/lib/queryKeys";
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: null, companies: [] }) }));
const api = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock("@/api/github-project-apps", () => ({ githubProjectAppsApi: api }));
const connectors = vi.hoisted(() => ({ getEffectiveProfilesForAgent: vi.fn(), listConnections: vi.fn(), listApplications: vi.fn() }));
vi.mock("@/api/tools", () => ({ toolsApi: connectors }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let client: QueryClient, root: Root, container: HTMLDivElement;
const connection = { id: "native-connection", name: "GitHub · Implementer", authKind: "github_app", enabled: true,
  config: { sourceTemplateKey: "github", githubApp: { role: "implementer" } } } as unknown as ToolConnection;
function settings(): GitHubProjectAppSettings {
  return { available: true, canManage: true, enabled: true, revision: "a".repeat(64), checkedAt: null, blockedAgentIds: [],
    roles: [{ role: "implementer", agentId: "agent", connectionId: connection.id, appId: 11, installationId: 101,
      installationUrl: "https://github.com/settings/installations/101", appUrl: null, login: "fixture-implementer[bot]",
      status: "verified", message: null, repositories: [], publicFingerprint: null, keyStorage: "native_encrypted",
      secretId: "protected-secret-reference", pinnedVersion: 1, latestVersion: 1, keyStatus: "active" }] };
}
async function render(data?: GitHubProjectAppSettings, installed = true, connectionsFail = false) {
  const effective = { allowedTools: [], installedConnections: installed ? [connection] : [] };
  client.setQueryData(queryKeys.tools.effectiveProfilesForAgent("company", "agent"), effective);
  client.setQueryData(queryKeys.tools.applications("company"), { applications: [] });
  if (!connectionsFail) client.setQueryData(queryKeys.tools.connections("company"), { connections: installed ? [connection] : [] });
  if (data) { api.settings.mockResolvedValue(data); client.setQueryData(githubProjectAppsQueryKey("company"), data); }
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><AgentAllowedConnectors companyId="company" agentId="agent" /></MemoryRouter></QueryClientProvider>); });
}
beforeEach(() => {
  Object.values(connectors).forEach(mock => mock.mockReset()); api.settings.mockReset();
  connectors.getEffectiveProfilesForAgent.mockResolvedValue({ allowedTools: [], installedConnections: [] });
  connectors.listConnections.mockResolvedValue({ connections: [] }); connectors.listApplications.mockResolvedValue({ applications: [] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

it("shows the native GitHub connection and its identity without contradictory empty-tool copy", async () => {
  await render(settings());
  expect(container.textContent).toContain("GitHub · Implementer"); expect(container.textContent).toContain("fixture-implementer[bot]");
  expect(container.textContent).toContain("verified"); expect(container.textContent).toContain("API actions follow connector permissions");
  expect(container.textContent).not.toContain("No connector tools are allowed yet");
  expect(container.querySelector('a[href="/apps/native-connection/permissions"]')).not.toBeNull();
  expect(container.querySelector('a[href$="/tools"]')).toBeNull();
});
it("shows paused issuance even when last identity verification succeeded", async () => {
  await render({ ...settings(), enabled: false }); expect(container.textContent).toContain("Managed GitHub access paused");
});
it("keeps former assignments visibly blocked without presenting an allowed connection or user fallback", async () => {
  await render({ ...settings(), canManage: false, roles: [], blockedAgentIds: ["agent"] }, false);
  expect(container.textContent).toContain("Managed GitHub access paused");
  expect(container.textContent).toContain("personal GitHub credentials are not substituted");
  expect(container.querySelector('a[href="/apps/native-connection/permissions"]')).toBeNull();
  expect(container.textContent).not.toContain("Connect my GitHub");
});
it("shows metadata and a connection link to read-only viewers without secret references or mutation controls", async () => {
  await render({ ...settings(), canManage: false });
  expect(container.textContent).toContain("fixture-implementer[bot]");
  expect(container.textContent).not.toContain("protected-secret-reference");
  expect(container.textContent).not.toContain("Manage GitHub App");
});
it("preserves the ordinary empty connector state when no App connection is installed", async () => {
  await render({ ...settings(), available: false, roles: [] }, false);
  expect(container.textContent).toContain("No connector tools are allowed yet");
  expect(container.querySelector('a[href="/apps?source=installed"]')).not.toBeNull();
});
it("does not manufacture an allowed identity from standalone App configuration", async () => {
  await render(settings(), false);
  expect(container.textContent).not.toContain("fixture-implementer[bot]");
  expect(container.querySelector('a[href="/apps/native-connection/permissions"]')).toBeNull();
});
it("does not imply verification or user fallback while identity metadata is loading", async () => {
  api.settings.mockReturnValue(new Promise(() => {})); await render();
  expect(container.textContent).toContain("Checking identity"); expect(container.textContent).not.toContain("verified");
  expect(container.textContent).not.toContain("Connect my GitHub");
});
it("retries identity metadata independently while retaining an ordinary connector error", async () => {
  connectors.listConnections.mockRejectedValue(new Error("Synthetic connector failure"));
  api.settings.mockRejectedValueOnce(new Error("Synthetic status failure")).mockResolvedValueOnce(settings());
  await render(undefined, true, true);
  await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Could not load GitHub identity status")); });
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry GitHub status")!;
  await act(async () => { retry.click(); await vi.waitFor(() => expect(container.textContent).toContain("fixture-implementer[bot]")); });
  expect(container.textContent).toContain("Couldn’t load this agent’s connectors"); expect(api.settings).toHaveBeenCalledTimes(2);
});
