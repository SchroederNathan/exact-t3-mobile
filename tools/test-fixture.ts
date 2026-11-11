import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { ActivityFixture } from "./activity-fixture";
import { ControlsFixture } from "./controls-fixture";
import { MarkdownFixture } from "./markdown-fixture";

const app = resolve(import.meta.dir, "..");
const timestamp = "2026-11-10T12:00:00Z";
const activityMode = process.argv.includes("--activities");
const markdownMode = process.argv.includes("--markdown");
const controlsMode = process.argv.includes("--controls");
const thirdEnvironment = process.argv.includes("--third-environment");
const fixturePorts = new Map<string, number>();
const exactArguments: string[] = [];
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]!;
  if (["--activities", "--no-command-stream", "--markdown", "--controls", "--third-environment"].includes(argument)) continue;
  const match = /^(--(?:port|secondary-port|third-port))(?:=(.*))?$/.exec(argument);
  if (!match) { exactArguments.push(argument); continue; }
  const value = match[2] ?? process.argv[++index] ?? "";
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error(`${match[1]} requires a port from 0 to 65535.`);
  fixturePorts.set(match[1]!, Number(value));
}
if (thirdEnvironment && !markdownMode && !controlsMode) throw new Error("--third-environment requires --markdown or --controls.");
if (fixturePorts.has("--third-port") && !thirdEnvironment) throw new Error("--third-port requires --third-environment.");
const fixedPorts = [...fixturePorts.values()].filter((port) => port !== 0);
if (new Set(fixedPorts).size !== fixedPorts.length) throw new Error("Each fixture environment needs a different port.");
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
type SocketState = { serial: number; shell: boolean; config: boolean; shellRequest?: string };
type Socket = ServerWebSocket<SocketState>;
const chunk = (socket: Socket, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
const changes = new Set<() => void>();
const changed = () => { for (const notify of changes) notify(); };
const accepted = (socket: Socket, requestId: string) => socket.send(JSON.stringify({
  _tag: "Exit", requestId, exit: { _tag: "Success", value: { sequence: 1 } },
}));
let nextSocket = 0;
let secondaryAccepted = 0;
const settingsCommands: Record<string, unknown>[] = [];
let checkpoint: { primary: number; secondary: number } | undefined;

function barrier(signal: AbortSignal, inspect: () => Response | undefined) {
  const response = inspect();
  if (response) return Promise.resolve(response);
  return new Promise<Response>((resolve) => {
    const finish = (response: Response) => {
      changes.delete(notify);
      signal.removeEventListener("abort", abort);
      resolve(response);
    };
    const notify = () => {
      const response = inspect();
      if (response) finish(response);
    };
    const abort = () => finish(json({ error: "Fixture barrier cancelled" }, 499));
    changes.add(notify);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function environment(id: string, label: string, secondary = false, port = 0) {
  const sockets = new Set<Socket>();
  const activities = activityMode && !secondary ? new ActivityFixture(!process.argv.includes("--no-command-stream")) : undefined;
  const markdown = markdownMode ? new MarkdownFixture(id, secondary ? "remote" : "active", (thread, sequence) => {
    for (const socket of sockets) if (socket.data.shellRequest) {
      chunk(socket, socket.data.shellRequest, { kind: "thread.updated", sequence, location: "active", thread });
    }
  }) : undefined;
  const controls = controlsMode ? new ControlsFixture(id, secondary ? "remote" : "active", (thread, sequence) => {
    for (const socket of sockets) if (socket.data.shellRequest) {
      chunk(socket, socket.data.shellRequest, { kind: "thread.updated", sequence, location: "active", thread });
    }
  }, () => {
    const count = sockets.size;
    for (const socket of sockets) socket.close(1012, "Fixture connection reset");
    return count;
  }) : undefined;
  let modelFavorites: Array<{ provider: string; model: string }> = [];
  const held: { socket: Socket; requestId: string }[] = [];
  const projects = (secondary
    ? [{ id: "remote", title: "Remote project" }]
    : [{ id: "active", title: "Active project" }, { id: "empty", title: "Empty project" }])
    .map((project) => ({ ...project, ...(markdown ? { workspaceRoot: markdown.workspaceRoot } : {}) }));
  const threads = (secondary ? ["gamma"] : ["alpha", "beta"]).map((id) => ({
    id,
    projectId: secondary ? "remote" : "active",
    title: id === "gamma" ? "Gamma remote thread" : id === "alpha" ? "Alpha thread" : "Beta thread",
    status: "idle",
    runtimeMode: "full-access",
    updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
  })).concat(activities?.threads ?? []);
  const server = Bun.serve<SocketState>({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const controlsResponse = await controls?.http(request);
      if (controlsResponse) return controlsResponse;
      const markdownResponse = await markdown?.http(request);
      if (markdownResponse) return markdownResponse;
      const activityResponse = await activities?.http(request);
      if (activityResponse) return activityResponse;
      if (request.method === "POST") {
        const assertion = assertions(path, request.signal);
        if (assertion) return assertion;
      }
      if (path === "/.well-known/t3/environment") {
        return json({
          environmentId: id,
          label,
          orchestrationProtocolVersion: 2,
        });
      }
      if (path === "/assert/settings" && request.method === "POST") {
        const runtime = settingsCommands.at(-2);
        const message = settingsCommands.at(-1);
        const expected = { instanceId: "fixture-provider", model: "fixture-fast", options: [{ id: "effort", value: "high" }] };
        return runtime?.type === "thread.runtime-mode.set" && runtime.runtimeMode === "approval-required"
          && message?.type === "message.dispatch" && JSON.stringify(message.modelSelection) === JSON.stringify(expected)
          ? json({ ok: true }) : json({ error: "The selected model, reasoning and runtime were not dispatched in order." }, 409);
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
          accepted(socket, requestId);
        }
        return json({ released: replies.length }, replies.length ? 200 : 409);
      }
      if (path === "/ws" && new URL(request.url).searchParams.get("wsTicket") === "fixture-ticket") {
        return server.upgrade(request, { data: { serial: ++nextSocket, shell: false, config: false } })
          ? undefined : json({ error: "Upgrade failed" }, 400);
      }
      return json({ error: "Not found" }, 404);
    },
    websocket: {
      idleTimeout: 0,
      open(socket) {
        sockets.add(socket);
        changed();
      },
      message(socket, data) {
        const frame = JSON.parse(String(data));
        if (frame._tag === "Interrupt" && frame.requestId === socket.data.shellRequest) {
          socket.data.shellRequest = undefined;
          socket.data.shell = false;
          changed();
          return;
        }
        if (controls?.receive(socket, frame) || markdown?.receive(socket, frame) || activities?.receive(socket, frame)) {
          changed();
          return;
        }
        if (frame._tag !== "Request") return;
        if (frame.tag === "orchestration.subscribeShell") {
          socket.data.shell = true;
          socket.data.shellRequest = frame.id;
          chunk(socket, frame.id, { kind: "snapshot", snapshot: { projects, threads: [...threads, ...(markdown?.threads ?? []), ...(controls?.threads ?? [])] } });
        } else if (frame.tag === "subscribeServerConfig") {
          socket.data.config = true;
          chunk(socket, frame.id, {
            type: "snapshot",
            config: {
              settings: { favorites: modelFavorites },
              environment: {
                platform: { machine: secondary ? "laptop" : "mac-mini" },
                ...(activities ? { capabilities: activities.config } : {}),
              },
              ...(activities || markdown || controls ? { threadResumeCompletionMarker: true } : {}),
              ...(controls ? { threadSnapshotPagination: true } : {}),
              providers: [{
                instanceId: "fixture-provider",
                driver: "codex",
                installed: true,
                enabled: true,
                auth: { status: "authenticated" },
                models: ["fixture-model", "fixture-fast"].map((slug) => ({
                  slug,
                  name: slug === "fixture-model" ? "Fixture model" : "Fixture fast",
                  shortName: slug === "fixture-model" ? "Fixture model" : "Fixture fast",
                  capabilities: { optionDescriptors: [{
                    id: "effort", label: "Reasoning", type: "select",
                    options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }],
                  }] },
                })),
              }],
            },
          });
        } else if (frame.tag === "server.updateSettings") {
          for (const favorite of frame.payload.patch.setModelFavorites ?? []) {
            modelFavorites = modelFavorites.filter((entry) => entry.provider !== favorite.provider || entry.model !== favorite.model);
            if (favorite.favorite) modelFavorites.push({ provider: favorite.provider, model: favorite.model });
          }
          socket.send(JSON.stringify({
            _tag: "Exit", requestId: frame.id,
            exit: { _tag: "Success", value: { favorites: modelFavorites } },
          }));
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
          if (activities || markdown || controls) chunk(socket, frame.id, { kind: "synchronized" });
        } else if (frame.tag === "orchestration.dispatchCommand" && (
          frame.payload.type === "thread.runtime-mode.set" || frame.payload.text === "Send chosen settings"
        )) {
          settingsCommands.push(frame.payload);
          accepted(socket, frame.id);
        } else if (
          secondary && frame.tag === "orchestration.dispatchCommand" &&
          frame.payload.threadId === "gamma" && frame.payload.text === "Accept on secondary"
        ) {
          secondaryAccepted++;
          accepted(socket, frame.id);
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
        changed();
      },
      close(socket) {
        sockets.delete(socket);
        markdown?.close(socket);
        activities?.close(socket);
        controls?.close(socket);
        for (let i = held.length - 1; i >= 0; i--) {
          if (held[i]?.socket === socket) held.splice(i, 1);
        }
        changed();
      },
    },
  });
  return { server, sockets };
}

const primary = environment("fixture", "Fixture Mac", false, fixturePorts.get("--port"));
const secondary = environment("secondary", "Fixture Laptop", true, fixturePorts.get("--secondary-port"));
const tertiary = thirdEnvironment ? environment("tertiary", "Fixture Third Mac", true, fixturePorts.get("--third-port")) : undefined;
const readySocket = (sockets: Set<Socket>) => sockets.size === 1
  ? [...sockets].find((socket) => socket.data.shell && socket.data.config) : undefined;
const topology = () => ({
  primary: [...primary.sockets].map((socket) => socket.data.serial),
  secondary: [...secondary.sockets].map((socket) => socket.data.serial),
});
const refused = (error: string) => json({ error, ...topology() }, 409);

function assertions(path: string, signal: AbortSignal): Promise<Response> | Response | undefined {
  if (path === "/checkpoint") return barrier(signal, () => {
    if (primary.sockets.size > 1 || secondary.sockets.size > 1) return refused("An environment opened duplicate sockets");
    const a = readySocket(primary.sockets), b = readySocket(secondary.sockets);
    if (!a || !b) return;
    checkpoint = { primary: a.data.serial, secondary: b.data.serial };
    secondaryAccepted = 0;
    return json(topology());
  });
  if (!["/assert/both", "/await/secondary-only", "/await/restored", "/assert/sent-secondary"].includes(path)) return;
  const baseline = checkpoint;
  if (!baseline) return refused("Capture both connections with /checkpoint first");
  return barrier(signal, () => {
    if (readySocket(secondary.sockets)?.data.serial !== baseline.secondary) {
      return refused("The secondary connection closed or was replaced");
    }
    if (path === "/assert/sent-secondary") {
      return secondaryAccepted > 0 ? json({ accepted: secondaryAccepted }) : refused("The secondary environment received no message");
    }
    if (primary.sockets.size > 1) return refused("The primary environment opened duplicate sockets");
    const a = readySocket(primary.sockets);
    if (path === "/assert/both") {
      return a?.data.serial === baseline.primary ? json(topology()) : refused("Filtering closed or replaced the primary connection");
    }
    if (path === "/await/secondary-only") return primary.sockets.size === 0 ? json(topology()) : undefined;
    return a && a.data.serial !== baseline.primary ? json(topology()) : undefined;
  });
}

const directory = await mkdtemp(join(tmpdir(), "exact-t3-regression-"));
try {
  const [host = "ios", ...flags] = exactArguments;
  if (host === "--serve") {
    console.log(JSON.stringify({ primary: primary.server.url.origin, secondary: secondary.server.url.origin,
      ...(tertiary ? { tertiary: tertiary.server.url.origin } : {}), code: "fixture-code" }));
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
    const file = join(directory, "home-regression.test.contract");
    const source = await readFile(join(import.meta.dir, "home-regression.test.contract"), "utf8");
    await writeFile(file, source
      .replaceAll("http://127.0.0.1:0", primary.server.url.origin)
      .replaceAll("http://127.0.0.2:0", secondary.server.url.origin));
    const child = Bun.spawn([process.execPath, "exact.mjs", "test", host, file, ...flags], {
      cwd: app,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
  }
} finally {
  await Promise.all([primary.server.stop(true), secondary.server.stop(true), tertiary?.server.stop(true)]);
  await rm(directory, { recursive: true, force: true });
}
