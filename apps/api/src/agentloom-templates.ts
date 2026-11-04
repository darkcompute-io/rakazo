// AgentLoom: put a space template's bots into a space (packages/core agentloom-templates.ts).
// Each bot is made under a spawn key, so applying twice makes nothing new, and its routines
// are made paused. Used by the New space dialog (routes/templates.ts) and, once per team
// space, by the registry sweep.
import type { Actor } from "@rakazo/contracts";
import { CreateRoutineInput } from "@rakazo/contracts";
import type { SpaceTemplate } from "@rakazo/core";
import { templateSpawnKey } from "@rakazo/core";
import type { PrismaClient, createRepos } from "@rakazo/db";
import { routineNextRunAt, routineRowData } from "./routines.js";

export async function applyTemplate(
  deps: { prisma: PrismaClient; repos: ReturnType<typeof createRepos> },
  actor: Actor,
  template: SpaceTemplate,
): Promise<{ bots: number; routines: number }> {
  let bots = 0;
  let routines = 0;
  for (const bot of template.bots) {
    const spawnKey = templateSpawnKey(template.id, bot.key);
    const existing = await deps.prisma.bot.findFirst({
      where: { spaceId: actor.spaceId, spawnKey },
      select: { id: true },
    });
    if (existing) continue;
    const row = await deps.repos.createBot(actor, {
      name: bot.name,
      description: bot.description,
      instructions: bot.instructions,
      notifyOnFinish: true,
      spawnKey,
    });
    bots += 1;
    for (const routine of bot.routines) {
      const input = CreateRoutineInput.parse({
        botId: row.id,
        name: routine.name,
        prompt: routine.prompt,
        crons: [routine.cron],
        timezone: routine.timezone,
        active: false,
      });
      await deps.prisma.routine.create({
        data: routineRowData(actor, input, routineNextRunAt(input)),
      });
      routines += 1;
    }
  }
  return { bots, routines };
}
