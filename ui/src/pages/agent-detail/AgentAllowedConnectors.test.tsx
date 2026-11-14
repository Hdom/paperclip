// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubProjectAppSettings } from "@paperclipai/shared";
import { AgentAllowedConnectors } from "./AgentAllowedConnectors";
import { githubProjectAppsQueryKey } from "@/components/GitHubProjectAppControls";
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: null, companies: [] }) }));
const api = vi.hoisted(() => ({ settings: vi.fn() }));
vi.mock("@/api/github-project-apps", () => ({ githubProjectAppsApi: api }));
const connectorApi = vi.hoisted(() => ({ getEffectiveProfilesForAgent: vi.fn(), listConnections: vi.fn(), listApplications: vi.fn() }));
vi.mock("@/api/tools", () => ({ toolsApi: connectorApi }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let client: QueryClient, root: Root, container: HTMLDivElement;
function settings(): GitHubProjectAppSettings {
  return { available: true, canManage: true, enabled: true, revision: "a".repeat(64), checkedAt: null, blockedAgentIds: [],
    roles: [{ role: "implementer", agentId: "agent", appId: 11, installationId: 101,
      installationUrl: "https://github.com/settings/installations/101", appUrl: null, login: "fixture-implementer[bot]",
      status: "verified", message: null, repositories: [], publicFingerprint: null, keyStorage: "native_encrypted",
      secretId: "controller-secret", pinnedVersion: 1, latestVersion: 1, keyStatus: "active" }] };
}
async function render(data?: GitHubProjectAppSettings) {
  if (data) { api.settings.mockResolvedValue(data); client.setQueryData(githubProjectAppsQueryKey("company"), data); }
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter>
    <AgentAllowedConnectors companyId="company" agentId="agent" />
  </MemoryRouter></QueryClientProvider>); });
}
beforeEach(() => {
  connectorApi.getEffectiveProfilesForAgent.mockReset().mockResolvedValue({ allowedTools: [] });
  connectorApi.listConnections.mockReset().mockResolvedValue({ connections: [] });
  connectorApi.listApplications.mockReset().mockResolvedValue({ applications: [] });
  api.settings.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
it("makes the assigned App identity manageable in Permissions / Trust's existing connector panel", async () => {
  await render(settings());
  expect(container.textContent).toContain("implementer GitHub App · fixture-implementer[bot]");
  expect(container.textContent).toContain("verified");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Manage GitHub App")).toBe(true);
  expect(container.querySelector('a[href="/apps?source=installed"]')).not.toBeNull();
  expect(container.querySelector('a[href$="/tools"]')).toBeNull();
});

it("shows paused issuance even if the last role verification was successful", async () => {
  await render({ ...settings(), enabled: false });
  expect(container.textContent).toContain("Managed GitHub access paused");
  expect(container.textContent).not.toContain("verified.");
  expect(container.textContent).toContain("Personal GitHub credentials are not substituted");
});
it("keeps former assignments blocked for read-only viewers without an OAuth fallback", async () => {
  await render({ ...settings(), canManage: false, roles: [], blockedAgentIds: ["agent"] });
  expect(container.textContent).toContain("Managed GitHub access paused");
  expect(container.textContent).toContain("Managed by an administrator");
  expect(container.textContent).not.toContain("Connect my GitHub");
  expect(container.textContent).not.toContain("Manage GitHub App");
});
it("shows assigned identity status without management controls to read-only viewers", async () => {
  await render({ ...settings(), canManage: false });
  expect(container.textContent).toContain("fixture-implementer[bot]");
  expect(container.textContent).not.toContain("Manage GitHub App");
  expect(container.textContent).toContain("Managed by an administrator");
});
it("preserves the ordinary connector panel when no App broker is configured", async () => {
  await render({ ...settings(), available: false, roles: [] });
  expect(container.textContent).toContain("Allowed connectors");
  expect(container.querySelector('a[href="/apps?source=installed"]')).not.toBeNull();
  expect(container.querySelector('section[aria-label="GitHub identity"]')).toBeNull();
});
it("lets administrators assign an App without presenting it as verified", async () => {
  await render({ ...settings(), roles: [] });
  expect(container.textContent).toContain("No GitHub App role is assigned");
  expect(container.textContent).toContain("Use a GitHub App");
  expect(container.textContent).not.toContain("verified");
});
it("does not imply verification or fallback while App status is loading", async () => {
  api.settings.mockReturnValue(new Promise(() => {}));
  await render();
  expect(container.textContent).toContain("Checking GitHub App identity");
  expect(container.textContent).not.toContain("verified");
  expect(container.textContent).not.toContain("Connect my GitHub");
});
it("retries App status independently from failed ordinary connector requests", async () => {
  connectorApi.getEffectiveProfilesForAgent.mockRejectedValue(new Error("fixture connector failure"));
  api.settings.mockRejectedValueOnce(new Error("fixture App status failure")).mockResolvedValueOnce(settings());
  await render();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.textContent).toContain("Could not load GitHub App identity");
  expect(container.textContent).not.toContain("verified");
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry GitHub App status")!;
  await act(async () => { retry.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.textContent).toContain("fixture-implementer[bot]");
  expect(container.textContent).toContain("Couldn’t load this agent’s connectors");
  expect(api.settings).toHaveBeenCalledTimes(2);
});
