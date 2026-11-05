import { describe, expect, it } from "vitest";
import { toolCompletionAuditPayload } from "./tool-completion-audit.js";

describe("a registry app's view", () => {
  const registry = JSON.stringify({
    apps: [{ id: "phone", name: "Phones", endpoint: "https://phones.example/api/mcp" }],
  });
  it("is read from a connector's answer, which is not an auditable result", () => {
    const before = process.env.AGENTLOOM_REGISTRY;
    process.env.AGENTLOOM_REGISTRY = registry;
    try {
      const view = { kind: "live", title: "iPhone", url: "https://phones.example/s/a/stream" };
      const payload = toolCompletionAuditPayload({
        name: "connectors_execute_tool",
        executionId: "e1",
        durationMs: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ id: "a", view }) }],
          details: {},
        },
      });
      expect(payload.view).toEqual({ view: "live", title: "iPhone", url: view.url });
    } finally {
      if (before === undefined) delete process.env.AGENTLOOM_REGISTRY;
      else process.env.AGENTLOOM_REGISTRY = before;
    }
  });
});
