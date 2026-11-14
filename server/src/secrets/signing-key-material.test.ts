import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SIGNING_KEY_BYTES, parseSigningKeyMaterial, readSigningKeyPublicMetadata, signingKeyPublicMetadata } from "./signing-key-material.js";

const fixtures = [
  { algorithm: "rsa", pair: generateKeyPairSync("rsa", { modulusLength: 2048 }) },
  { algorithm: "ec", pair: generateKeyPairSync("ec", { namedCurve: "prime256v1" }) },
  { algorithm: "ed25519", pair: generateKeyPairSync("ed25519") },
] as const;
describe("native signing key material", () => {
  it.each(fixtures)("supports generic $algorithm signing keys with public-key fingerprints", ({ algorithm, pair }) => {
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const result = parseSigningKeyMaterial(pem);
    expect(result.publicInfo).toEqual({ algorithm,
      publicFingerprint: `SHA256:${createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("base64")}` });
    expect(JSON.stringify(result.publicInfo)).not.toContain("PRIVATE KEY");
    expect(result.publicInfo.publicFingerprint).not.toBe(`SHA256:${createHash("sha256").update(pem).digest("base64")}`);
  });
  it("rejects public keys, invalid inputs and key-agreement-only algorithms without echoing input", () => {
    const marker = "private-input-marker";
    expect(() => parseSigningKeyMaterial(marker)).toThrow("A valid RSA, EC or Ed25519 private signing key is required");
    expect(() => parseSigningKeyMaterial(fixtures[0].pair.publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow();
    expect(() => parseSigningKeyMaterial(generateKeyPairSync("x25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow();
  });
  it("bounds import bytes before crypto parsing", () => {
    expect(() => parseSigningKeyMaterial("x".repeat(MAX_SIGNING_KEY_BYTES + 1))).toThrow("16 KiB");
  });
  it("never presents metadata for a different version as the current public key", () => {
    const info = parseSigningKeyMaterial(fixtures[2].pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).publicInfo;
    const metadata = signingKeyPublicMetadata(info, 2);
    expect(readSigningKeyPublicMetadata(metadata, 2)).toEqual(info);
    expect(readSigningKeyPublicMetadata(metadata, 1)).toBeNull();
    expect(readSigningKeyPublicMetadata({ ...metadata, publicFingerprint: "private-value-hash" }, 2)).toBeNull();
    expect(() => signingKeyPublicMetadata(info, 0)).toThrow();
  });
});
