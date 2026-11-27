import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ServerWebSocket } from "bun";
import { ActivityFixture } from "./activity-fixture";
import { AttachmentFixture } from "./attachment-fixture";
import { ControlsFixture } from "./controls-fixture";
import { MarkdownFixture } from "./markdown-fixture";
import { projectFixture } from "./project-fixture";
import { ComposerFixture } from "./composer-fixture";

const app = NodePath.resolve(import.meta.dir, "..");
const timestamp = "2026-11-10T12:00:00Z";
const conversation = "This is a deterministic test conversation.";
const activityMode = process.argv.includes("--activities");
const attachmentMode = process.argv.includes("--attachments");
const markdownMode = process.argv.includes("--markdown");
const controlsMode = process.argv.includes("--controls");
const composerMode = process.argv.includes("--composer");
const usageMode = process.argv.includes("--usage");
const pullsMode = process.argv.includes("--pulls");
const threadTimeMode = process.argv.includes("--thread-time");
const threadSearchMode = process.argv.includes("--thread-search");
const thirdEnvironment = process.argv.includes("--third-environment");
const fixturePorts = new Map<string, number>();
const exactArguments: string[] = [];
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]!;
  if (
    [
      "--activities",
      "--no-command-stream",
      "--markdown",
      "--controls",
      "--composer",
      "--usage",
      "--pulls",
      "--thread-time",
      "--thread-search",
      "--attachments",
      "--third-environment",
    ].includes(argument)
  )
    continue;
  const match = /^(--(?:port|secondary-port|third-port))(?:=(.*))?$/.exec(argument);
  if (!match) {
    exactArguments.push(argument);
    continue;
  }
  const value = match[2] ?? process.argv[++index] ?? "";
  if (!/^\d+$/.test(value) || Number(value) > 65535)
    throw new Error(`${match[1]} requires a port from 0 to 65535.`);
  fixturePorts.set(match[1]!, Number(value));
}
if (thirdEnvironment && !markdownMode && !controlsMode && !attachmentMode)
  throw new Error("--third-environment requires --markdown, --controls, or --attachments.");
if (fixturePorts.has("--third-port") && !thirdEnvironment)
  throw new Error("--third-port requires --third-environment.");
const fixedPorts = [...fixturePorts.values()].filter((port) => port !== 0);
if (new Set(fixedPorts).size !== fixedPorts.length)
  throw new Error("Each fixture environment needs a different port.");
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
type SocketState = {
  serial: number;
  shell: boolean;
  config: boolean;
  shellRequest?: string;
  configRequest?: string;
};
type Socket = ServerWebSocket<SocketState>;
const chunk = (socket: Socket, requestId: string, value: unknown) =>
  socket.send(JSON.stringify({ _tag: "Chunk", requestId, values: [value] }));
