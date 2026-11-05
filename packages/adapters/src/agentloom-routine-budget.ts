// AgentLoom: a ceiling on what one space's routines may spend in 24 hours, set per instance by
// AGENTLOOM_ROUTINE_DAILY_USD; unset means no ceiling. A routine past it skips this tick and keeps
// its schedule, so nothing is lost but the run, and a person's own chats are never counted or held.
type Prisma = {
  run: {
    findMany(args: {
      where: { spaceId: string; trigger: string; createdAt: { gte: Date } };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
  usageRecord: {
    aggregate(args: {
      where: { runId: { in: string[] } };
      _sum: { costUsd: true };
    }): Promise<{ _sum: { costUsd: number | null } }>;
  };
};

export function routineDailyUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const value = Number(env.AGENTLOOM_ROUTINE_DAILY_USD);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function routineSpend24h(prisma: Prisma, spaceId: string, now = Date.now()) {
  const runs = await prisma.run.findMany({
    where: { spaceId, trigger: "routine", createdAt: { gte: new Date(now - 86_400_000) } },
    select: { id: true },
  });
  if (runs.length === 0) return 0;
  const usage = await prisma.usageRecord.aggregate({
    where: { runId: { in: runs.map((run) => run.id) } },
    _sum: { costUsd: true },
  });
  return usage._sum.costUsd ?? 0;
}

/** Why this tick should not run, or null. A failed check lets it run: the cap is not a gate. */
export async function routineOverBudget(
  prisma: Prisma,
  spaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ spent: number; cap: number } | null> {
  const cap = routineDailyUsd(env);
  if (cap === null) return null;
  const spent = await routineSpend24h(prisma, spaceId).catch(() => 0);
  return spent >= cap ? { spent, cap } : null;
}
