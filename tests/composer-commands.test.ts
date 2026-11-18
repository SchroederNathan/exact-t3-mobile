import { describe, expect, test } from "bun:test";
import {
  buildComposerModelItems,
  buildComposerPathItems,
  buildComposerSkillItems,
  buildComposerSlashCommandItems,
  composerCommandInsertion,
} from "../composer-commands";

describe("composer command catalog", () => {
  test("only exposes provider commands at the beginning of a prompt", () => {
    const start = buildComposerSlashCommandItems({
      query: "",
      atMessageStart: true,
      offersFreshSession: true,
      providerCommands: [
        { name: "compact", description: "Compact the session" },
        { name: "clear", description: "Provider clear" },
      ],
    });
    expect(start.map((item) => item.label)).toEqual(["/model", "/clear", "/compact"]);
    const prose = buildComposerSlashCommandItems({
      query: "",
      atMessageStart: false,
      providerCommands: [{ name: "compact" }],
    });
    expect(prose.map((item) => item.label)).toEqual(["/model"]);
  });

  test("filters conversation-only provider commands from a new draft", () => {
    const items = buildComposerSlashCommandItems({
      query: "",
      atMessageStart: true,
      hasThread: false,
      hasCompactableConversation: false,
      providerDriver: "codex",
      providerCommands: [
        { name: "compact" },
        { name: "feedback" },
        { name: "review" },
      ],
    });
    expect(items.map((item) => item.label)).toEqual(["/model", "/review"]);
  });

  test("filters skills by enabled and user-invocable state", () => {
    const items = buildComposerSkillItems(
      [
        { name: "review", path: "/review", enabled: true, displayName: "Review" },
        { name: "hidden", path: "/hidden", enabled: true, userInvocable: false },
        { name: "off", path: "/off", enabled: false },
      ],
      "rev",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("Review");
  });

  test("creates escaped markdown file links and path rows", () => {
    const items = buildComposerPathItems(
      [{ path: "src/My File (draft).ts", kind: "file" }, { path: "src/components", kind: "directory" }],
      "src",
    );
    expect(items[0]?.label).toBe("My File (draft).ts");
    expect(items[1]?.kind).toBe("directory");
    expect(composerCommandInsertion(items[0]!)).toBe(
      "[My File (draft).ts](src/My%20File%20%28draft%29.ts) ",
    );
  });

  test("ranks model mentions and omits unavailable legacy models", () => {
    const items = buildComposerModelItems(
      [
        { instanceId: "codex", slug: "gpt-6", name: "GPT-6", provider: "Codex" },
        { instanceId: "codex", slug: "gpt-5", name: "GPT-5", provider: "Codex", available: false },
        { instanceId: "old", slug: "legacy", name: "Legacy", provider: "Old", legacy: true },
      ],
      "gpt-6",
    );
    expect(items.map((item) => item.id)).toEqual(["model:codex:gpt-6"]);
    expect(composerCommandInsertion(items[0]!)).toBe("model:codex/gpt-6 ");
  });
});
