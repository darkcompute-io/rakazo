// AgentLoom: team spaces kept in step with authentik groups (CORP). The registry's `teams`
// block names an organization, its owner and one space per group; the registry sweep
// (routes/registry.ts) calls syncTeams with every SSO member's groups, read from their own
// agentloom-mcp token, before it connects apps.
//
//   in the group, not in the space   -> joins as a member (the org first, as an invite does)
//   in the space, not in the group   -> leaves, the way "Leave space" does: what they made
//                                       passes to the space's owner
//   groups unknown (no live login)   -> nothing changes for that person
//
// The organization keeps a map of team id -> space id in its metadata, so a space somebody
// made by hand in it is never touched, and a renamed space keeps its team.
import { randomUUID } from "node:crypto";
import type { RegistryTeams, SpaceTemplate } from "@rakazo/core";
import type { PrismaClient, createRepos } from "@rakazo/db";
import { applyTemplate } from "./agentloom-templates.js";
import { leaveSpace, runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export type TeamMember = { userId: string; email: string; groups: string[] | null };

type TeamMeta = { agentloomTeams?: Record<string, string> };

function readMeta(raw: string | null | undefined): TeamMeta {
  try {
    const meta = raw ? (JSON.parse(raw) as unknown) : {};
    return meta && typeof meta === "object" ? (meta as TeamMeta) : {};
  } catch {
    return {};
  }
}

/** Space id -> team id for the instance's team spaces; empty when there are none yet. */
export async function teamSpaces(prisma: PrismaClient, teams: RegistryTeams | null) {
  if (!teams) return new Map<string, string>();
  const org = await runAsSystem("teams: read the team organization", () =>
    prisma.organization.findUnique({ where: { slug: teams.org.slug }, select: { metadata: true } }),
  );
  const map = readMeta(org?.metadata).agentloomTeams ?? {};
  return new Map(Object.entries(map).map(([team, space]) => [space, team]));
}

async function ensureOrgMember(
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
  defaultSpaceId: string | null,
) {
  const existing = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { id: true },
  });
  if (existing) return;
  const memberId = randomUUID();
  // The org role stays "member" for everyone, the owner included, so nobody's own personal
  // organization stops being the one they own.
  await prisma.member.create({
    data: { id: memberId, organizationId, userId, role: "member", createdAt: new Date() },
  });
  // A trigger adds a new member to the organization's default space; membership here is
  // decided by group, so undo it unless that is a space they belong in.
  if (defaultSpaceId) {
    await prisma.spaceMember.deleteMany({
      where: { id: `default-space-member:${memberId}`, userId },
    });
  }
}

