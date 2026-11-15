// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { GitHubProjectAppIdentity, GitHubProjectAppSettings } from "@paperclipai/shared";
import { GitHubAppKeyLifecycle } from "./GitHubAppKeyLifecycle";
const api = vi.hoisted(() => ({ rotate: vi.fn(), activate: vi.fn() }));
vi.mock("@/api/github-project-apps", () => ({ githubProjectAppsApi: api }));
vi.mock("@/components/GitHubProjectAppControls", () => ({ githubProjectAppsQueryKey: (id: string) => ["app-settings", id] }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, client: QueryClient;
const identity: GitHubProjectAppIdentity = { role: "reviewer", agentId: "reviewer", appId: 100, installationId: 200, installationUrl: "https://github.com/settings/installations/200", appUrl: null, login: "synthetic[bot]", status: "verified", message: null, repositories: [], publicFingerprint: null, keyStorage: "native_encrypted", secretId: "key", pinnedVersion: 1, latestVersion: 2, keyStatus: "active" };
const settings: GitHubProjectAppSettings = { available: true, canManage: true, enabled: true, revision: "r1", checkedAt: null, roles: [identity], blockedAgentIds: [] };
async function render(companyId = "company", app = identity, data = settings) { await act(async () => root.render(<StrictMode><QueryClientProvider client={client}><GitHubAppKeyLifecycle companyId={companyId} app={app} settings={data} /></QueryClientProvider></StrictMode>)); }
const button = (text: string) => { const found = [...container.querySelectorAll("button")].find(el => el.textContent === text); if (!found) throw Error(`Missing ${text}`); return found; };
async function click(el: HTMLElement) { await act(async () => el.click()); }
async function choose(text: () => Promise<string>) {
  const file = new File(["synthetic"], "replacement.pem"); Object.defineProperty(file, "text", { value: text }); const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => { Object.defineProperty(input, "files", { value: [file], configurable: true }); input.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(() => { Object.values(api).forEach(mock => mock.mockReset()); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
describe("GitHub App signing-key service lifecycle", () => {
  it("stages a confirmed replacement without activating or retaining key bytes in query/mutation caches", async () => {
    const canary = "synthetic-private-canary"; await render(); await choose(async () => canary); expect(button("Verify replacement").disabled).toBe(true);
    await click(container.querySelector('input[type="checkbox"]')!); api.rotate.mockResolvedValue({ ...settings, roles: [{ ...identity, latestVersion: 3 }] }); await click(button("Verify replacement"));
    expect(api.rotate).toHaveBeenCalledExactlyOnceWith("company", "reviewer", { revision: "r1", confirmed: true, privateKey: canary, expectedLatestVersion: 2 }); expect(api.activate).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(canary); expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(canary); expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("does not send replacement bytes after a company changes while reading the file", async () => {
    let finish!: (value: string) => void; const pending = new Promise<string>(resolve => { finish = resolve; });
    await render(); await choose(() => pending); await click(container.querySelector('input[type="checkbox"]')!); await click(button("Verify replacement"));
    await render("other-company"); await act(async () => { finish("synthetic-private-canary"); await pending; }); expect(api.rotate).not.toHaveBeenCalled(); expect(api.activate).not.toHaveBeenCalled();
  });
  it("does not send replacement bytes after unmounting while reading the file", async () => {
    let finish!: (value: string) => void; const pending = new Promise<string>(resolve => { finish = resolve; });
    await render(); await choose(() => pending); await click(container.querySelector('input[type="checkbox"]')!); await click(button("Verify replacement"));
    await act(async () => root.render(null)); await act(async () => { finish("synthetic-private-canary"); await pending; }); expect(api.rotate).not.toHaveBeenCalled();
  });
  it("does not offer key mutation to a read-only operator", async () => { await render("company", identity, { ...settings, canManage: false }); expect(container.querySelector('input')).toBeNull(); expect(api.rotate).not.toHaveBeenCalled(); });
});
