import http from "node:http";
import https from "node:https";
import net from "node:net";
import { beforeEach, vi } from "vitest";

// Runs BEFORE extension module evaluation: no real home, discovery, credentials,
// history or settings are inputs to this composition test.
export const sandbox = process.env.PI_COMPACT_SANDBOX ?? "";
if (!sandbox || !process.permission?.has("fs.write", sandbox)) throw new Error("Restricted synthetic child required");
if (process.permission.has("fs.write", process.cwd())) throw new Error("Repository writes must be denied in child");
for (const key of ["HOME", "PI_CODING_AGENT_DIR", "XDG_CACHE_HOME", "TMPDIR"]) {
  if (process.env[key] !== sandbox) throw new Error(`Synthetic environment missing before imports: ${key}`);
}
export const denied = { fetch: 0, websocket: 0, socket: 0, http: 0 };
function denyNetwork() {
  for (const key of Object.keys(denied) as Array<keyof typeof denied>) denied[key] = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    denied.fetch++;
    throw new Error("Unexpected live fetch");
  });
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    denied.websocket++;
    throw new Error("Unexpected live WebSocket");
  });
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    denied.socket++;
    throw new Error("Unexpected live socket");
  });
  for (const module of [http, https]) {
    vi.spyOn(module, "request").mockImplementation(() => {
      denied.http++;
      throw new Error("Unexpected live HTTP request");
    });
  }
}
denyNetwork();
beforeEach(denyNetwork);
