import { randomUUID } from "node:crypto";
import type { RegistryTeams } from "@rakazo/core";
import { spaceTemplates } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTeamSpaces, syncTeams, teamSpaces, tokenGroups } from "./agentloom-teams.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("team spaces follow authentik groups (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const teams: RegistryTeams = {
    org: { name: "Darkcompute", slug: `dc-${tag}` },
    owner: `owner-${tag}@example.test`,
    spaces: [
      { id: "everyone", name: "Darkcompute", group: "Employees", isDefault: true },
      { id: "fleet", name: "Fleet", group: "team-fleet", isDefault: false },
      { id: "marketing", name: "Marketing", group: "team-marketing", isDefault: false },
    ],
  };

  async function person(name: string) {
    const id = `${name}-${tag}`;
    const email = name === "owner" ? teams.owner : `${id}@example.test`;
    const createdAt = new Date();
    await system.user.create({ data: { id, name, email, emailVerified: true } });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true, createdByUserId: id },
    });
    await system.spaceMember.create({
      data: {
        id: `sm-${id}`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt,
      },
    });
    return { userId: id, email };
  }

  async function spacesOf(userId: string) {
    const map = await teamSpaces(db.prisma, teams);
    const rows = await system.spaceMember.findMany({
      where: { userId },
      select: { spaceId: true, role: true },
    });
    return rows
      .filter((row) => map.has(row.spaceId))
      .map((row) => `${map.get(row.spaceId)}:${row.role}`)
      .sort();
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma) as PrismaClient;
  });
  afterAll(async () => {
    await db?.pool.end();
  });

  it("makes the spaces, joins and removes people by group, and leaves the rest alone", async () => {
    const owner = await person("owner");
    const ada = await person("ada");
    const bob = await person("bob");

    await syncTeams(db.prisma, teams, [
      { ...owner, groups: ["Employees"] },
      { ...ada, groups: ["Employees", "team-fleet"] },
      { ...bob, groups: ["Employees", "team-marketing"] },
    ]);
    expect(await spacesOf(owner.userId)).toEqual([
      "everyone:owner",
      "fleet:owner",
      "marketing:owner",
    ]);
    expect(await spacesOf(ada.userId)).toEqual(["everyone:member", "fleet:member"]);
    expect(await spacesOf(bob.userId)).toEqual(["everyone:member", "marketing:member"]);

    // The personal organization is still the one each person owns.
    const adaOrgs = await system.member.findMany({
      where: { userId: ada.userId },
      select: { role: true },
    });
    expect(adaOrgs.map((m) => m.role).sort()).toEqual(["member", "owner"]);

    // A second pass changes nothing and makes no second space.
    await syncTeams(db.prisma, teams, [{ ...ada, groups: ["Employees", "team-fleet"] }]);
    const org = await system.organization.findUniqueOrThrow({ where: { slug: teams.org.slug } });
    expect(await system.space.count({ where: { organizationId: org.id } })).toBe(3);

    // Leaving the group leaves the space; unknown groups (no live login) change nothing.
    await syncTeams(db.prisma, teams, [
      { ...ada, groups: ["Employees"] },
      { ...bob, groups: null },
    ]);
    expect(await spacesOf(ada.userId)).toEqual(["everyone:member"]);
    expect(await spacesOf(bob.userId)).toEqual(["everyone:member", "marketing:member"]);

    // The owner is never removed, whatever their groups say.
    await syncTeams(db.prisma, teams, [{ ...owner, groups: [] }]);
    expect(await spacesOf(owner.userId)).toEqual([
      "everyone:owner",
      "fleet:owner",
      "marketing:owner",
    ]);

    // A space someone made by hand in the organization is not a team space.
    const hand = randomUUID();
    await system.space.create({
      data: {
        id: hand,
        organizationId: org.id,
        name: "Side project",
        createdByUserId: owner.userId,
      },
    });
    await syncTeams(db.prisma, teams, [{ ...bob, groups: [] }]);
    expect((await teamSpaces(db.prisma, teams)).has(hand)).toBe(false);
    expect(await spacesOf(bob.userId)).toEqual([]);
  });

  it("seeds each team space once from its template, bots made with paused routines", async () => {
    const repos = createRepos(db.prisma);
    const templates = spaceTemplates(
      JSON.stringify([
        {
          id: "fleet",
          name: "Fleet",
          bots: [
            {
              key: "watch",
              name: "Fleet watch",
              instructions: "Watch the fleet.",
              routines: [{ name: "Morning", prompt: "Check every host.", cron: "0 8 * * 1-5", timezone: "America/New_York" }],
            },
            { key: "desk", name: "Change desk", instructions: "Make changes." },
          ],
        },
      ]),
    );
    const map = await teamSpaces(db.prisma, teams);
    const fleet = [...map].find(([, team]) => team === "fleet")![0];
    const marketing = [...map].find(([, team]) => team === "marketing")![0];

    await seedTeamSpaces({ prisma: db.prisma, repos }, teams, templates);
    const bots = await system.bot.findMany({ where: { spaceId: fleet }, select: { id: true, name: true } });
    expect(bots.map((b) => b.name).sort()).toEqual(["Change desk", "Fleet watch"]);
    const routines = await system.routine.findMany({ where: { spaceId: fleet }, select: { active: true, nextRunAt: true } });
    expect(routines).toEqual([{ active: false, nextRunAt: null }]);
    expect(await system.bot.count({ where: { spaceId: marketing } })).toBe(0);

    // Seeded once: a bot removed afterwards is not put back.
    await system.bot.update({ where: { id: bots[0]!.id }, data: { archivedAt: new Date() } });
    await seedTeamSpaces({ prisma: db.prisma, repos }, teams, templates);
    expect(await system.bot.count({ where: { spaceId: fleet } })).toBe(2);
    expect(await system.bot.count({ where: { spaceId: fleet, archivedAt: null } })).toBe(1);

    // A changed template reaches a bot nobody edited, and never one a person did.
    const live = await system.bot.findFirstOrThrow({ where: { spaceId: fleet, archivedAt: null } });
    const edited = await system.bot.findFirstOrThrow({ where: { spaceId: fleet, archivedAt: { not: null } } });
    await system.bot.update({ where: { id: edited.id }, data: { instructions: "a person wrote this" } });
    const changed = templates.map((t) => ({
      ...t,
      bots: t.bots.map((b) => ({ ...b, instructions: `${b.instructions} v2` })),
    }));
    await seedTeamSpaces({ prisma: db.prisma, repos }, teams, changed);
    const after = await system.bot.findUniqueOrThrow({ where: { id: live.id } });
    expect(after.instructions.endsWith(" v2")).toBe(true);
    const kept = await system.bot.findUniqueOrThrow({ where: { id: edited.id } });
    expect(kept.instructions).toBe("a person wrote this");
  });

  it("reads groups from a token and refuses what is not one", () => {
    const body = Buffer.from(JSON.stringify({ groups: ["team-fleet", 3, "Employees"] })).toString(
      "base64url",
    );
    expect(tokenGroups(`h.${body}.s`)).toEqual(["team-fleet", "Employees"]);
    expect(tokenGroups(undefined)).toBeNull();
    expect(tokenGroups("not-a-jwt")).toBeNull();
    const none = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(tokenGroups(`h.${none}.s`)).toBeNull();
  });
});
