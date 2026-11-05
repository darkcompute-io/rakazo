import { describe, expect, it, vi } from "vitest";
import { routineDailyUsd, routineOverBudget, routineSpend24h } from "./agentloom-routine-budget.js";

const prismaWith = (ids: string[], cost: number | null) => ({
  run: { findMany: vi.fn(async () => ids.map((id) => ({ id }))) },
  usageRecord: { aggregate: vi.fn(async () => ({ _sum: { costUsd: cost } })) },
});

describe("routine budget", () => {
  it("is off unless the instance sets a positive number", () => {
    expect(routineDailyUsd({})).toBeNull();
    expect(routineDailyUsd({ AGENTLOOM_ROUTINE_DAILY_USD: "0" })).toBeNull();
    expect(routineDailyUsd({ AGENTLOOM_ROUTINE_DAILY_USD: "nope" })).toBeNull();
    expect(routineDailyUsd({ AGENTLOOM_ROUTINE_DAILY_USD: "15" })).toBe(15);
  });

  it("counts only routine runs from the last day", async () => {
    const prisma = prismaWith(["a"], 2.5);
    expect(await routineSpend24h(prisma, "s", 86_400_000 * 2)).toBe(2.5);
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { spaceId: "s", trigger: "routine", createdAt: { gte: new Date(86_400_000) } },
      select: { id: true },
    });
    const none = prismaWith([], null);
    expect(await routineSpend24h(none, "s")).toBe(0);
    expect(none.usageRecord.aggregate).not.toHaveBeenCalled();
  });

  it("stops at the cap, and a failed check lets the run go", async () => {
    const env = { AGENTLOOM_ROUTINE_DAILY_USD: "5" };
    expect(await routineOverBudget(prismaWith(["a"], 4.99), "s", env)).toBeNull();
    expect(await routineOverBudget(prismaWith(["a"], 5), "s", env)).toEqual({ spent: 5, cap: 5 });
    expect(await routineOverBudget(prismaWith(["a"], 50), "s", {})).toBeNull();
    const broken = prismaWith(["a"], 0);
    broken.run.findMany.mockRejectedValue(new Error("db"));
    expect(await routineOverBudget(broken, "s", env)).toBeNull();
  });
});
