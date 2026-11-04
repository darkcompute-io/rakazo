// AgentLoom: the templates a new space can start from, and applying one to a space the
// caller is a member of (apps/api/src/agentloom-templates.ts).
import { ORPCError } from "@orpc/server";
import { spaceTemplates } from "@rakazo/core";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { applyTemplate } from "../agentloom-templates.js";
import type { RouterContext } from "./context.js";

export function templatesRoutes(ctx: RouterContext) {
  const { deps, authed, repos } = ctx;
  return {
    templates: {
      list: authed.templates.list.handler(() =>
        spaceTemplates().map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          apps: template.apps,
          bots: template.bots.map((bot) => ({
            name: bot.name,
            description: bot.description,
            routines: bot.routines.length,
          })),
        })),
      ),
      apply: authed.templates.apply.handler(async ({ context, input }) => {
        const template = spaceTemplates().find((t) => t.id === input.templateId);
        if (!template) throw new ORPCError("NOT_FOUND", { message: "That template is not offered here." });
        const member = await runAsSystem("templates: is the caller in that space", () =>
          deps.prisma.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId: input.spaceId, userId: context.actor.userId } },
            select: { id: true },
          }),
        );
        if (!member) throw new ORPCError("NOT_FOUND", { message: "Space not found." });
        const actor = { ...context.actor, spaceId: input.spaceId };
        return runAsTenant(actor, () => applyTemplate({ prisma: deps.prisma, repos }, actor, template));
      }),
    },
  };
}