export async function syncTeams(
  prisma: PrismaClient,
  teams: RegistryTeams,
  members: TeamMember[],
): Promise<void> {
  await runAsSystem("teams: keep team spaces in step with authentik groups", async () => {
    const owner = await prisma.user.findFirst({
      where: { email: { equals: teams.owner, mode: "insensitive" } },
      select: { id: true },
    });
    if (!owner) {
      getLogger().warn("teams: the owner has not signed in yet; no team space is made", {
        owner: teams.owner,
      });
      return;
    }
    let org = await prisma.organization.findUnique({ where: { slug: teams.org.slug } });
    org ??= await prisma.organization.create({
      data: { id: randomUUID(), name: teams.org.name, slug: teams.org.slug, createdAt: new Date() },
    });
    const meta = readMeta(org.metadata);
    const map: Record<string, string> = { ...(meta.agentloomTeams ?? {}) };
    const defaultTeam = teams.spaces.find((space) => space.isDefault) ?? null;
    await ensureOrgMember(prisma, org.id, owner.id, map[defaultTeam?.id ?? ""] ?? null);

    for (const team of teams.spaces) {
      const known = map[team.id]
        ? await prisma.space.findFirst({
            where: { id: map[team.id], organizationId: org.id, deletingAt: null },
            select: { id: true },
          })
        : null;
      if (known) continue;
      const spaceId = randomUUID();
      const now = new Date();
      await prisma.space.create({
        data: {
          id: spaceId,
          organizationId: org.id,
          name: team.name,
          isDefault: team.isDefault,
          createdByUserId: owner.id,
          createdAt: now,
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId,
          organizationId: org.id,
          userId: owner.id,
          role: "owner",
          createdAt: now,
        },
      });
      await prisma.memoryDocument.create({
        data: {
          spaceId,
          userId: owner.id,
          scope: "user",
          path: "MEMORY.md",
          content: `# ${team.name}\n\n`,
        },
      });
      await prisma.notificationPreference.create({ data: { spaceId, userId: owner.id } });
      map[team.id] = spaceId;
      getLogger().info("teams: space made", { team: team.id, spaceId });
    }
    if (JSON.stringify(map) !== JSON.stringify(meta.agentloomTeams ?? {})) {
      await prisma.organization.update({
        where: { id: org.id },
        data: { metadata: JSON.stringify({ ...meta, agentloomTeams: map }) },
      });
    }

    for (const person of members) {
      if (!person.groups || person.userId === owner.id) continue;
      const held = new Set(person.groups);
      for (const team of teams.spaces) {
        const spaceId = map[team.id];
        if (!spaceId) continue;
        const member = await prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId, userId: person.userId } },
          select: { role: true },
        });
        if (held.has(team.group) && !member) {
          await ensureOrgMember(prisma, org.id, person.userId, map[defaultTeam?.id ?? ""] ?? null);
          await prisma.spaceMember.upsert({
            where: { spaceId_userId: { spaceId, userId: person.userId } },
            create: {
              id: randomUUID(),
              spaceId,
              organizationId: org.id,
              userId: person.userId,
              role: "member",
              createdAt: new Date(),
            },
            update: {},
          });
          getLogger().info("teams: joined", { team: team.id, userId: person.userId });
        } else if (!held.has(team.group) && member && member.role !== "owner") {
          await leaveSpace(prisma, { spaceId, userId: person.userId });
          getLogger().info("teams: left", { team: team.id, userId: person.userId });
        }
      }
    }
  });
}

/** The groups claim of a JWT access token, unverified: it came straight from authentik's
 * token endpoint over TLS, and is only used to decide spaces the sweep already manages. */
export function tokenGroups(accessToken: string | undefined): string[] | null {
  const payload = accessToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      groups?: unknown;
    };
    return Array.isArray(claims.groups)
      ? claims.groups.filter((g): g is string => typeof g === "string")
      : null;
  } catch {
    return null;
  }
}

/** Once per team space: the template with the team's id goes into a space that still has
 * no bots, as its owner, and the organization records that it was done. A space somebody
 * already filled, or emptied after seeding, is never seeded again. */
export async function seedTeamSpaces(
  deps: { prisma: PrismaClient; repos: ReturnType<typeof createRepos> },
  teams: RegistryTeams,
  templates: SpaceTemplate[],
): Promise<void> {
  const org = await runAsSystem("teams: read the team organization", () =>
    deps.prisma.organization.findUnique({ where: { slug: teams.org.slug } }),
  );
  if (!org) return;
  const meta = readMeta(org.metadata) as TeamMeta & { agentloomSeeded?: string[] };
  const seeded = new Set(meta.agentloomSeeded ?? []);
  const owner = await runAsSystem("teams: the owner", () =>
    deps.prisma.user.findFirst({
      where: { email: { equals: teams.owner, mode: "insensitive" } },
      select: { id: true, email: true },
    }),
  );
  if (!owner) return;
  let changed = false;
  for (const [team, spaceId] of Object.entries(meta.agentloomTeams ?? {})) {
    const template = templates.find((t) => t.id === team);
    if (!template || seeded.has(team)) continue;
    const bots = await runAsSystem("teams: is the space empty", () =>
      deps.prisma.bot.count({ where: { spaceId, archivedAt: null } }),
    );
    if (bots === 0) {
      const actor = { userId: owner.id, spaceId, email: owner.email, isDeploymentOwner: false };
      const made = await runAsTenant(actor, () => applyTemplate(deps, actor, template));
      getLogger().info("teams: template applied", { team, spaceId, ...made });
    }
    seeded.add(team);
    changed = true;
  }
  if (changed) {
    await runAsSystem("teams: record seeded spaces", () =>
      deps.prisma.organization.update({
        where: { id: org.id },
        data: { metadata: JSON.stringify({ ...meta, agentloomSeeded: [...seeded] }) },
      }),
    );
  }
}
