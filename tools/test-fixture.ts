import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";

const app = resolve(import.meta.dir, "..");
const timestamp = "2026-11-10T12:00:00Z";
const projects = [
  { id: "active", title: "Active project" },
  { id: "empty", title: "Empty project" },
];
const threads = ["alpha", "beta"].map((id) => ({
  id,
  projectId: "active",
  title: id === "alpha" ? "Alpha thread" : "Beta thread",
  status: "idle",
  updatedAt: timestamp,
  latestUserMessageAt: timestamp,
  modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
}));
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const chunk = (socket: ServerWebSocket<undefined>, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
const held: { socket: ServerWebSocket<undefined>; requestId: string }[] = [];

const server = Bun.serve<undefined>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (path === "/.well-known/t3/environment") {
      return json({
        environmentId: "fixture",
        label: "Fixture Mac",
        orchestrationProtocolVersion: 2,
      });
    }
    if (path === "/oauth/token") {
      const form = new URLSearchParams(await request.text());
      return form.get("subject_token") === "fixture-code"
        ? json({ access_token: "fixture-access" })
        : json({ error: "Invalid fixture code" }, 401);
    }
    if (path === "/api/auth/websocket-ticket/rpc") {
      return request.headers.get("authorization") === "Bearer fixture-access"
        ? json({ ticket: "fixture-ticket" })
        : json({ error: "Invalid fixture access" }, 401);
    }
    if (path === "/release" && request.method === "POST") {
      const replies = held.splice(0);
      for (const { socket, requestId } of replies) {
        socket.send(JSON.stringify({
          _tag: "Exit", requestId, exit: { _tag: "Success", value: { sequence: 1 } },
        }));
      }
      return json({ released: replies.length }, replies.length ? 200 : 409);
    }
    if (path === "/ws" && new URL(request.url).searchParams.get("wsTicket") === "fixture-ticket") {
      return server.upgrade(request) ? undefined : json({ error: "Upgrade failed" }, 400);
    }
    return json({ error: "Not found" }, 404);
  },
  websocket: {
    message(socket, data) {
      const frame = JSON.parse(String(data));
      if (frame._tag !== "Request") return;
      if (frame.tag === "orchestration.subscribeShell") {
        chunk(socket, frame.id, { kind: "snapshot", snapshot: { projects, threads } });
      } else if (frame.tag === "subscribeServerConfig") {
        chunk(socket, frame.id, {
          type: "snapshot",
          config: {
            environment: { platform: { machine: "mac-mini" } },
            providers: [{
              instanceId: "fixture-provider",
              driver: "codex",
              models: [{ slug: "fixture-model", shortName: "Fixture model" }],
            }],
          },
        });
      } else if (frame.tag === "orchestration.subscribeThread") {
        chunk(socket, frame.id, {
          kind: "snapshot",
          projection: {
            messages: [{
              id: `${frame.payload.threadId}-message`,
              role: "assistant",
              text: "This is a deterministic test conversation.",
              createdAt: timestamp,
            }],
          },
        });
      } else if (
        frame.tag === "orchestration.dispatchCommand" &&
        frame.payload.text === "Accept after release"
      ) {
        held.push({ socket, requestId: frame.id });
      } else {
        socket.send(JSON.stringify({
          _tag: "Exit",
          requestId: frame.id,
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: { message: "Fixture rejected the message." } }],
          },
        }));
      }
    },
    close(socket) {
      for (let i = held.length - 1; i >= 0; i--) {
        if (held[i]?.socket === socket) held.splice(i, 1);
      }
    },
  },
});

const directory = await mkdtemp(join(tmpdir(), "exact-t3-regression-"));
try {
  const file = join(directory, "home-regression.test.contract");
  const source = await readFile(join(import.meta.dir, "home-regression.test.contract"), "utf8");
  await writeFile(file, source.replaceAll("http://127.0.0.1:0", server.url.origin));
  const [host = "ios", ...flags] = process.argv.slice(2);
  const child = Bun.spawn([process.execPath, "exact.mjs", "test", host, file, ...flags], {
    cwd: app,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  await server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
