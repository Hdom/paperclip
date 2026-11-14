/** Public metadata only. Signing material and private-value hashes are never part of this contract. */
export interface SigningKeySummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  type: "generic" | "github_app" | "managed";
  algorithm: "rsa" | "ec" | "ed25519" | null;
  publicFingerprint: string | null;
  latestVersion: number;
  revision: number | null;
  createdAt: string;
  updatedAt: string;
  githubApp: { role: "coordinator" | "implementer" | "reviewer"; appId: number } | null;
}
export interface SigningKeyCatalog { canManage: boolean; keys: SigningKeySummary[] }