const changes = new Set<() => void>();
const changed = () => {
  for (const notify of changes) notify();
};
const accepted = (socket: Socket, requestId: string) =>
  socket.send(
    JSON.stringify({
      _tag: "Exit",
      requestId,
      exit: { _tag: "Success", value: { sequence: 1 } },
    }),
  );
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
  const composer = composerMode ? new ComposerFixture() : undefined;
  const activities =
    activityMode && !secondary
      ? new ActivityFixture(!process.argv.includes("--no-command-stream"))
      : undefined;
  const markdown = markdownMode
    ? new MarkdownFixture(id, secondary ? "remote" : "active", (thread, sequence) => {
        for (const socket of sockets)
          if (socket.data.shellRequest) {
            chunk(socket, socket.data.shellRequest, {
              kind: "thread.updated",
              sequence,
              location: "active",
              thread,
            });
          }
      })
    : undefined;
  const controls = controlsMode
    ? new ControlsFixture(
        id,
        secondary ? "remote" : "active",
        (thread, sequence) => {
          for (const socket of sockets)
            if (socket.data.shellRequest) {
              chunk(socket, socket.data.shellRequest, {
                kind: "thread.updated",
                sequence,
                location: "active",
                thread,
              });
            }
        },
        () => {
          const count = sockets.size;
          for (const socket of sockets) socket.close(1012, "Fixture connection reset");
          return count;
        },
      )
    : undefined;
  const attachments = attachmentMode
    ? new AttachmentFixture(id, secondary ? "remote" : "active", {
        threadChanged(thread, sequence) {
          for (const socket of sockets)
            if (socket.data.shellRequest) {
              chunk(socket, socket.data.shellRequest, {
                kind: "thread.updated",
                sequence,
                location: "active",
                thread,
              });
            }
        },
        disconnect() {
          const count = sockets.size;
          for (const socket of sockets) socket.close(1012, "Fixture connection reset");
          return count;
        },
        configChanged() {
          for (const socket of sockets)
            if (socket.data.configRequest) {
              chunk(socket, socket.data.configRequest, {
                type: "snapshot",
                config: serverConfig(),
              });
            }
        },
        ...(controls
          ? {
              authorization: {
                get() {
                  const auth = controls.state().auth;
                  return (
                    auth.authenticated &&
                    (auth.permissions ?? auth.scopes).includes("orchestration:operate")
                  );
                },
                async set(allowed: boolean) {
                  await controls.http(
                    new Request("http://fixture/fixture/controls/auth", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        session: {
                          authenticated: true,
                          scopes: ["orchestration:read", "orchestration:operate"],
                          permissions: [
                            "orchestration:read",
                            ...(allowed ? ["orchestration:operate"] : []),
                          ],
                        },
                      }),
                    }),
                  );
                },
              },
            }
          : {}),
      })
    : undefined;
  let modelFavorites: Array<{ provider: string; model: string }> = [];
  const pullReads: string[] = [];
  let viewedPanel = true;
  let viewedWritable = true;
  let viewedWrites = 0;
  let discussionResolved = true;
  let discussionWrites = 0;
  let discussionViewer = true;
  const postedReplies: {id:string;body:string;createdAt:string;author:{login:string}}[] = [];
  const pullFilters: string[] = [];
  let lastPullProject = "";
  const optionReads: {kind:string;query?:string;projectId?:string}[] = [];
  const serverConfig = () => ({
    settings: { favorites: modelFavorites, ...(threadTimeMode ? { snoozePresets: [{kind:"after", minutes:90}, {kind:"at", day:"tomorrow", time:"09:00"}] } : {}) },
    environment: {
      platform: { machine: secondary ? "laptop" : "mac-mini" },
      ...(threadTimeMode ? { capabilities: { threadSnooze: true, threadTitleRegeneration: !secondary, threadAutoSettleOptOut: !secondary } } : {}),
      ...(activities || attachments || controls
        ? { capabilities: { ...activities?.config, ...attachments?.config, ...controls?.config } }
        : {}),
    },
    ...(activities || markdown || controls || attachments || composer
      ? { threadResumeCompletionMarker: true }
      : {}),
    ...(controls || attachments ? { threadSnapshotPagination: true } : {}),
    ...(usageMode ? { usageLimitSources: [{id:"fixture-hub",label:"Fixture hub",accounts:[
      {id:"mirror.json",driver:"codex",email:"shared@example.test",usageLimits:{checkedAt:"2026-11-01T00:00:00Z",windows:[{id:"other-slot",kind:"weekly",label:"Weekly",usedPercent:100}]}},
      {id:"QA.json",driver:"codex",usageLimits:{checkedAt:timestamp,windows:[{id:"week",kind:"weekly",label:"Weekly",usedPercent:80},{id:"five-hour",kind:"session",label:"Session",usedPercent:35}]}},
    ]}] } : {}),
    providers: [
      {
        instanceId: "fixture-provider",
        driver: "codex",
        ...(usageMode ? { usageLimits: { checkedAt: timestamp, windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 24.5 }] } } : {}),
        installed: true,
        enabled: true,
        auth: { status: "authenticated", ...(usageMode ? { email:"shared@example.test" } : {}) },
        ...composer?.provider,
        models: ["fixture-model", "fixture-fast"].map((slug) => ({
          slug,
          name: slug === "fixture-model" ? "Fixture model" : "Fixture fast",
          shortName: slug === "fixture-model" ? "Fixture model" : "Fixture fast",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        })),
      },
    ],
  });
  const held: { socket: Socket; requestId: string }[] = [];
  let clockSubscription: string | undefined;
  const projects = (
    secondary
      ? [{ id: "remote", title: "Remote project" }]
      : [
          { id: "active", title: "Active project" },
          { id: "empty", title: "Empty project" },
        ]
  ).concat(pullsMode ? [{id:"shared",title:"Shared client"}] : []).map((project) => ({
    ...project,
    ...(markdown ? { workspaceRoot: markdown.workspaceRoot } : {}),
    ...(composer ? { workspaceRoot: composer.cwd } : {}),
  }));
  const threads = (secondary ? ["gamma"] : threadTimeMode ? ["alpha", "beta", "later", "soon", "build"] : ["alpha", "beta"])
    .map((id) => ({
      id,
      projectId: secondary ? "remote" : "active",
      title:
        id === "gamma" ? "Gamma remote thread" : id === "alpha" ? "Alpha thread" : id === "later" ? "Later nap" : id === "soon" ? "Soon nap" : id === "build" ? "Pinned build" : "Beta thread",
      status: "idle",
      runtimeMode: "full-access",
      updatedAt: timestamp,
      latestUserMessageAt: timestamp,
      ...(threadTimeMode && ["build", "later", "beta"].includes(id) ? { pinnedAt: timestamp, pinOrderKey: id === "beta" ? "betb" : id } : {}),
      ...(id === "build" ? { status: "running", latestRunId: "fixture-build" } : {}),
      ...(threadSearchMode && id === "alpha" ? {
        branch: "release/subscription-clock",
        pullRequests: [
          { repository: "fixture/ui", number: 72, url: "https://example.test/fixture/ui/pull/72", source: "manual", snapshot: { title: "Restore keyboard focus" } },
          { repository: "fixture/ui", number: 81, url: "https://example.test/fixture/ui/pull/81", source: "stack-dismissed" },
        ],
      } : {}),
      ...(threadTimeMode && id === "beta" ? { settledOverride: "settled", settledAt: "2026-11-09T13:00:00Z" } : {}),
      ...(id === "later" || id === "soon" ? { snoozedAt: timestamp, snoozedUntil: id === "soon" ? "2026-11-10T12:59:15Z" : "2026-11-10T16:30:00Z" } : {}),
      modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
    }))
    .concat(activities?.threads ?? []);
  const server = Bun.serve<SocketState>({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      const composerResponse = composer?.http(request);
      if (composerResponse) return composerResponse;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const attachmentResponse = await attachments?.http(request);
      if (attachmentResponse) return attachmentResponse;
      const controlsResponse = await controls?.http(request);
      if (controlsResponse) return controlsResponse;
      const markdownResponse = await markdown?.http(request);
      if (markdownResponse) return markdownResponse;
      const activityResponse = await activities?.http(request);
      if (activityResponse) return activityResponse;
      if (request.method === "POST") {
        if (pullsMode && path.startsWith("/fixture/discussion-viewer/")) {
          discussionViewer = path.endsWith("/allow");
          return json({discussionViewer});
        }
        if (pullsMode && path.startsWith("/assert/discussion-writes/")) return json({discussionWrites},path === `/assert/discussion-writes/${discussionWrites}` ? 200 : 409);
        if (pullsMode && path.startsWith("/fixture/viewed-permission/")) {
          viewedWritable = path.endsWith("/allow");
          return json({viewedWritable});
        }
        if (pullsMode && path.startsWith("/assert/viewed-writes/")) return json({viewedWrites}, path === `/assert/viewed-writes/${viewedWrites}` ? 200 : 409);
        if (pullsMode && path === "/api/pull-requests/diff") {
          const ref = await request.json();
          if (request.headers.get("authorization") !== "Bearer fixture-access" || ref.projectId !== "shared" || ref.repository !== `${id}/client` || !(ref.number === 9 || (secondary && ref.host === "second.test" && ref.number === 29)) || !["first.test", "second.test"].includes(ref.host)) return json({message:"Incorrect diff reference"}, 403);
          pullReads.push("diff");
          if (ref.commit !== undefined) {
            if (ref.commit !== "abcd1234" || ref.host !== "second.test" || ref.number !== 9 || (ref.cursor && ref.cursor !== "commit page / 1")) return json({message:"Incorrect commit scope"},400);
            const file = ref.cursor ? "src/final.ts" : "example";
            return json({patch:`diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n+commit-only ${file}`,truncated:!ref.cursor,nextCursor:ref.cursor ? null : "commit page / 1"});
          }
          if (ref.cursor && ref.cursor !== "after fixture/1") return json({message:"Invalid diff cursor"}, 400);
          if (ref.host === "first.test") return json({patch:`diff --git a/src/panel.test.ts b/src/panel.test.ts\n@@ -0,0 +1,3 @@\n+ok\n+\t  ${"very_long_name_".repeat(12)}é  \n+`, truncated:false, nextCursor:null});
          return ref.cursor ? json({patch:"diff --git a/docs/old.txt b/final.txt\nrename from docs/old.txt\nrename to final.txt\n--- a/docs/old.txt\n+++ b/final.txt\n@@ -1 +1 @@\n-old\n+last", truncated:false, nextCursor:null}) : json({patch:`diff --git a/example b/example\n--- a/example\n+++ b/example\n@@ -1 +1 @@\n-old\n+${ref.host}\n`, truncated:true, nextCursor:"after fixture/1", omittedFileStats:[{path:"omitted",additions:4,deletions:2}]});
        }
        if (pullsMode && path.startsWith("/assert/project/")) return json({lastPullProject}, lastPullProject === path.slice("/assert/project/".length) ? 200 : 409);
        if (pullsMode && path.startsWith("/assert/options/")) {
          const last = optionReads.at(-1);
          return json({optionReads}, (last ? [last.kind,last.projectId ?? "all",last.query ?? "empty"].join("/") : "none") === path.slice("/assert/options/".length) ? 200 : 409);
        }
        if (pullsMode && path.startsWith("/assert/filters/")) return json({pullFilters}, pullFilters.at(-1) === path.slice("/assert/filters/".length) ? 200 : 409);
        if (pullsMode && path.startsWith("/assert/pulls/")) {
          const expected = path.slice("/assert/pulls/".length);
          return json({reads: pullReads}, (pullReads.slice().sort().join(",") || "none") === expected ? 200 : 409);
        }
        if (threadTimeMode && (path === "/clock/start" || path === "/clock/check")) {
          const socket = readySocket(sockets);
          if (!socket || sockets.size !== 1) return refused("Expected one connected clock fixture");
          const identity = JSON.stringify([socket.data.serial, socket.data.shellRequest, socket.data.configRequest]);
          if (path === "/clock/start") clockSubscription = identity;
          return identity === clockSubscription ? json({ unchanged: true }) : refused("Clock replaced the connection or subscriptions");
        }
        const assertion = assertions(path, request.signal);
        if (assertion) return assertion;
      }
      if (path === "/api/auth/session" && !controls && !attachments) {
        return json({
          authenticated: true,
          scopes: ["orchestration:read", "orchestration:operate", ...(viewedWritable ? ["source-control:write"] : []), "filesystem:read", ...(usageMode ? ["diagnostics:read"] : [])],
        });
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
        const expected = {
          instanceId: "fixture-provider",
          model: "fixture-fast",
          options: [{ id: "effort", value: "high" }],
        };
        return runtime?.type === "thread.runtime-mode.set" &&
          runtime.runtimeMode === "approval-required" &&
          message?.type === "message.dispatch" &&
          JSON.stringify(message.modelSelection) === JSON.stringify(expected)
          ? json({ ok: true })
          : json(
              { error: "The selected model, reasoning and runtime were not dispatched in order." },
              409,
            );
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
      if (
        path === "/ws" &&
        new URL(request.url).searchParams.get("wsTicket") === "fixture-ticket"
      ) {
        return server.upgrade(request, {
          data: { serial: ++nextSocket, shell: false, config: false },
        })
          ? undefined
          : json({ error: "Upgrade failed" }, 400);
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
        if (
          composer?.receive(socket, frame) ||
          attachments?.receive(socket, frame) ||
          controls?.receive(socket, frame) ||
          markdown?.receive(socket, frame) ||
          activities?.receive(socket, frame) ||
          projectFixture(id).receive(socket, frame)
        ) {
          changed();
          return;
        }
        if (frame._tag !== "Request") return;
        if (frame.tag === "orchestration.subscribeShell") {
          socket.data.shell = true;
          socket.data.shellRequest = frame.id;
          chunk(socket, frame.id, {
            kind: "snapshot",
            snapshot: {
              projects,
              threads: [
                ...threads,
                ...(markdown?.threads ?? []),
                ...(controls?.threads ?? []),
                ...(attachments?.threads ?? []),
                ...(composer?.threads ?? []),
              ],
            },
          });
        } else if (threadTimeMode && frame.tag === "orchestration.dispatchCommand" && ["thread.pin", "thread.unpin", "thread.snooze", "thread.unsnooze", "thread.metadata.update", "thread.auto-settle.set", "thread.settle", "thread.unsettle"].includes(frame.payload.type)) {
          const row = threads.find(thread => thread.id === frame.payload.threadId);
          if (!row || !frame.payload.commandId) throw new Error("List command missing thread or command identifier");
          if (frame.payload.type === "thread.metadata.update") Object.assign(row, frame.payload.regenerateTitle === true ? { titleRegeneration: { requestId: frame.payload.commandId, startedAt: timestamp } } : { title: frame.payload.title });
          else if (frame.payload.type === "thread.auto-settle.set") {
            if (secondary || typeof frame.payload.enabled !== "boolean") throw new Error("Invalid auto-settle command");
            Object.assign(row, { autoSettleDisabledAt: frame.payload.enabled ? null : timestamp });
          } else if (frame.payload.type === "thread.pin") Object.assign(row, { pinnedAt: timestamp, pinOrderKey: frame.payload.orderKey, snoozedAt: null, snoozedUntil: null });
          else if (frame.payload.type === "thread.snooze") Object.assign(row, { snoozedAt: timestamp, snoozedUntil: frame.payload.snoozedUntil });
          else if (frame.payload.type === "thread.unsnooze") Object.assign(row, { snoozedAt: null, snoozedUntil: null });
          else if (frame.payload.type === "thread.settle") Object.assign(row, { settledOverride: "settled", settledAt: timestamp, pinnedAt: null, pinOrderKey: null, snoozedAt: null, snoozedUntil: null });
          else if (frame.payload.type === "thread.unsettle") {
            if (frame.payload.reason !== "user") throw new Error("Missing explicit un-settle reason");
            Object.assign(row, { settledOverride: "active", settledAt: null });
          }
          else Object.assign(row, { pinnedAt: null, pinOrderKey: null });
          accepted(socket, frame.id);
          for (const peer of sockets) if (peer.data.shellRequest) chunk(peer, peer.data.shellRequest, { kind: "thread.updated", location: "active", thread: row });
        } else if (pullsMode && ["pullRequests.replyToThread","pullRequests.setThreadResolution"].includes(frame.tag)) {
          const target = frame.payload;
          if (secondary || !discussionViewer || !viewedWritable || target.projectId !== "shared" || target.repository !== `${id}/client` || target.number !== 9 || target.host !== "second.test" || target.threadId !== "resolved") throw new Error("Unauthorized or misdirected discussion mutation");
          discussionWrites++;
          if (frame.tag === "pullRequests.replyToThread" && target.body === "fixture rejected") {
            socket.send(JSON.stringify({_tag:"Exit",requestId:frame.id,exit:{_tag:"Failure",cause:[{_tag:"Fail",error:{message:"Fixture rejected the reply."}}]}}));
            return;
          }
          if (frame.tag === "pullRequests.setThreadResolution" && typeof target.resolved === "boolean") discussionResolved = target.resolved;
          else if (frame.tag === "pullRequests.replyToThread" && typeof target.body === "string" && target.body.trim()) postedReplies.push({id:`posted-${postedReplies.length+1}`,body:target.body,createdAt:"2026-01-05",author:{login:"otter"}});
          else throw new Error("Invalid discussion mutation payload");
          socket.send(JSON.stringify({_tag:"Exit",requestId:frame.id,exit:{_tag:"Success",value:null}}));
        } else if (pullsMode && frame.tag === "pullRequests.threadComments") {
          const ref = frame.payload;
          if (ref.projectId !== "shared" || ref.repository !== `${id}/client` || ![9,29].includes(ref.number) || ref.host !== "second.test" || ref.threadId !== "resolved" || ref.cursor !== "older / page 1") throw new Error("Incorrect discussion target");
          const value = {comments:[{id:"older",author:{login:"river"},body:"First reply",createdAt:"2026-01-01"},{id:"thread-post",body:"Stale duplicate",createdAt:"2026-01-04"}],nextCursor:secondary ? ref.cursor : null,hiddenCount:1};
          socket.send(JSON.stringify({_tag:"Exit",requestId:frame.id,exit:{_tag:"Success",value}}));
        } else if (pullsMode && frame.tag === "pullRequests.filterOptions") {
          const input = frame.payload;
          if (!["authors","labels"].includes(input.kind) || (input.query && input.query.length > 100)) throw new Error("Invalid facet request");
          optionReads.push(input);
          const matches = (name:string)=>!input.query || name.includes(input.query.toLowerCase());
          const labels = input.kind === "labels" ? ["host-only","host-slow"].filter(matches).map(name=>({name,color:"00aabb"})) : [];
          const authors = input.kind === "authors" ? ["offpage-author"].filter(matches).map(login=>({login})) : [];
          const respond = ()=>socket.send(JSON.stringify({_tag:"Exit",requestId:frame.id,exit:{_tag:"Success",value:{labels,authors,truncated:false}}}));
          if (input.query === "slow") setTimeout(respond,550);
          else respond();
        } else if (pullsMode && frame.tag.startsWith("pullRequests.")) {
          const method = frame.tag.slice("pullRequests.".length);
          pullReads.push(method);
          const repository = `${id}/client`;
          const offPage = secondary && frame.payload.host === "second.test" && frame.payload.number === 29;
          if (method !== "list" && (frame.payload.projectId !== "shared" || frame.payload.repository !== repository || (!offPage && frame.payload.number !== 9) || !["first.test", "second.test"].includes(frame.payload.host))) throw new Error("Incorrect pull request coordinates");
          const entries = ["first.test", "second.test"].map(host => ({host, projectId: "shared", repository, number: 9, title: host === "first.test" ? "Keep the status column aligned when a long pull request title wraps onto its second line" : "Adjust safe-area spacing", headBranch: "fix", baseBranch: "main", author: {login: "juniper"}, additions: 18, updatedAt: timestamp,
            ...(host === "first.test" ? {mergeability: "conflicting", checksState: "failing", viewerReviewRequested: true, stack: {position: 1, size: 3}, labels: [{name:"accessibility and keyboard navigation",color:"a855f7"},{name:"appearance",color:"0ea5e9"},{name:"triage",color:null}],deletions: 4} : {isDraft: true})}));
          if (method === "list") pullFilters.push(`${frame.payload.state}-${frame.payload.involvement}`);
          if (method === "list") lastPullProject = frame.payload.projectId ?? "";
          const listed = frame.payload.state === "closed" ? [] : entries.filter(entry => frame.payload.involvement !== "reviewing" || entry.host === "first.test").map(entry => ({...entry, state: frame.payload.state === "merged" ? "merged" : "open"}));
          const paged = frame.payload.query === "pages";
          const continued = frame.payload.cursors?.fixture === "page-2";
          if (paged && continued && listed.length) listed.push({...listed[0]!,number:19,title:"More pages"});
          const value = method === "list" ? {entries: listed, providers: [{host:"first.test",searchesOnHost:false},{host:"second.test",searchesOnHost:true}], viewers:{"first.test":"juniper","second.test":"otter"}, errors: secondary || frame.payload.state !== "open" ? [] : [{ projectTitle: "Unavailable project", message: "Offline" }]} : method === "activity" ? {comments: [{id: `${id}-${frame.payload.host}`, body:"Fixture review",author:{login:"juniper"},kind:"comment",createdAt:"2026-01-02"},{id:"automated",body:"Builder noise",author:{login:"build",isBot:true},createdAt:"2026-01-03"},{id:"thread-post",body:"Nested copy"}], commits:[{oid:"abcd1234",messageHeadline:"Change spacing",authors:[{login:"juniper"}],committedDate:"2026-01-01"}],reviewThreads:[{id:"resolved",path:"example",line:8,isResolved:true,commentCount:3,nextCommentsCursor:"older / page 1",comments:[{id:"thread-post",author:{login:"reviewer"},body:"Fixed",createdAt:"2026-01-04"}]}],commentsTruncated:true} : {body: `${id} details`, changedFiles: 0, additions: 0, deletions: 0};
          if (method === "setFilesViewed") {
            const change = frame.payload.files?.[0];
            if (!viewedWritable || frame.payload.host !== "first.test" || frame.payload.files?.length !== 1 || change?.path !== "src/panel.test.ts" || typeof change.viewed !== "boolean") throw new Error("Invalid viewed write");
            viewedPanel = change.viewed;
            viewedWrites++;
          }
          const detail = method === "setFilesViewed" ? null : method === "filesViewed" ? {files:[{path:"src/panel.test.ts",state:viewedPanel ? "viewed" : "unviewed"},{path:"example",state:"dismissed"}],truncated:false} : method === "detail" && frame.payload.host === "first.test" ? {...entries[0],...value,state:"open",changedFiles:1,additions:1234,deletions:0,title:"Updated title from the environment after the list was loaded",headBranch:"feature/keyboard-focus-and-accessibility-when-a-review-branch-has-a-long-name",capabilities:{viewedFiles:"host"}} : method === "detail" && offPage ? {...value,projectId:"shared",host:"second.test",repository,number:29,title:"Archived keyboard change",state:"merged",updatedAt:timestamp,baseBranch:"main",headBranch:"fix"} : value;
          if (method === "detail" && detail && "body" in detail) {
            Object.assign(detail,{url:frame.payload.host === "first.test" ? `https://review.example.invalid/${repository}/pull/9?tab=details#overview` : ""});
            if (offPage) detail.body = "  \n";
            else if (frame.payload.host === "first.test") detail.body = ["## Keyboard changes", ...Array.from({length:15}, (_, index) => `- Verify **alignment** for row ${index + 1}`), "", "Final paragraph with `shortcuts` and [documentation](https://example.invalid/guide)."].join("\n");
          }
          if (!secondary && frame.payload.host === "second.test" && frame.payload.number === 9) {
            if (method === "detail" && detail) Object.assign(detail,entries[1],{state:"open",additions:0,capabilities:{review:{reply:true,resolve:true}},viewerPermissions:{comment:discussionViewer,resolve:discussionViewer}});
            if (method === "activity" && value.reviewThreads) Object.assign(value.reviewThreads[0]!,{isResolved:discussionResolved,commentCount:3+postedReplies.length,comments:[...value.reviewThreads[0]!.comments,...postedReplies]});
          }
          const answerPull = () => socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: method === "list" && paged ? {...value, nextCursors:continued ? {} : {fixture:"page-2"}} : detail } }));
          if (method === "list" && paged && continued) setTimeout(answerPull, 400);
          else answerPull();
        } else if (frame.tag === "server.getUsageSummary" && usageMode) {
          const count = frame.payload.resolution === "hour" ? 2 : 10;
          const periods = [
            [frame.payload.sinceDay, frame.payload.sinceTime, "codex", count, 0.5],
            [frame.payload.sinceDay, frame.payload.sinceTime, "claude", 2, 0.25],
            [frame.payload.untilDay, frame.payload.untilTime ? new Date(Date.parse(frame.payload.untilTime) - 3600000).toISOString() : undefined, "claude", 3, frame.payload.awaitRefresh ? 0.75 : 0.25],
          ];
          socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: {
            contractVersion: 6, buckets: periods.map(([day, hourStart, provider, tokens, costUsd]) => ({ day, hourStart, provider, totals: { uncachedInputTokens: tokens, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 },
              records: 1, unpricedRecords: 0, costUsd })), sources: [{status: "ok", distinctSessions: 1}],
          } } }));
        } else if (frame.tag === "subscribeServerConfig") {
          socket.data.config = true;
          socket.data.configRequest = frame.id;
          chunk(socket, frame.id, { type: "snapshot", config: serverConfig() });
        } else if (frame.tag === "server.updateSettings") {
          for (const favorite of frame.payload.patch.setModelFavorites ?? []) {
            modelFavorites = modelFavorites.filter(
              (entry) => entry.provider !== favorite.provider || entry.model !== favorite.model,
            );
            if (favorite.favorite)
              modelFavorites.push({ provider: favorite.provider, model: favorite.model });
          }
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: { favorites: modelFavorites } },
            }),
          );
        } else if (frame.tag === "orchestration.searchThreads") {
          const query = String(frame.payload.query).trim().toLowerCase();
          const matches = conversation.toLowerCase().includes(query) ? threads
            .filter(thread => !frame.payload.projectIds || frame.payload.projectIds.includes(thread.projectId))
            .map(thread => ({ threadId: thread.id, projectId: thread.projectId, source: "assistant", snippet: conversation, messageCreatedAt: timestamp })) : [];
          socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { matches } } }));
        } else if (frame.tag === "orchestration.subscribeThread") {
          chunk(socket, frame.id, {
            kind: "snapshot",
            projection: {
              messages: [
                {
                  id: `${frame.payload.threadId}-message`,
                  role: "assistant",
                  text: conversation,
                  createdAt: timestamp,
                },
              ],
            },
          });
          if (activities || markdown || controls || attachments)
            chunk(socket, frame.id, { kind: "synchronized" });
        } else if (
          frame.tag === "orchestration.dispatchCommand" &&
          (frame.payload.type === "thread.runtime-mode.set" ||
            frame.payload.text === "Send chosen settings")
        ) {
          settingsCommands.push(frame.payload);
          accepted(socket, frame.id);
        } else if (
          secondary &&
          frame.tag === "orchestration.dispatchCommand" &&
          frame.payload.threadId === "gamma" &&
          frame.payload.text === "Accept on secondary"
        ) {
          secondaryAccepted++;
          accepted(socket, frame.id);
        } else if (
          frame.tag === "orchestration.dispatchCommand" &&
          frame.payload.text === "Accept after release"
        ) {
          held.push({ socket, requestId: frame.id });
        } else {
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { message: "Fixture rejected the message." } }],
              },
            }),
          );
        }
        changed();
      },
      close(socket) {
        sockets.delete(socket);
        markdown?.close(socket);
        activities?.close(socket);
        controls?.close(socket);
        attachments?.close(socket);
        composer?.close(socket);
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
const secondary = environment(
  "secondary",
  "Fixture Laptop",
  true,
  fixturePorts.get("--secondary-port"),
);
const tertiary = thirdEnvironment
  ? environment("tertiary", "Fixture Third Mac", true, fixturePorts.get("--third-port"))
  : undefined;
const readySocket = (sockets: Set<Socket>) =>
  sockets.size === 1
    ? [...sockets].find((socket) => socket.data.shell && socket.data.config)
    : undefined;
const topology = () => ({
  primary: [...primary.sockets].map((socket) => socket.data.serial),
  secondary: [...secondary.sockets].map((socket) => socket.data.serial),
});
const refused = (error: string) => json({ error, ...topology() }, 409);

function assertions(path: string, signal: AbortSignal): Promise<Response> | Response | undefined {
  if (path === "/checkpoint")
    return barrier(signal, () => {
      if (primary.sockets.size > 1 || secondary.sockets.size > 1)
        return refused("An environment opened duplicate sockets");
      const a = readySocket(primary.sockets),
        b = readySocket(secondary.sockets);
      if (!a || !b) return;
      checkpoint = { primary: a.data.serial, secondary: b.data.serial };
      secondaryAccepted = 0;
      return json(topology());
    });
  if (
    ![
      "/assert/both",
      "/await/secondary-only",
      "/await/restored",
      "/assert/sent-secondary",
    ].includes(path)
  )
    return;
  const baseline = checkpoint;
  if (!baseline) return refused("Capture both connections with /checkpoint first");
  return barrier(signal, () => {
    if (readySocket(secondary.sockets)?.data.serial !== baseline.secondary) {
      return refused("The secondary connection closed or was replaced");
    }
    if (path === "/assert/sent-secondary") {
      return secondaryAccepted > 0
        ? json({ accepted: secondaryAccepted })
        : refused("The secondary environment received no message");
    }
    if (primary.sockets.size > 1)
      return refused("The primary environment opened duplicate sockets");
    const a = readySocket(primary.sockets);
    if (path === "/assert/both") {
      return a?.data.serial === baseline.primary
        ? json(topology())
        : refused("Filtering closed or replaced the primary connection");
    }
    if (path === "/await/secondary-only")
      return primary.sockets.size === 0 ? json(topology()) : undefined;
    return a && a.data.serial !== baseline.primary ? json(topology()) : undefined;
  });
}

const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "exact-t3-regression-"));
try {
  const [host = "ios", ...flags] = exactArguments;
  if (host === "--serve") {
    console.log(
      JSON.stringify({
        primary: primary.server.url.origin,
        secondary: secondary.server.url.origin,
        ...(tertiary ? { tertiary: tertiary.server.url.origin } : {}),
        code: "fixture-code",
      }),
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
    const file = NodePath.join(directory, "home-regression.test.contract");
    const source = await NodeFSP.readFile(
      NodePath.join(import.meta.dir, pullsMode ? "pull-requests.test.contract" : threadSearchMode ? "thread-search.test.contract" : threadTimeMode ? "thread-time.test.contract" : usageMode ? "usage-regression.test.contract" : composerMode ? "composer-regression.test.contract" : "home-regression.test.contract"),
      "utf8",
    );
    await NodeFSP.writeFile(
      file,
      source
        .replaceAll("http://127.0.0.1:0", primary.server.url.origin)
        .replaceAll("http://127.0.0.2:0", secondary.server.url.origin),
    );
    const child = Bun.spawn([process.execPath, "exact.mjs", "test", host, file, ...flags], {
      cwd: app,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
  }
} finally {
  await Promise.all([
    primary.server.stop(true),
    secondary.server.stop(true),
    tertiary?.server.stop(true),
  ]);
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
