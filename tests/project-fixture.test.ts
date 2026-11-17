import { expect, test } from "bun:test";
import {
  browseFilesystem,
  cancelProjectClone,
  createNewProject,
  createProject,
  discoverSourceControl,
  ensureScratchProject,
  lookupRepository,
  parseProjectClones,
  startProjectClone,
  type RpcSession,
} from "../project-rpc";
import { ProjectFixture } from "../tools/project-fixture";

type Frame = { _tag: string; requestId: string; values?: unknown[]; exit?: { _tag: string; value?: unknown; cause?: { error: { message: string } }[] } };

function connect(fixture: ProjectFixture) {
  const frames: Frame[] = [];
  let next = 0;
  const socket = { send: (data: string) => void frames.push(JSON.parse(data)), data: { shellRequest: "shell" } };
  const rpc: RpcSession = {
    async query(tag, payload) {
      const id = String(++next);
      expect(fixture.receive(socket, { _tag: "Request", id, tag, payload, headers: [] })).toBe(true);
      const exit = frames.find((frame) => frame._tag === "Exit" && frame.requestId === id)?.exit;
      if (exit?._tag === "Success") return exit.value;
      const error = exit?.cause?.[0]?.error;
      throw Object.assign(new Error(error?.message ?? "no reply"), { detail: error });
    },
  };
  return { rpc, socket, frames };
}

test("the fixture answers discovery, browsing and lookup through the typed calls", async () => {
  const fixture = new ProjectFixture("fixture");
  const { rpc } = connect(fixture);
  const discovery = await discoverSourceControl(rpc);
  expect(discovery.providers[0]).toMatchObject({ kind: "github", available: true, auth: { account: "fixture-user" } });
  const listing = await browseFilesystem(rpc, "~/");
  expect(listing.ok && listing.entries.map((entry) => entry.name)).toContain("Projects");
  expect(await browseFilesystem(rpc, "~/missing/")).toMatchObject({ ok: false, failure: "read_directory_failed", pathMissing: true });
  expect(await lookupRepository(rpc, { provider: "github", repository: "octocat/Hello-World" })).toEqual({
    provider: "github",
    nameWithOwner: "octocat/Hello-World",
    url: "https://github.com/octocat/Hello-World.git",
    sshUrl: "git@github.com:octocat/Hello-World.git",
  });
  await expect(lookupRepository(rpc, { provider: "github", repository: "octocat" })).rejects.toThrow("Repository octocat was not found.");
  expect(fixture.calls.map((call) => call.tag)).toEqual([
    "server.discoverSourceControl",
    "filesystem.browse",
    "filesystem.browse",
    "sourceControl.lookupRepository",
    "sourceControl.lookupRepository",
  ]);
});

test("created projects reach the shell stream", async () => {
  const fixture = new ProjectFixture("fixture");
  const { rpc, frames } = connect(fixture);
  await createProject(rpc, { commandId: "c1", projectId: "p1", title: "app", workspaceRoot: "/Users/fixture/app" });
  const created = await createNewProject(rpc, "My App");
  expect(created).toEqual({ projectId: "new-1", workspaceRoot: "/Users/fixture/projects/my-app", commitError: null });
  expect(await ensureScratchProject(rpc)).toBe("scratch");
  const shellProjects = frames
    .filter((frame) => frame._tag === "Chunk" && frame.requestId === "shell")
    .map((frame) => (frame.values![0] as { project: { id: string } }).project.id);
  expect(shellProjects).toEqual(["p1", "new-1", "scratch"]);
});

test("clone progress streams to subscribers and follows cancel", async () => {
  const fixture = new ProjectFixture("fixture");
  const { rpc, socket, frames } = connect(fixture);
  fixture.receive(socket, { _tag: "Request", id: "clones", tag: "subscribeProjectClones", payload: {}, headers: [] });
  await startProjectClone(rpc, {
    projectId: "p2",
    title: "Hello-World",
    createdAt: "2026-11-17T00:00:00.000Z",
    remoteUrl: "https://github.com/octocat/Hello-World.git",
    destinationPath: "~/Hello-World",
  });
  expect(await cancelProjectClone(rpc, "p2")).toBe(true);
  const events = frames.filter((frame) => frame._tag === "Chunk" && frame.requestId === "clones").map((frame) => parseProjectClones(frame.values![0]));
  expect(events.map((clones) => clones.map((clone) => clone.phase))).toEqual([[], ["running"], ["cancelled"]]);
});
