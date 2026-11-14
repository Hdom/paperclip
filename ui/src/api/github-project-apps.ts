import type { GitHubProjectAppSettings, GitHubProjectAppRole } from "@paperclipai/shared";
import { api } from "./client";
const base = (companyId: string) => `/companies/${companyId}/github-project-apps`;
export const githubProjectAppsApi = {
  settings: (companyId: string) => api.get<GitHubProjectAppSettings>(base(companyId)),
  verify: (companyId: string, revision: string) => api.post<GitHubProjectAppSettings>(`${base(companyId)}/verify`, { revision }),
  migrate: (companyId: string, revision: string) => api.post<GitHubProjectAppSettings>(`${base(companyId)}/migrate`, { revision, confirmed: true }),
  configure: (companyId: string, input: { revision: string; confirmed: true; enabled?: boolean; bindings?: Record<GitHubProjectAppRole, string>; releaseAgentId?: string }) =>
    api.put<GitHubProjectAppSettings>(base(companyId), input),
  rotate: (companyId: string, role: GitHubProjectAppRole, input: { revision: string; confirmed: true; privateKey: string; expectedLatestVersion: number }) =>
    api.post<GitHubProjectAppSettings>(`${base(companyId)}/keys/${role}/rotate`, input),
  activate: (companyId: string, role: GitHubProjectAppRole, input: { revision: string; confirmed: true; version: number }) =>
    api.post<GitHubProjectAppSettings>(`${base(companyId)}/keys/${role}/activate`, input),
};
