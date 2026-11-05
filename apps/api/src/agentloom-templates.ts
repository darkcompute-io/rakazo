// AgentLoom: put a space template's bots into a space (packages/core agentloom-templates.ts).
// Each bot is made under a spawn key, so applying twice makes nothing new, and its routines
// are made paused. Used by the New space dialog (routes/templates.ts) and, once per team
// space, by the registry sweep.
import { createHash } from "node:crypto";
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

const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Carry a changed template to the bots already made from it. `known` is the hash of what the
 * template last wrote to each bot, by bot id: a bot whose text no longer matches was edited by
 * a person and is left alone. A bot with no entry predates this record and takes the template.
 * Instructions only - never its routines, its apps or whether it is archived.
 */
export async function refreshTemplateBots(
  deps: { prisma: PrismaClient },
  actor: Actor,
  template: SpaceTemplate,
  known: Record<string, string>,
): Promise<{ updated: number; known: Record<string, string> }> {
  const next = { ...known };
  let updated = 0;
  for (const bot of template.bots) {
    const row = await deps.prisma.bot.findFirst({
      where: { spaceId: actor.spaceId, spawnKey: templateSpawnKey(template.id, bot.key) },
      select: { id: true, instructions: true },
    });
    if (!row) continue;
    const want = textHash(bot.instructions);
    const have = textHash(row.instructions);
    if (have === want) {
      next[row.id] = want;
      continue;
    }
    const last = known[row.id];
    if (last && last !== have) continue;
    await deps.prisma.bot.update({ where: { id: row.id }, data: { instructions: bot.instructions } });
    next[row.id] = want;
    updated += 1;
  }
  return { updated, known: next };
}
