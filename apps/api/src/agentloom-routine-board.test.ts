import { describe, expect, it } from "vitest";
import { routineBoard } from "./agentloom-routine-board.js";

const row = (name: string, active: boolean, status?: string) => ({
  id: name,
  name,
  botId: "b",
  active,
  nextRunAt: null,
  bot: { name: "Bot" },
  runs: status ? [{ status, createdAt: new Date(0) }] : [],
});

describe("routine board", () => {
  it("puts what needs a person first, then what is on", () => {
    const rows = routineBoard([
      row("paused", false),
      row("on", true, "completed"),
      row("waiting", false, "waiting_input"),
      row("failed", true, "failed"),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["failed", "waiting", "on", "paused"]);
    expect(rows.map((r) => r.stuck)).toEqual([true, true, false, false]);
  });

  it("does not call a routine that never ran stuck", () => {
    const [only] = routineBoard([row("new", true)]);
    expect(only?.stuck).toBe(false);
    expect(only?.lastRunAt).toBeNull();
  });
});
