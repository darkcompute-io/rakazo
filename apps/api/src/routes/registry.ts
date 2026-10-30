// AgentLoom: the instance's one-click apps (packages/core agentloom-registry.ts). Add makes
// the member's connection to the app in this space, signed in as them through the instance's
// pre-registered authentik client, and puts it on every bot in the space; the page then runs
// the ordinary MCP OAuth popup for it. Nothing here holds a token of the app's own: the
// person's grant is the only credential, so a bot can do what they can.
import { ORPCError } from "@orpc/server";
import { McpServerConfigInput } from "@rakazo/contracts";
import { registryEntries, registryInfo, registrySlug } from "@rakazo/core";
import type { RouterContext } from "./context.js";

const SCOPE = "openid profile email offline_access";

/** Where "Request a connector" goes: a capture API taking { text, title, by, where } with a
 * bearer token. On CORP that is Tasks' triage. Neither set: no button. */
function requestSink(): { url: string; token: string } | null {
  const url = process.env.AGENTLOOM_CONNECTOR_REQUEST_URL?.trim();
  const token = process.env.AGENTLOOM_CONNECTOR_REQUEST_TOKEN?.trim();
  return url?.startsWith("https://") && token ? { url, token } : null;
}

export function registryRoutes(ctx: RouterContext) {
  const { deps, authed, prepareMcpServer, insertMcpServer, announceMcpServer } = ctx;

  return {
    registry: {
      list: authed.registry.list.handler(async ({ context }) => {
        const { title, entries } = registryInfo();
        const servers = await deps.prisma.mcpServer.findMany({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            slug: { in: entries.map((entry) => registrySlug(entry.id)) },
          },
          select: { id: true, slug: true },
        });
        const bySlug = new Map(servers.map((server) => [server.slug, server.id]));
        return {
          title,
          requestable: requestSink() !== null,
          entries: entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            open: entry.open,
            icon: entry.icon,
            askWrites: entry.askWrites,
            serverId: bySlug.get(registrySlug(entry.id)) ?? null,
          })),
        };
      }),
      add: authed.registry.add.handler(async ({ context, input }) => {
        const actor = context.actor;
        const entry = registryEntries().find((e) => e.id === input.id);
        if (!entry) {
          throw new ORPCError("NOT_FOUND", { message: "That app is not offered here." });
        }
        const clientId = process.env.AGENTLOOM_MCP_CLIENT_ID?.trim();
        const clientSecret = process.env.AGENTLOOM_MCP_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new ORPCError("PRECONDITION_FAILED", {
            message: "Sign-in for these apps is not set up on this instance.",
          });
        }
        const slug = registrySlug(entry.id);
        let server = await deps.prisma.mcpServer.findFirst({
          where: { spaceId: actor.spaceId, userId: actor.userId, slug },
        });
        if (!server) {
          const config = McpServerConfigInput.parse({
            slug,
            name: entry.name,
            description: entry.description || `${entry.name}, signed in as you.`,
            enabled: true,
            transport: "streamable_http",
            endpoint: entry.endpoint,
            oauthClient: { clientId, clientSecret, scope: SCOPE },
          });
          const stored = await prepareMcpServer(actor, config);
          const row = await deps.prisma.$transaction((tx) =>
            insertMcpServer(tx, actor, config, stored),
          );
          void announceMcpServer(row, actor).catch(() => undefined);
          server = row;
        }
        const bots = await deps.prisma.bot.findMany({
          where: { spaceId: actor.spaceId, archivedAt: null },
          select: { id: true },
        });
        if (bots.length) {
          await deps.prisma.botMcpServer.createMany({
            data: bots.map((bot) => ({
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: bot.id,
              serverId: server.id,
            })),
            skipDuplicates: true,
          });
        }
        return { serverId: server.id };
      }),
      request: authed.registry.request.handler(async ({ context, input }) => {
        const sink = requestSink();
        if (!sink) {
          throw new ORPCError("PRECONDITION_FAILED", { message: "Requests are not set up here." });
        }
        const user = await deps.prisma.user.findUnique({
          where: { id: context.actor.userId },
          select: { name: true, email: true },
        });
        const who = user?.email ?? user?.name ?? context.actor.userId;
        const host = new URL(deps.env.webOrigin).host;
        const response = await fetch(sink.url, {
          method: "POST",
          headers: { authorization: `Bearer ${sink.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            title: `Connector request: ${input.app}`,
            text: `${who} asked on ${host} for a connector: ${input.app}.${input.why ? `\n\n${input.why}` : ""}`,
            by: who,
            where: host,
            ext: `connector:${context.actor.userId}:${input.app.toLowerCase().slice(0, 60)}`,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (!response?.ok) {
          throw new ORPCError("BAD_GATEWAY", {
            message: "The request did not go through. Try again.",
          });
        }
        return { ok: true as const };
      }),
    },
  };
}
