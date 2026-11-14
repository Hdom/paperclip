import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

export const MAX_SIGNING_KEY_BYTES = 16_384;
export const SIGNING_KEY_ALGORITHMS = ["rsa", "ec", "ed25519"] as const;
export type SigningKeyAlgorithm = typeof SIGNING_KEY_ALGORITHMS[number];
export interface SigningKeyPublicInfo {
  algorithm: SigningKeyAlgorithm;
  publicFingerprint: string;
}

/** Trusted Paperclip use only. API responses must contain publicInfo, never key. */
export function parseSigningKeyMaterial(value: string): { key: KeyObject; publicInfo: SigningKeyPublicInfo } {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_SIGNING_KEY_BYTES) {
    throw new Error("Signing key must be no larger than 16 KiB");
  }
  try {
    const key = createPrivateKey(value);
    if (!SIGNING_KEY_ALGORITHMS.includes(key.asymmetricKeyType as SigningKeyAlgorithm)) {
      throw new Error("Unsupported signing algorithm");
    }
    const publicFingerprint = `SHA256:${createHash("sha256")
      .update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("base64")}`;
    return { key, publicInfo: { algorithm: key.asymmetricKeyType as SigningKeyAlgorithm, publicFingerprint } };
  } catch {
    // Crypto parser errors can include input fragments. Keep the public error fixed.
    throw new Error("A valid RSA, EC or Ed25519 private signing key is required");
  }
}

export function signingKeyPublicMetadata(info: SigningKeyPublicInfo, version: number) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Exact signing key version required");
  return { version, algorithm: info.algorithm, publicFingerprint: info.publicFingerprint };
}

export function readSigningKeyPublicMetadata(metadata: unknown, version: number): SigningKeyPublicInfo | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const info = metadata as Record<string, unknown>;
  if (info.version !== version || !SIGNING_KEY_ALGORITHMS.includes(info.algorithm as SigningKeyAlgorithm)
      || typeof info.publicFingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}=$/.test(info.publicFingerprint)) return null;
  return { algorithm: info.algorithm as SigningKeyAlgorithm, publicFingerprint: info.publicFingerprint };
}
