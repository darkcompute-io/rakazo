import { describe, expect, it } from "vitest";
import type { RegistryEntry } from "./agentloom-registry.js";
import { toolViewFrom } from "./agentloom-view.js";

const entries = [
  { endpoint: "https://phones.example/api/mcp", open: "https://phones.example" },
] as RegistryEntry[];
const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
const live = { kind: "live", title: "iPhone", url: "https://phones.example/api/sessions/a/stream" };

describe("toolViewFrom", () => {
  it("reads a live view from an app's answer, wrapped or not", () => {
    const direct = toolViewFrom(
      "mcp__dc-phone__open_session",
      text({ id: "a", view: live }),
      entries,
    );
    expect(direct).toEqual({ view: "live", title: "iPhone", url: live.url });
    const wrapped = text({ content: [{ type: "text", text: JSON.stringify({ view: live }) }] });
    expect(toolViewFrom("connectors_execute_tool", wrapped, entries)?.url).toBe(live.url);
  });

  it("refuses an address outside the registry's hosts", () => {
    for (const url of [
      "https://evil.example/x.png",
      "http://phones.example/x",
      "https://me@phones.example/x",
      "javascript:alert(1)",
    ]) {
      expect(
        toolViewFrom("mcp__dc-phone__x", text({ view: { kind: "live", url } }), entries),
      ).toBeNull();
    }
    const mixed = {
      kind: "media",
      images: [
        { url: "https://evil.example/a.png" },
        { url: "https://phones.example/b.png", caption: "b" },
      ],
    };
    expect(toolViewFrom("mcp__dc-phone__x", text({ view: mixed }), entries)?.images).toEqual([
      { url: "https://phones.example/b.png", caption: "b" },
    ]);
  });

  it("listens only to connector tools, and not with no registry", () => {
    expect(toolViewFrom("web_fetch", text({ view: live }), entries)).toBeNull();
    expect(toolViewFrom("mcp__dc-phone__x", text({ view: live }), [])).toBeNull();
    expect(
      toolViewFrom("mcp__dc-phone__x", [{ type: "text", text: "not json" }], entries),
    ).toBeNull();
  });
});
