import { randomUUID } from "node:crypto";
import { messageBot } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { patchTeamMeta } from "./agentloom-teams.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("a bot reaches the same person's other spaces (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const before = process.env.AGENTLOOM_REGISTRY;
  const email = `james-${tag}@example.test`;
  const registry = (off: string[] = []) =>
    JSON.stringify({
      apps: [],
      teams: {
        org: { name: "D", slug: `d-${tag}` },
        owner: email,
        spaces: [{ id: "fleet", name: "Fleet", group: "team-fleet" }],
        crossSpaceOff: off,
      },
    });
  const userId = `u-${tag}`;
  const orgId = `o-${tag}`;

  async function space(name: string, member: boolean) {
    const id = `${name}-${tag}`;
    await system.space.create({
      data: { id, name, organizationId: orgId, isDefault: false, createdAt: new Date() } as never,
    });
    if (member) {
      await system.spaceMember.create({
        data: {
          id: `sm-${id}`,
          spaceId: id,
          organizationId: orgId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    return id;
  }

  async function bot(spaceId: string, name: string) {
    const id = `${name}-${tag}`;
    await system.bot.create({
      data: {
        id,
        spaceId,
        userId,
        name,
        description: "",
        instructions: "x",
        color: "#000000",
      } as never,
    });
    const thread = await system.thread.create({
      data: { spaceId, botId: id, userId } as never,
    });
    return { id, name, threadId: thread.id, spaceId };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    system = asSystem(db.prisma);
    await system.user.create({
      data: { id: userId, name: "James", email, emailVerified: true },
    });
    await system.organization.create({
      data: { id: orgId, name: "D", slug: `d-${tag}`, createdAt: new Date() },
    });
    await system.member.create({
      data: {
        id: `m-${tag}`,
        organizationId: orgId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (before === undefined) delete process.env.AGENTLOOM_REGISTRY;
    else process.env.AGENTLOOM_REGISTRY = before;
    await db.prisma.$disconnect();
  });

  it("delivers only to a space the person is in, and not when they are walled off", async () => {
    const home = await space("home", true);
    const fleet = await space("fleet", true);
    const hidden = await space("hidden", false);
    const chief = await bot(home, "chief");
    const watch = await bot(fleet, "watch");
    const stranger = await bot(hidden, "stranger");
    const task = await system.task.create({
      data: {
        spaceId: home,
        botId: chief.id,
        threadId: chief.threadId,
        userId,
        prompt: "x",
        status: "running",
      } as never,
    });
    const sender = await system.run.create({
      data: {
        spaceId: home,
        botId: chief.id,
        threadId: chief.threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
      } as never,
    });
    const deps = {
      prisma: system,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as never;
    const run = {
      id: sender.id,
      spaceId: home,
      threadId: chief.threadId,
      botId: chief.id,
      userId,
    };
    const ask = (botId: string) =>
      messageBot(deps, run, { id: chief.id, name: "chief" }, { bot_id: botId, message: "SV06?" });

    process.env.AGENTLOOM_REGISTRY = registry();
    expect(await ask(watch.id)).toMatchObject({ ok: true, botId: watch.id });
    const queued = await system.run.findFirstOrThrow({
      where: { botId: watch.id, trigger: "bot_message" },
    });
    expect(queued.spaceId).toBe(fleet);
    expect(queued.userId).toBe(userId);

    expect(await ask(stranger.id)).toMatchObject({ ok: false });

    // The owner's switch, and the sweep's stale write cannot put it back.
    await patchTeamMeta(system, orgId, () => ({ agentloomCrossSpaceOff: [userId] }));
    expect(await ask(watch.id)).toMatchObject({ ok: false });
    await patchTeamMeta(system, orgId, () => ({ agentloomSeeded: ["fleet"] }));
    const meta = JSON.parse(
      (await system.organization.findUniqueOrThrow({ where: { id: orgId } })).metadata ?? "{}",
    );
    expect(meta).toMatchObject({ agentloomCrossSpaceOff: [userId], agentloomSeeded: ["fleet"] });
    await patchTeamMeta(system, orgId, () => ({ agentloomCrossSpaceOff: [] }));
    expect(await ask(watch.id)).toMatchObject({ ok: true });

    process.env.AGENTLOOM_REGISTRY = registry([email.toUpperCase()]);
    expect(await ask(watch.id)).toMatchObject({ ok: false });

    process.env.AGENTLOOM_REGISTRY = JSON.stringify({ apps: [] });
    expect(await ask(watch.id)).toMatchObject({ ok: false });
  });
});
