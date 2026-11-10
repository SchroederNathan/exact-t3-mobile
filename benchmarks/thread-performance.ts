import { DirectSession } from "../connection";

type Trial = { readonly messages: number; readonly parseMs: number; readonly readMs: number };

function socket(sent: string[]) {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send(frame: string) {
      sent.push(String(frame));
    },
    close() {},
  };
}

function run(messages: number): Trial {
  const sent: string[] = [];
  const session = new DirectSession({
    id: "benchmark",
    label: "Benchmark",
    url: "http://localhost:13773",
    enabled: true,
    status: "Connecting",
    machineSymbol: "server.rack",
  });
  session.open(socket(sent));
  session.receive(
    JSON.stringify({
      _tag: "Chunk",
      requestId: "1",
      values: [
        {
          kind: "snapshot",
          snapshot: {
            projects: [{ id: "project", title: "Benchmark" }],
            threads: [{ id: "thread", projectId: "project", title: "Long thread", status: "idle" }],
          },
        },
      ],
    }),
  );
  session.select("thread");
  const threadRequest = sent
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.tag === "orchestration.subscribeThread");
  const started = performance.now();
  const projection = {
    messages: Array.from({ length: messages }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      runId: `run-${Math.floor(index / 2)}`,
      text: index % 2 === 0 ? `Prompt ${index}` : `## Response ${index}\n\n- checked ${index}`,
      streaming: false,
      createdAt: "2026-11-10T12:00:00Z",
      updatedAt: "2026-11-10T12:00:00Z",
    })),
    visibleTurnItems: Array.from({ length: Math.floor(messages / 4) }, (_, index) => ({
      position: index,
      visibility: "local",
      sourceThreadId: "thread",
      sourceItemId: `tool-${index}`,
      item: {
        id: `tool-${index}`,
        threadId: "thread",
        runId: `run-${index}`,
        type: "command_execution",
        status: "completed",
        title: "Inspect workspace",
        input: `rg --files src/${index}`,
        startedAt: "2026-11-10T12:00:00Z",
        updatedAt: "2026-11-10T12:00:00Z",
      },
    })),
  };
  session.receive(
    JSON.stringify({
      _tag: "Chunk",
      requestId: threadRequest.id,
      values: [{ kind: "snapshot", projection }],
    }),
  );
  const parseMs = performance.now() - started;
  const readStarted = performance.now();
  const result = session.threads();
  const readMs = performance.now() - readStarted;
  if (result[0]?.messages.length !== messages) throw new Error("benchmark fixture did not load");
  return { messages, parseMs, readMs };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const sizes = [1000, 5000];
const trials: Trial[] = [];
for (const size of sizes) {
  run(size);
  for (let index = 0; index < 5; index += 1) trials.push(run(size));
}

const summary = sizes.map((messages) => {
  const rows = trials.filter((trial) => trial.messages === messages);
  return {
    messages,
    runs: rows.length,
    parseMedianMs: median(rows.map((row) => row.parseMs)),
    parseRangeMs: [Math.min(...rows.map((row) => row.parseMs)), Math.max(...rows.map((row) => row.parseMs))],
    readMedianMs: median(rows.map((row) => row.readMs)),
    readRangeMs: [Math.min(...rows.map((row) => row.readMs)), Math.max(...rows.map((row) => row.readMs))],
  };
});

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2));
