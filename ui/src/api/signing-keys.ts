import type { SigningKeyCatalog, SigningKeySummary } from "@paperclipai/shared";
import { api } from "./client";
const base = (companyId: string) => `/companies/${companyId}/signing-keys`;
export const signingKeysApi = {
  events: (companyId: string, id: string) => api.get<{ id: string; version: number | null; outcome: string; createdAt: string }[]>(`${base(companyId)}/${id}/access-events`),
  versions: (companyId: string, id: string) => api.get<{ id: string; version: number; status: string; createdAt: string }[]>(`${base(companyId)}/${id}/versions`),
  list: (companyId: string) => api.get<SigningKeyCatalog>(base(companyId)),
  create: (companyId: string, input: { name: string; description?: string | null; privateKey: string; confirmed: true }) => api.post<SigningKeySummary>(base(companyId), input),
  rotate: (companyId: string, id: string, input: { privateKey: string; expectedLatestVersion: number; expectedRevision: number; confirmed: true }) => api.post<SigningKeySummary>(`${base(companyId)}/${id}/rotate`, input),
  organize: (companyId: string, id: string, input: { folderPath: string; expectedLatestVersion: number; expectedUpdatedAt: string; expectedOrganizationRevision: number; confirmed: true }) => api.patch<SigningKeySummary>(`${base(companyId)}/${id}/organization`, input),
  update: (companyId: string, id: string, input: { name?: string; description?: string | null; status?: "active" | "disabled" | "archived"; expectedLatestVersion: number; expectedRevision: number; confirmed: true }) => api.patch<SigningKeySummary>(`${base(companyId)}/${id}`, input),
};
