import { describe, expect, it, vi } from "vitest";
import { fileRoutineFailure } from "./agentloom-routine-failure.js";

const prisma = {
  organization: {
    findUnique: async () => ({
      metadata: JSON.stringify({ agentloomTeams: { fleet: "team-space" } }),
    }),
  },
  routine: { findUnique: async () => ({ name: "Nightly check" }) },
};
const env = {
  AGENTLOOM_CONNECTOR_REQUEST_URL: "https://tasks.example/api/capture",
  AGENTLOOM_CONNECTOR_REQUEST_TOKEN: "tok",
} as unknown as NodeJS.ProcessEnv;
const teams = { org: { slug: "darkcompute" } };
const run = { routineId: "r1", spaceId: "team-space" };

describe("fileRoutineFailure", () => {
  it("files one item per routine per day, without the error", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 201 }));
    const now = Date.UTC(2026, 10, 6);
    const filed = await fileRoutineFailure(prisma, run, "Fleet watch", {
      env,
      teams,
      now,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(filed).toBe(true);
    const body = JSON.parse(
      (fetcher.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body.ext).toBe("routine-failed:r1:2026-11-06");
    expect(body.title).toBe("Routine failed: Nightly check (Fleet watch)");
    expect(Object.keys(body)).not.toContain("error");
  });

  it("files nothing for a person's own space, an unset sink or no routine", async () => {
    const fetcher = vi.fn();
    const options = { env, teams, fetcher: fetcher as unknown as typeof fetch };
    expect(await fileRoutineFailure(prisma, { ...run, spaceId: "mine" }, "b", options)).toBe(false);
    expect(await fileRoutineFailure(prisma, { ...run, routineId: null }, "b", options)).toBe(false);
    expect(
      await fileRoutineFailure(prisma, run, "b", { ...options, env: {} as NodeJS.ProcessEnv }),
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never throws when filing fails", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("down");
    });
    const filed = await fileRoutineFailure(prisma, run, "b", {
      env,
      teams,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(filed).toBe(false);
  });
});
