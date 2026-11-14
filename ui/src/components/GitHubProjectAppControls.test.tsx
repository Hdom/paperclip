// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubProjectAppSettings } from "@paperclipai/shared";
import { GitHubProjectAppManager, ControllerSigningKeysSection, githubProjectAppsQueryKey } from "./GitHubProjectAppControls";
const api = vi.hoisted(() => ({ settings: vi.fn(), configure: vi.fn(), migrate: vi.fn(), verify: vi.fn(), rotate: vi.fn(), activate: vi.fn() }));
const agents = vi.hoisted(() => vi.fn());
vi.mock("@/api/github-project-apps", () => ({ githubProjectAppsApi: api }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: agents } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ids = ["a", "b", "c", "d"];
function settings(native = true): GitHubProjectAppSettings {
  return { available: true, canManage: true, enabled: true, revision: "a".repeat(64), checkedAt: null, blockedAgentIds: [],
    roles: (["coordinator", "implementer", "reviewer"] as const).map((role, i) => ({ role, agentId: ids[i], appId: i + 1,
      installationId: i + 11, installationUrl: `https://github.com/settings/installations/${i+11}`, appUrl: `https://github.com/settings/apps/test-${role}`,
      login: `test-${role}[bot]`, status: "unverified", message: null, repositories: [], publicFingerprint: "SHA256:public-only",
      keyStorage: native ? "native_encrypted" : "legacy_file", secretId: native ? `secret-${role}` : null,
      pinnedVersion: native ? 1 : null, latestVersion: native ? 2 : null, keyStatus: "active" })) };
}
let root: Root, container: HTMLDivElement, client: QueryClient;
function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find(b => b.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function render(data: GitHubProjectAppSettings, secrets = false) {
  api.settings.mockResolvedValue(data); client.setQueryData(githubProjectAppsQueryKey("company"), data);
  await act(async () => { root.render(<QueryClientProvider client={client}>{secrets ? <ControllerSigningKeysSection companyId="company" /> : <GitHubProjectAppManager companyId="company" />}</QueryClientProvider>); });
}
async function checkbox(text: string) {
  const label = [...document.querySelectorAll("label")].find(l => l.textContent?.includes(text));
  if (!label) throw Error(`Missing checkbox ${text}`);
  await click(label.querySelector("input")!);
}
beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset()); agents.mockReset();
  agents.mockResolvedValue(ids.map((id, i) => ({ id, name: `Agent ${i+1}`, status: "idle" })));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
describe("GitHub App operator controls", () => {
  it("hides signing administration and agent queries from users without management access", async () => {
    await render({ ...settings(), canManage: false }, true);
    expect(container.textContent).toBe(""); expect(agents).not.toHaveBeenCalled();
  });
  it("requires review and explicit confirmation before changing assignment or issuance", async () => {
    const data = settings(); await render(data); await click(button("Manage GitHub App"));
    expect(document.body.textContent).toContain("No Administration permission");
    expect(document.body.textContent).toContain("one hour");
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Implementer agent"]')!;
    await act(async () => { await vi.waitFor(() => expect(select.querySelector('option[value="d"]')).not.toBeNull()); });
    await act(async () => { select.value = ids[3]; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await checkbox("Allow App issuance"); await click(button("Review changes"));
    expect(button("Apply confirmed changes").disabled).toBe(true); expect(api.configure).not.toHaveBeenCalled();
    api.configure.mockResolvedValue({ ...data, enabled: false, revision: "b".repeat(64), roles: data.roles.map(row => row.role === "implementer" ? { ...row, agentId: ids[3] } : row) });
    await checkbox("I confirm these GitHub identity changes."); await click(button("Apply confirmed changes"));
    expect(api.configure).toHaveBeenCalledExactlyOnceWith("company", { revision: data.revision, confirmed: true, enabled: false,
      bindings: { coordinator: ids[0], implementer: ids[3], reviewer: ids[2] } });
  });
  it("requires confirmation before native migration and shows native secret lifecycle afterward", async () => {
    const data = settings(false); await render(data, true); await click(button("Manage App signing keys"));
    expect(button("Migrate signing keys to Paperclip Secrets").disabled).toBe(true);
    api.migrate.mockResolvedValue({ ...settings(), revision: "b".repeat(64), migration: { migrated: true, cleanupPending: [] } });
    await checkbox("I confirm migration and verified plaintext cleanup"); await click(button("Migrate signing keys to Paperclip Secrets"));
    expect(api.migrate).toHaveBeenCalledExactlyOnceWith("company", data.revision);
    expect(document.body.textContent).toContain("encrypted native secret");
    expect(document.body.textContent).toContain("cannot be revealed or bound to an agent");
  });
  it("sends replacement key bytes only in the confirmed request and never puts them in UI or query caches", async () => {
    const data = settings(), canary = "synthetic-ui-private-key-canary";
    await render(data); await click(button("Manage GitHub App"));
    const section = [...document.querySelectorAll("section")].find(s => s.querySelector("h3")?.textContent?.startsWith("Implementer"))!;
    const file = new File([canary], "test.pem", { type: "application/x-pem-file" });
    Object.defineProperty(file, "text", { value: async () => canary });
    const input = section.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("Validate and rotate key", section).disabled).toBe(true);
    const confirm = [...section.querySelectorAll("label")].find(l => l.textContent?.includes("I confirm this key/version"))!.querySelector<HTMLInputElement>("input")!;
    api.rotate.mockResolvedValue({ ...data, revision: "b".repeat(64) });
    await click(confirm); await click(button("Validate and rotate key", section));
    expect(api.rotate).toHaveBeenCalledExactlyOnceWith("company", "implementer", { revision: data.revision, confirmed: true, privateKey: canary, expectedLatestVersion: 2 });
    expect(document.body.innerHTML).not.toContain(canary);
    expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(canary);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("does not show raw provider errors when a settings change fails", async () => {
    await render(settings()); await click(button("Manage GitHub App"));
    api.verify.mockRejectedValue(new Error("synthetic-private-material-do-not-render"));
    await click(button("Verify App access"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("The change could not be completed");
    expect(document.body.textContent).not.toContain("synthetic-private-material-do-not-render");
  });
});
