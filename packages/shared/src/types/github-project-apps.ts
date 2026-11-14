export type GitHubProjectAppRole = "coordinator" | "implementer" | "reviewer";
export interface GitHubProjectAppIdentity {
  role: GitHubProjectAppRole;
  agentId: string;
  appId: number;
  installationId: number;
  installationUrl: string;
  appUrl: string | null;
  login: string | null;
  status: "paused" | "verified" | "attention" | "unverified";
  message: string | null;
  repositories: { id: number; fullName: string; starter: boolean }[];
  publicFingerprint: string | null;
  keyStorage: "native_encrypted" | "legacy_file";
  secretId: string | null;
  pinnedVersion: number | null;
  latestVersion: number | null;
  keyStatus: string;
}
export interface GitHubProjectAppSettings {
  available: boolean;
  canManage: boolean;
  enabled: boolean;
  revision: string;
  checkedAt: string | null;
  roles: GitHubProjectAppIdentity[];
  blockedAgentIds: string[];
  migration?: { migrated: boolean; cleanupPending: GitHubProjectAppRole[] };
}
