// AgentLoom: a bot may ask a bot in another space of the same person. The work stays where it
// belongs: the bot in that space does it, with that space's apps and approvals, and answers back.
// On for everyone in an instance with teams, off per person through teams.crossSpaceOff in the
// registry. An instance with no teams (the customer copy) never has it.
import { registryInfo } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

export const CROSS_SPACE_DIRECTORY_LIMIT = 40;

export function crossSpaceOn(email: string | null | undefined, raw?: string): boolean {
  const teams = (raw === undefined ? registryInfo() : registryInfo(raw)).teams;
  if (!teams) return false;
  const off = new Set(teams.crossSpaceOff.map((address) => address.toLowerCase()));
  return Boolean(email) && !off.has(String(email).toLowerCase());
}

export type CrossSpaceBot = {
  id: string;
  name: string;
  description: string;
  spaceId: string;
  spaceName: string;
  thread: { id: string } | null;
};

/** Bots in this person's other spaces, read fresh, so leaving a space ends reaching it. */
export async function crossSpaceBots(
  prisma: PrismaClient,
  input: { userId: string; spaceId: string },
): Promise<CrossSpaceBot[]> {
  if (!registryInfo().teams) return [];
  return runAsSystem("find the bots in this person's other spaces", async () => {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true },
    });
    if (!crossSpaceOn(user?.email)) return [];
    const memberships = await prisma.spaceMember.findMany({
      where: { userId: input.userId, spaceId: { not: input.spaceId } },
      select: { spaceId: true, space: { select: { name: true } } },
    });
    if (memberships.length === 0) return [];
    const names = new Map(memberships.map((m) => [m.spaceId, m.space.name]));
    const bots = await prisma.bot.findMany({
      where: {
        spaceId: { in: [...names.keys()] },
        archivedAt: null,
        thread: { isNot: null },
      },
      select: {
        id: true,
        name: true,
        description: true,
        spaceId: true,
        thread: { select: { id: true } },
      },
      orderBy: { createdAt: "asc" },
      take: CROSS_SPACE_DIRECTORY_LIMIT,
    });
    return bots.map((bot) => ({ ...bot, spaceName: names.get(bot.spaceId) ?? "" }));
  });
}
