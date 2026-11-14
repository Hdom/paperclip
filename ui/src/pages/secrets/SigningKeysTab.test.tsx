// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { SigningKeySummary } from "@paperclipai/shared";
import { SigningKeysTab } from "./SigningKeysTab";
const api = vi.hoisted(() => ({ list: vi.fn(), versions: vi.fn(), create: vi.fn(), rotate: vi.fn(), update: vi.fn() }));
vi.mock("@/api/signing-keys", () => ({ signingKeysApi: api }));
vi.mock("@/components/GitHubProjectAppControls", () => ({
  GitHubProjectAppManager: () => <button>Manage verified GitHub App</button>,
  useGitHubProjectApps: () => ({ data: { roles: [{ secretId: "github", pinnedVersion: 1, status: "verified", publicFingerprint: "SHA256:public-only" }] } }),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement, client: QueryClient;
const key = (overrides: Partial<SigningKeySummary> = {}): SigningKeySummary => ({ id: "generic", name: "Service signer", description: "Synthetic signing key", status: "active", type: "generic", algorithm: "ed25519", publicFingerprint: "SHA256:public-only", latestVersion: 2, revision: 3, githubApp: null, createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T10:00:00Z", ...overrides });
async function render(keys: SigningKeySummary[], canManage = true) {
  const data = { keys, canManage }; api.list.mockResolvedValue(data); client.setQueryData(["signing-keys", "company"], data);
  await act(async () => { root.render(<QueryClientProvider client={client}><SigningKeysTab companyId="company" /></QueryClientProvider>); });
}
const button = (text: string) => { const found = [...document.querySelectorAll("button")].find(el => el.textContent === text); if (!found) throw Error(`Missing ${text}`); return found; };
async function click(el: HTMLElement) { await act(async () => el.click()); }
async function confirm() { await click([...document.querySelectorAll("label")].find(el => el.textContent?.includes("I confirm"))!.querySelector("input")!); }
beforeEach(() => { Object.values(api).forEach(mock => mock.mockReset()); api.versions.mockResolvedValue([{ id: "v2", version: 2, status: "current", createdAt: "2026-11-14T10:00:00Z" }]); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
describe("Secrets signing-key table", () => {
  it("uses a table and public metadata without introducing controller terminology or reveal controls", async () => {
    await render([key()]); expect(container.querySelector("table")).not.toBeNull(); await click(button("Service signer"));
    expect(document.body.textContent).toContain("Managed by Paperclip"); expect(document.body.textContent).toContain("ed25519");
    expect(document.body.textContent).not.toMatch(/controller|reveal key|export key/i);
    expect(document.body.textContent).toContain("cannot be revealed, exported, or bound to agents");
  });
  it("offers metadata read access without write controls for non-administrators", async () => {
    await render([key()], false); expect(container.textContent).not.toContain("Import signing key"); await click(button("Service signer"));
    expect(document.querySelector('input[type="file"]')).toBeNull(); expect(document.body.textContent).not.toContain("Disable key");
  });
  it("keeps GitHub keys in their verified service lifecycle with visible active versus stored version", async () => {
    await render([key({ id: "github", name: "GitHub signer", type: "github_app", revision: null, algorithm: null, publicFingerprint: null, githubApp: { role: "reviewer", appId: 13 } })]);
    await click(button("GitHub signer")); expect(document.body.textContent).toContain("Active version: 1"); expect(document.body.textContent).toContain("Latest stored version2");
    expect(button("Manage verified GitHub App")).toBeTruthy(); expect(document.querySelector('input[type="file"]')).toBeNull(); expect(document.body.textContent).not.toContain("Disable key");
  });
  it("requires confirmation and sends the displayed lifecycle revision for a disable", async () => {
    await render([key()]); await click(button("Service signer")); expect(button("Disable key").disabled).toBe(true);
    api.update.mockResolvedValue(key({ status: "disabled", revision: 4 })); await confirm(); await click(button("Disable key"));
    expect(api.update).toHaveBeenCalledExactlyOnceWith("company", "generic", { status: "disabled", expectedLatestVersion: 2, expectedRevision: 3, confirmed: true });
  });
  it("sends replacement bytes only after confirmation and never caches or renders them", async () => {
    const canary = "synthetic-signing-private-value"; await render([key()]); await click(button("Service signer"));
    const file = new File([canary], "key.pem"); Object.defineProperty(file, "text", { value: async () => canary });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { Object.defineProperty(input, "files", { value: [file], configurable: true }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("Rotate key").disabled).toBe(true); expect(api.rotate).not.toHaveBeenCalled();
    api.rotate.mockResolvedValue(key({ latestVersion: 3, revision: 4 })); await confirm(); await click(button("Rotate key"));
    expect(api.rotate).toHaveBeenCalledExactlyOnceWith("company", "generic", { privateKey: canary, expectedLatestVersion: 2, expectedRevision: 3, confirmed: true });
    expect(document.body.innerHTML).not.toContain(canary); expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(canary); expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("does not render raw server errors", async () => {
    await render([key()]); await click(button("Service signer")); api.update.mockRejectedValue(new Error("private-error-canary"));
    await confirm(); await click(button("Disable key")); expect(document.querySelector('[role="alert"]')?.textContent).toContain("change failed"); expect(document.body.textContent).not.toContain("private-error-canary");
  });
  it("invalidates consent when a background refresh changes the selected key", async () => {
    await render([key()]); await click(button("Service signer")); await confirm(); expect(button("Disable key").disabled).toBe(false);
    await act(async () => { client.setQueryData(["signing-keys", "company"], { canManage: true, keys: [key({ revision: 4, status: "disabled" })] }); });
    await act(async () => { await vi.waitFor(() => expect(button("Enable key").disabled).toBe(true)); }); expect(api.update).not.toHaveBeenCalled();
  });
  it("closes and clears an import when changing company", async () => {
    await render([]); await click(button("Import signing key")); await confirm();
    await act(async () => { root.render(<QueryClientProvider client={client}><SigningKeysTab companyId="other-company" /></QueryClientProvider>); });
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.create).not.toHaveBeenCalled();
  });

});
