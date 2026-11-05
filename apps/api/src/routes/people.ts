// AgentLoom: who in the team organization may have bots reach their other spaces. Only the
// registry's owner can see or change it. A switch takes effect on the next message a bot sends.
import { ORPCError } from "@orpc/server";
import { registryInfo } from "@rakazo/core";
import { runAsSystem } from "@rakazo/db";
import { patchTeamMeta } from "../agentloom-teams.js";
import type { RouterContext } from "./context.js";

export function peopleRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  async function ownedOrg(email: string | null | undefined) {
    const teams = registryInfo().teams;
    if (!teams || String(email ?? "").toLowerCase() !== teams.owner) {
      throw new ORPCError("FORBIDDEN", { message: "Only the owner can see this." });
    }
    const org = await runAsSystem("people: the team organization", () =>
      deps.prisma.organization.findUnique({
        where: { slug: teams.org.slug },
        select: { id: true, metadata: true },
      }),
    );
    if (!org) throw new ORPCError("NOT_FOUND", { message: "No team organization yet." });
    const meta = JSON.parse(org.metadata || "{}") as { agentloomCrossSpaceOff?: string[] };
    return { org, teams, off: new Set(meta.agentloomCrossSpaceOff ?? []) };
  }

  return {
    people: {
      list: authed.people.list.handler(async ({ context }) => {
        const { org, teams, off } = await ownedOrg(context.actor.email);
        const walled = new Set(teams.crossSpaceOff.map((address) => address.toLowerCase()));
        const members = await runAsSystem("people: list the members", () =>
          deps.prisma.member.findMany({
            where: { organizationId: org.id },
            select: {
              userId: true,
              user: { select: { name: true, email: true } },
              spaceMemberships: { select: { space: { select: { name: true } } } },
            },
          }),
        );
        return members
          .map((member) => ({
            userId: member.userId,
            name: member.user.name,
            email: member.user.email,
            spaces: member.spaceMemberships.map((row) => row.space.name).sort(),
            crossSpace: !off.has(member.userId),
            lockedOff: walled.has(member.user.email.toLowerCase()),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }),
      setCrossSpace: authed.people.setCrossSpace.handler(async ({ context, input }) => {
        const { org } = await ownedOrg(context.actor.email);
        await runAsSystem("people: set cross-space access", () =>
          patchTeamMeta(deps.prisma, org.id, (meta) => {
            const off = new Set((meta.agentloomCrossSpaceOff as string[] | undefined) ?? []);
            if (input.enabled) off.delete(input.userId);
            else off.add(input.userId);
            return { agentloomCrossSpaceOff: [...off] };
          }),
        );
        return { userId: input.userId, crossSpace: input.enabled };
      }),
    },
  };
}
