// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { GitHubProjectAppSettings } from "@paperclipai/shared";
import { GitHubAppConnectionPermissions } from "./GitHubAppConnectionPermissions";
const mocks = vi.hoisted(() => ({ configure: vi.fn(), verify: vi.fn(), agents: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("@/api/github-project-apps", () => ({ githubProjectAppsApi: mocks }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => <a href={to} {...props}>{children}</a> }));
vi.mock("@/components/GitHubProjectAppControls", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return { githubProjectAppsQueryKey: (companyId: string) => ["app-settings", companyId],
    useGitHubProjectApps: (companyId: string) => useQuery({ queryKey: ["app-settings", companyId], queryFn: async () => { throw Error("Unexpected network"); } }) };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, client: QueryClient;
function fixture(): GitHubProjectAppSettings {
  return { available: true, canManage: true, enabled: true, revision: "r1", checkedAt: null, blockedAgentIds: ["former"],
    roles: (["coordinator", "implementer", "reviewer"] as const).map((role, index) => ({ role, agentId: role, connectionId: `connection-${role}`, appId: 100 + index, installationId: 200 + index,
      installationUrl: `https://github.com/settings/installations/${200 + index}`, appUrl: null, login: `${role}[bot]`, status: "verified", message: null, repositories: [], publicFingerprint: null,
      keyStorage: "native_encrypted", secretId: `key-${role}`, pinnedVersion: 1, latestVersion: 2, keyStatus: "active" })) };
}
async function render(data = fixture(), role = "coordinator") {
  client.setQueryData(["app-settings", "company"], data);
  await act(async () => root.render(<QueryClientProvider client={client}><GitHubAppConnectionPermissions companyId="company" connectionId={`connection-${role}`} /></QueryClientProvider>));
}
const button = (text: string) => { const found = [...container.querySelectorAll("button")].find(el => el.textContent === text); if (!found) throw Error(`Missing ${text}`); return found; };
async function click(el: HTMLElement) { await act(async () => el.click()); }
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.agents.mockResolvedValue(["coordinator", "implementer", "reviewer", "former"].map(id => ({ id, name: id, status: "paused" }))); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
describe("GitHub App connection access controls", () => {
  it("requires explicit revision-bound confirmation before pausing all three identities", async () => {
    await render(); await click(button("Pause issuance…")); expect(button("Apply access change").disabled).toBe(true); expect(mocks.configure).not.toHaveBeenCalled();
    await click(container.querySelector('input[type="checkbox"]')!); mocks.configure.mockResolvedValue({ ...fixture(), enabled: false, revision: "r2" }); await click(button("Apply access change"));
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith("company", { revision: "r1", confirmed: true, enabled: false });
    expect(container.textContent).toContain("Tokens already delivered remain valid");
  });
  it("invalidates access-change consent when verified settings refresh", async () => {
    await render(); await click(button("Pause issuance…")); await click(container.querySelector('input[type="checkbox"]')!);
    await act(async () => { client.setQueryData(["app-settings", "company"], { ...fixture(), revision: "r2" }); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.textContent).not.toContain("Apply access change"); expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("reviews restoration of a former agent's credential rules separately from assignment", async () => {
    await render(); await click(button("Restore ordinary GitHub access…")); expect(container.textContent).toContain("Pause and drain it first");
    await click(container.querySelector('input[type="checkbox"]')!); mocks.configure.mockResolvedValue({ ...fixture(), blockedAgentIds: [], revision: "r2" }); await click(button("Apply access change"));
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith("company", { revision: "r1", confirmed: true, releaseAgentId: "former" });
  });
  it("offers read-only metadata to operators without configuration authority", async () => {
    await render({ ...fixture(), canManage: false }); expect(container.textContent).toContain("coordinator[bot]");
    expect(container.querySelector('select')).toBeNull(); expect(container.textContent).not.toContain("Pause issuance…"); expect(container.textContent).not.toContain("Restore ordinary GitHub access…");
  });
  it("uses the Coordinator connection for shared lifecycle and separates tools from Git/gh", async () => {
    await render(fixture(), "reviewer"); expect(container.querySelector('a[href="/apps/connection-coordinator/permissions"]')).not.toBeNull();
    expect(container.textContent).toContain("Git and gh"); expect(container.textContent).toContain("GitHub API tools · Review actions below"); expect(container.textContent).not.toContain("Pause issuance…");
  });
});
