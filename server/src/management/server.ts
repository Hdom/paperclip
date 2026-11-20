import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { humanVerifier } from "./auth.js";
import { canonical, need, parseProjection } from "./projection.js";

export type Asset = { type: string; bytes: Buffer };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
export function managementServer(projectionBytes: Buffer, authBytes: Buffer, suppliedAssets: ReadonlyMap<string, Asset>) {
  const projection = parseProjection(projectionBytes); const raw = Buffer.from(canonical(projection));
  const projectionSha256 = createHash("sha256").update(raw).digest("hex");
  const authenticate = humanVerifier(authBytes, projection.company.id, projectionSha256);
  const assets = new Map([...suppliedAssets].map(([path, asset]) => [path, { type: asset.type, bytes: Buffer.from(asset.bytes) }]));
  need(assets.has("/management.html"));
  const placeholder = "__PAPERCLIP_MANAGEMENT_STYLE_NONCE__";
  need(assets.get("/management.html")!.bytes.toString("utf8").split(placeholder).length === 2);
  const prefix = `/${projection.company.issuePrefix}`;
  const pages = new Set(["/", `${prefix}/projects`, `${prefix}/issues`, `${prefix}/work`, ...projection.projects.map(p => `${prefix}/projects/${p.id}`), ...projection.issues.map(i => `${prefix}/issues/${i.identifier}`), ...projection.work.map(w => `${prefix}/work/${w.id}`)]);
  function respond(req: IncomingMessage, res: ServerResponse, status: number, bytes = Buffer.alloc(0), type = "text/plain; charset=utf-8", nonce?: string) {
    res.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store", "Content-Security-Policy": nonce ? CSP.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`) : CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", ...(status === 405 ? { Allow: "GET, HEAD" } : {}) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
    const fail = (status: number) => respond(req, res, status);
    const count = (name: string) => req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
    if (count("authorization") !== 1 || !authenticate(req.headers.authorization)) return fail(401);
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405);
    const address = server.address(); if (!address || typeof address === "string" || address.address !== "127.0.0.1") return fail(503);
    for (const h of ["host", "origin", "content-length", "transfer-encoding", "upgrade"]) if (count(h) > 1) return fail(400);
    if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers["transfer-encoding"] !== undefined || req.headers.upgrade !== undefined || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) return fail(400);
    if (req.headers.origin !== undefined && req.headers.origin !== `http://127.0.0.1:${address.port}`) return fail(403);
    if (req.url === "/api/management/projection") return respond(req, res, 200, raw, "application/json");
    const asset = assets.get(req.url ?? "");
    if (asset && req.url !== "/management.html") return respond(req, res, 200, asset.bytes, asset.type);
    if (pages.has(req.url ?? "")) { const html = assets.get("/management.html")!, nonce = randomBytes(24).toString("base64url"); return respond(req, res, 200, Buffer.from(html.bytes.toString("utf8").replace(placeholder, nonce)), html.type, nonce); }
    return fail(404);
  });
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  return { server, projectionSha256 };
}
