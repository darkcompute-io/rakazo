// AgentLoom: put a space template's bots into a space (packages/core agentloom-templates.ts).
// Each bot is made under a spawn key, so applying twice makes nothing new, and its routines
// are made paused unless the template marks one active. Used by the New space dialog (routes/templates.ts) and, once per team
// space, by the registry sweep.
import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { CreateRoutineInput } from "@rakazo/contracts";
import type { SpaceTemplate, TemplateRoutine } from "@rakazo/core";
import { templateSpawnKey } from "@rakazo/core";
import type { createRepos, PrismaClient } from "@rakazo/db";
import { routineNextRunAt, routineRowData } from "./routines.js";

async function makeRoutine(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  routine: TemplateRoutine,
) {
  const input = CreateRoutineInput.parse({
    botId,
    name: routine.name,
    prompt: routine.prompt,
    crons: routine.cron ? [routine.cron] : [],
    timezone: routine.timezone,
    active: routine.active,
    ...(routine.watch ? { watch: { kind: "tool", ...routine.watch } } : {}),
  });
  await prisma.routine.create({ data: routineRowData(actor, input, routineNextRunAt(input)) });
}

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
      await makeRoutine(deps.prisma, actor, row.id, routine);
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
      select: { id: true, instructions: true, archivedAt: true },
    });
    if (!row) continue;
    // A routine the template gained reaches a bot made before it, once: each name is recorded
    // the first time it is seen, so one a person deleted does not come back on the next sweep.
    if (!row.archivedAt && bot.routines.length > 0) {
      const existing = await deps.prisma.routine.findMany({
        where: { botId: row.id, spaceId: actor.spaceId },
        select: { name: true },
      });
      const names = new Set(existing.map((r) => r.name));
      for (const routine of bot.routines) {
        const seen = `routine:${row.id}:${routine.name}`;
        if (next[seen]) continue;
        if (!names.has(routine.name)) await makeRoutine(deps.prisma, actor, row.id, routine);
        next[seen] = "1";
      }
    }
    const want = textHash(bot.instructions);
    const have = textHash(row.instructions);
    if (have === want) {
      next[row.id] = want;
      continue;
    }
    const last = known[row.id];
    if (last && last !== have) continue;
    await deps.prisma.bot.update({
      where: { id: row.id },
      data: { instructions: bot.instructions },
    });
    next[row.id] = want;
    updated += 1;
  }
  return { updated, known: next };
}
