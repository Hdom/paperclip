import type { SigningKeySummary } from "@paperclipai/shared";

/** Presentation paths do not rename the stored identity or change secret bindings. */
export function signingKeyDisplayName(key: SigningKeySummary): string {
  if (key.folderPath === null || key.folderPath === undefined) return key.name;
  const leaf = key.name.split("/").filter(Boolean).pop() ?? key.name;
  return key.folderPath ? `${key.folderPath}/${leaf}` : leaf;
}
export function signingKeyTypeLabel(key: SigningKeySummary): string {
  return key.type === "github_app" ? "GitHub App" : key.type === "generic" ? "Generic" : "Managed service";
}
