import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { githubProjectAppSettingsInputSchema, githubProjectAppRotateInputSchema } from "@paperclipai/shared";
describe("GitHub App administration discovery contract", () => {
  it("documents board-only status and instance-admin mutations with exact strict request fields", () => {
    const paths = buildOpenApiSpec().paths as Record<string, Record<string, any>>;
    const base = "/api/companies/{companyId}/github-project-apps";
    expect(paths[base].get["x-paperclip-authorization"]).toEqual({ actor: "board" });
    for (const [method, suffix] of [["put", ""], ["post", "/verify"], ["post", "/migrate"], ["post", "/keys/{role}/rotate"], ["post", "/keys/{role}/activate"]]) {
      const operation = paths[base + suffix][method];
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board", instanceAdmin: true });
      expect(operation.description).toContain("connection management");
      expect(operation.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
      expect(operation.responses[403]).toBeDefined();
    }
    const rotation = paths[base + "/keys/{role}/rotate"].post.requestBody.content["application/json"].schema;
    expect(Object.keys(rotation.properties)).toEqual(["revision", "confirmed", "privateKey", "expectedLatestVersion"]);
    expect(rotation.properties.privateKey).toMatchObject({ writeOnly: true, description: expect.stringContaining("Write-only") });
  });
  it("does not let settings or key requests expand repository or permission authority", () => {
    const revision = "a".repeat(64);
    expect(githubProjectAppSettingsInputSchema.safeParse({ revision, confirmed: true, permissions: { administration: "write" } }).success).toBe(false);
    expect(githubProjectAppSettingsInputSchema.safeParse({ revision, confirmed: true, installationId: 123 }).success).toBe(false);
    expect(githubProjectAppRotateInputSchema.safeParse({ revision, confirmed: true, privateKey: "synthetic", expectedLatestVersion: 1, scope: "company" }).success).toBe(false);
  });
});
