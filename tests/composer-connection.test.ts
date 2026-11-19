import { expect, test } from "bun:test";
import { DirectSession } from "../connection";

type Request = { _tag: string; id: string; tag: string; payload: Record<string, unknown> };

function sessionFixture() {
  const requests: Request[] = [];
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
    send(frame) {
      const request = JSON.parse(String(frame)) as Request;
      if (request._tag === "Request") requests.push(request);
    },
    close() {},
  });
  return { session, requests };
}

test("composer message dispatch includes validated context and fresh-context flag", async () => {
  const fixture = sessionFixture();
  const sending = fixture.session.send(
    "thread",
    "Use this file",
    "command",
    "message",
    null,
    [],
    false,
    { context: JSON.stringify({ version: 1, records: [{ kind: "file" }] }), freshContext: true },
  );
  const request = fixture.requests.find((entry) => entry.tag === "orchestration.dispatchCommand");
  expect(request?.payload).toMatchObject({
    type: "message.dispatch",
    context: { version: 1, records: [{ kind: "file" }] },
    freshContext: true,
  });
  fixture.session.receive(
    JSON.stringify({ _tag: "Exit", requestId: request!.id, exit: { _tag: "Success", value: {} } }),
  );
  await expect(sending).resolves.toMatchObject({ ok: true, state: "accepted" });
});

test("composer path search uses the server projects.searchEntries wire payload", async () => {
  const fixture = sessionFixture();
  const searching = fixture.session.searchComposerEntries("/workspace", "App", 42);
  const request = fixture.requests.find((entry) => entry.tag === "projects.searchEntries");
  expect(request?.payload).toEqual({ cwd: "/workspace", query: "App", limit: 42 });
  fixture.session.receive(
    JSON.stringify({
      _tag: "Exit",
      requestId: request!.id,
      exit: { _tag: "Success", value: { entries: [{ path: "src/App.ts", kind: "file" }], truncated: false } },
    }),
  );
  await expect(searching).resolves.toEqual({
    entries: [{ path: "src/App.ts", kind: "file" }],
    truncated: false,
  });
});
