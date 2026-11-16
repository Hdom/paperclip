// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { SigningKeySummary } from "@paperclipai/shared";
import { SigningKeysTab } from "./SigningKeysTab";
const api = vi.hoisted(() => ({ list: vi.fn(), versions: vi.fn(), create: vi.fn(), rotate: vi.fn(), update: vi.fn(), organize: vi.fn(), events: vi.fn() }));
vi.mock("@/lib/router", async () => ({ useSearchParams: (await import("react-router-dom")).useSearchParams,
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => <a href={to} {...props}>{children}</a> }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/api/signing-keys", () => ({ signingKeysApi: api }));
vi.mock("@/components/GitHubProjectAppControls", () => ({
  githubProjectAppsQueryKey: (companyId: string) => ["github-project-apps", companyId],
  useGitHubProjectApps: () => ({ data: { canManage: false, roles: [{ secretId: "github", role: "reviewer", connectionId: "native-github", pinnedVersion: 1, status: "verified", publicFingerprint: "SHA256:public-only" }] } }),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, client: QueryClient;
const key = (overrides: Partial<SigningKeySummary> = {}): SigningKeySummary => ({ id: "generic", name: "Service signer", description: "Synthetic signing key", status: "active", type: "generic", algorithm: "ed25519", publicFingerprint: "SHA256:public-only", latestVersion: 2, revision: 3, folderPath: null, canOrganize: true, githubApp: null, createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:00:00Z", ...overrides });
function SelectedTab({ companyId }: { companyId: string }) { const [params, setParams] = useSearchParams(); return <SigningKeysTab companyId={companyId} selection={params.get("signingKey")} onSelectionChange={id => setParams(prev => { const next = new URLSearchParams(prev); if (id) next.set("signingKey", id); else next.delete("signingKey"); return next; })} />; }
async function render(keys: SigningKeySummary[], canManage = true, companyId = "company") {
  const data = { keys, canManage }; api.list.mockResolvedValue(data); client.setQueryData(["signing-keys", companyId], data);
  await act(async () => { root.render(<MemoryRouter><QueryClientProvider client={client}><SelectedTab companyId={companyId} /></QueryClientProvider></MemoryRouter>); });
}
const button = (text: string, scope: ParentNode = document) => { const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === text); if (!found) throw Error(`Missing ${text}`); return found; };
async function click(el: HTMLElement) { await act(async () => el.click()); }
async function openKey(name = "Service signer") { const row = [...container.querySelectorAll<HTMLElement>('[role="row"]')].find(el => el.textContent?.includes(name)); expect(row).toBeTruthy(); await click(row!); }
async function confirm() { await click([...document.querySelectorAll("label")].find(el => el.textContent?.includes("I confirm"))!.querySelector("input")!); }
function dialog() { return document.querySelector('[data-slot="dialog-content"]')!; }
async function inputValue(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function menuAction(text: string) { const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')!; await act(async () => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }))); await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === text)!); }
beforeEach(() => { localStorage.clear(); Object.values(api).forEach(mock => mock.mockReset()); api.versions.mockResolvedValue([{ id: "v2", version: 2, status: "current", createdAt: "2026-11-14T10:00:00Z" }]); api.events.mockResolvedValue([]); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); document.body.innerHTML = ""; });
describe("Secrets signing-key collection", () => {
  it("uses the same canonical controls, responsive rows and read-only details as Secrets", async () => {
    await render([key()]); expect(container.querySelector('[role="table"][aria-label="Signing keys"]')).not.toBeNull();
    expect(container.querySelector('[data-canonical-toolbar="secrets"] [data-toolbar-primary]')?.textContent).toContain("New signing key");
    expect(container.querySelector('[data-testid="signing-keys-card-view"]')).not.toBeNull();
    await openKey(); expect(document.body.textContent).toContain("Paperclip use only"); expect(document.body.textContent).toContain("ED25519");
    expect(document.body.textContent).not.toMatch(/controller|reveal key|export key/i);
    expect(document.body.textContent).toContain("Private values stay in encrypted storage");
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
  it("offers metadata reads without write controls for non-administrators", async () => {
    await render([key()], false); expect(container.textContent).not.toContain("New signing key"); await openKey();
    expect(document.querySelector('input[type="file"]')).toBeNull(); expect(document.body.textContent).not.toContain("Rotate key");
  });
  it("keeps GitHub rotation in its service lifecycle and shows pinned versus stored versions", async () => {
    await render([key({ id: "github", name: "GitHub signer", type: "github_app", revision: null, algorithm: null, publicFingerprint: null, githubApp: { role: "reviewer", appId: 13 } })]);
    await openKey("GitHub signer"); expect(document.body.textContent).toContain("Active connection versionv1"); expect(document.body.textContent).toContain("Latest stored versionv2");
    await click(button("View usage")); expect(document.querySelector('a[href="/apps/native-github/permissions"]')).not.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull(); expect(document.body.textContent).not.toContain("Disable key");
  });
  it("requires explicit action and current consent for a generic status change", async () => {
    await render([key()]); await menuAction("Disable key…"); expect(button("Confirm status change", dialog()).disabled).toBe(true);
    api.update.mockResolvedValue(key({ status: "disabled", revision: 4 })); await confirm(); await click(button("Confirm status change", dialog()));
    expect(api.update).toHaveBeenCalledExactlyOnceWith("company", "generic", { status: "disabled", expectedLatestVersion: 2, expectedRevision: 3, confirmed: true });
  });
  it("sends replacement bytes only after confirmation and never caches or renders them", async () => {
    const canary = "synthetic-signing-private-value"; await render([key()]); await openKey(); await click(button("Rotate key"));
    const file = new File([canary], "key.pem"); Object.defineProperty(file, "text", { value: async () => canary });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { Object.defineProperty(input, "files", { value: [file], configurable: true }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("Rotate key", dialog()).disabled).toBe(true); expect(api.rotate).not.toHaveBeenCalled();
    api.rotate.mockResolvedValue(key({ latestVersion: 3, revision: 4 })); await confirm(); await click(button("Rotate key", dialog()));
    expect(api.rotate).toHaveBeenCalledExactlyOnceWith("company", "generic", { privateKey: canary, expectedLatestVersion: 2, expectedRevision: 3, confirmed: true });
    expect(document.body.innerHTML).not.toContain(canary); expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(canary); expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("does not render raw server errors", async () => {
    await render([key()]); await menuAction("Disable key…"); api.update.mockRejectedValue(new Error("private-error-canary"));
    await confirm(); await click(button("Confirm status change", dialog())); expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed"); expect(document.body.textContent).not.toContain("private-error-canary");
  });
  it("invalidates consent when background metadata or version changes", async () => {
    await render([key()]); await menuAction("Disable key…"); await confirm(); expect(button("Confirm status change", dialog()).disabled).toBe(false);
    await act(async () => { client.setQueryData(["signing-keys", "company"], { canManage: true, keys: [key({ revision: 4, status: "disabled" })] }); });
    await act(async () => { await vi.waitFor(() => expect(button("Confirm status change", dialog()).disabled).toBe(true)); }); expect(api.update).not.toHaveBeenCalled();
  });
  it("closes and clears an import on company change", async () => {
    await render([]); await click(button("New signing key")); await confirm(); await render([], true, "other-company");
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.create).not.toHaveBeenCalled();
  });
  it("keeps descriptions in read-only details instead of repeating them on every row", async () => {
    const description = "Used by Paperclip for signing. Unavailable to agent variables and connection credentials.";
    await render([key({ id: "github", name: "Legacy GitHub signer", type: "github_app", revision: null, description, githubApp: { role: "reviewer", appId: 13 } })]);
    expect(container.querySelector('[role="table"]')?.textContent).not.toContain(description); await openKey("Legacy GitHub signer");
    expect(document.body.textContent).toContain(description); expect(document.querySelector('textarea[aria-label="Signing key description"]')).toBeNull();
  });
  it("shows and resets filtered empty state", async () => {
    await render([key()]); await inputValue(container.querySelector('input[aria-label="Search signing keys"]')!, "not-a-key");
    expect(container.textContent).toContain("No matching signing keys"); await click(button("Clear search and filters")); expect(container.textContent).toContain("Service signer");
  });
  it("navigates display folders without losing original identities", async () => {
    await render([key({ folderPath: "services/github" })]); expect(container.textContent).toContain("services");
    await click(container.querySelector<HTMLAnchorElement>('a[href*="signingPath=services"]')!); await click(container.querySelector<HTMLAnchorElement>('a[href*="signingPath=services%2Fgithub"]')!); await openKey();
    expect(document.body.textContent).toContain("Service signer"); expect(document.body.textContent).toContain("generic");
  });
  it("sends only reviewed folder metadata for managed keys", async () => {
    await render([key({ id: "github", name: "GitHub signer", type: "github_app", revision: null, githubApp: { role: "reviewer", appId: 13 } })]);
    await menuAction("Move to folder…"); await inputValue(document.querySelector('input[aria-label="Signing key folder path"]')!, "services/github");
    expect(button("Move key", dialog()).disabled).toBe(true); await confirm(); api.organize.mockResolvedValue(key()); await click(button("Move key", dialog()));
    expect(api.organize).toHaveBeenCalledExactlyOnceWith("company", "github", { folderPath: "services/github", expectedLatestVersion: 2, expectedUpdatedAt: "2026-11-14T10:00:00Z", expectedOrganizationRevision: 0, confirmed: true });
    expect(api.update).not.toHaveBeenCalled(); expect(api.rotate).not.toHaveBeenCalled();
  });
});
