import { createPublicKey, verify } from "node:crypto";
import { need, object, text, strictJson } from "./projection.js";

export function humanVerifier(raw: Uint8Array, companyId: string, projectionSha256: string) {
  const config = strictJson(raw, 16384);
  object(config, ["schema", "issuer", "audience", "publicKeyJwk", "humans"]); need(config.schema === "paperclip.management-auth.v1");
  text(config.issuer); text(config.audience); object(config.publicKeyJwk, ["kty", "crv", "x"]);
  need(config.publicKeyJwk.kty === "OKP" && config.publicKeyJwk.crv === "Ed25519"); text(config.publicKeyJwk.x, 43); need(/^[A-Za-z0-9_-]{43}$/.test(config.publicKeyJwk.x));
  const key = createPublicKey({ key: config.publicKeyJwk, format: "jwk" }); need(key.asymmetricKeyType === "ed25519");
  need(Array.isArray(config.humans) && config.humans.length > 0 && config.humans.length <= 100);
  const grants = new Set<string>();
  for (const human of config.humans) { object(human, ["subject", "companyId"]); text(human.subject); need(human.companyId === companyId && !grants.has(human.subject)); grants.add(human.subject); }
  function part(value: string, bound: number) {
    need(/^[A-Za-z0-9_-]+$/.test(value)); const bytes = Buffer.from(value, "base64url"); need(bytes.toString("base64url") === value); return strictJson(bytes, bound);
  }
  return (authorization: string | undefined, now = Math.floor(Date.now() / 1000)): boolean => {
    try {
      need(typeof authorization === "string" && authorization.length <= 4096 && authorization.startsWith("Bearer "));
      const parts = authorization.slice(7).split("."); need(parts.length === 3);
      const header = part(parts[0], 256); object(header, ["alg", "typ"]); need(header.alg === "EdDSA" && header.typ === "JWT");
      need(/^[A-Za-z0-9_-]{86}$/.test(parts[2])); const signature = Buffer.from(parts[2], "base64url"); need(signature.toString("base64url") === parts[2]);
      need(verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, signature));
      const claims = part(parts[1], 2048);
      object(claims, ["iss", "aud", "sub", "principalType", "companyId", "projectionSha256", "iat", "nbf", "exp"]);
      need(claims.iss === config.issuer && claims.aud === config.audience && claims.principalType === "human" && typeof claims.sub === "string" && grants.has(claims.sub));
      need(claims.companyId === companyId && claims.projectionSha256 === projectionSha256);
      const { iat, nbf, exp } = claims; need(Number.isSafeInteger(iat) && Number.isSafeInteger(nbf) && Number.isSafeInteger(exp));
      need(nbf === iat && (iat as number) <= now + 2 && now >= (nbf as number) - 2 && now < (exp as number) && (exp as number) > (iat as number) && (exp as number) - (iat as number) <= 60);
      return true;
    } catch { return false; }
  };
}
