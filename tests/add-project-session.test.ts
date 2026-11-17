import { expect, test } from "bun:test";
import { DirectSession } from "../connection";
import { browseFilesystem } from "../project-rpc";

type Frame = { _tag: string; id: string; tag: string; payload: Record<string, unknown> };

function connected() {
  const sent: Frame[] = [];
  const session = new DirectSession({
    id: "env",
    label: "Mac",
    url: "http://localhost:13773",
    enabled: true,
    status: "Connecting",
    machineSymbol: "server.rack",
  });
  session.open({
    readyState: 1,
    bufferedAmount: 0,
    send: (frame) => void sent.push(JSON.parse(String(frame)) as Frame),
    close() {},
  });
  const requestFor = (tag: string) => sent.find((frame) => frame._tag === "Request" && frame.tag === tag);
  return { session, sent, requestFor };
}

const snapshot = (phase: string) => ({
  projectId: "p1",
  remoteUrl: "https://github.com/octocat/Hello-World.git",
  destinationPath: "/repos/Hello-World",
  repository: null,
  phase,
  stage: "receiving",
  percent: 42,
  detail: "1.2 MiB/s",
  error: null,
  startedAt: "2026-11-17T00:00:00Z",
  endedAt: null,
  sequence: 1,
});

test("the clone list is unknown until the stream's first event, then follows each event", () => {
  const { session, requestFor } = connected();
  expect(session.projectClones()).toBeNull();
  const request = requestFor("subscribeProjectClones");
  expect(request?.payload).toEqual({});
  session.projectClones();
  expect(session.projectClones()).toBeNull();

  session.receive(JSON.stringify({ _tag: "Chunk", requestId: request!.id, values: [[snapshot("running")]] }));
  expect(session.projectClones()?.map((clone) => clone.phase)).toEqual(["running"]);

  session.receive(JSON.stringify({ _tag: "Chunk", requestId: request!.id, values: [[snapshot("done")]] }));
  expect(session.projectClones()?.map((clone) => clone.phase)).toEqual(["done"]);
});

test("a failed clone stream reads as an empty list", () => {
  const { session, requestFor } = connected();
  expect(session.projectClones()).toBeNull();
  const request = requestFor("subscribeProjectClones")!;
  session.receive(
    JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "nope" } }] } }),
  );
  expect(session.projectClones()).toEqual([]);
});

test("a browse refusal keeps the server's failure fields", async () => {
  const { session, sent } = connected();
  const browsing = browseFilesystem(session.rpc, "/repos/missing/");
  const request = sent.find((frame) => frame.tag === "filesystem.browse")!;
  expect(request.payload).toEqual({ partialPath: "/repos/missing/" });
  session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: {
              _tag: "FilesystemBrowseError",
              failure: "read_directory_failed",
              pathMissing: true,
              message: "Failed to browse filesystem path '/repos/missing/'.",
            },
          },
        ],
      },
    }),
  );
  expect(await browsing).toEqual({
    ok: false,
    failure: "read_directory_failed",
    pathMissing: true,
    message: "Failed to browse filesystem path '/repos/missing/'.",
  });
});
