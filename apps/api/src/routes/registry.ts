// AgentLoom: the instance's one-click apps (packages/core agentloom-registry.ts). Add makes
// the member's connection to the app in this space, signed in as them through the instance's
// pre-registered authentik client, and puts it on every bot in the space; the page then runs
// the ordinary MCP OAuth popup for it. Nothing here holds a token of the app's own: the
// person's grant is the only credential, so a bot can do what they can.
//
// AGENTLOOM_REGISTRY_AUTO=1 (CORP) does all of that with no click and no popup: every member
// with an SSO login gets every app, on every bot of every space, and the grant comes from
// exchanging their own login token at authentik for an agentloom-mcp one (that provider lists
// the login provider under jwt_federation_providers, and still runs its own access policy).
// It reruns on a timer, so a new member, bot or app, and an hour-old grant, are taken care of.
import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { McpServerConfigInput } from "@rakazo/contracts";
import { type RegistryEntry, registryEntries, registryInfo, registrySlug } from "@rakazo/core";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RouterContext } from "./context.js";

const SCOPE = "openid profile email offline_access";

/** Where "Request a connector" goes: a capture API taking { text, title, by, where } with a
 * bearer token. On CORP that is Tasks' triage. Neither set: no button. */
function requestSink(): { url: string; token: string } | null {
  const url = process.env.AGENTLOOM_CONNECTOR_REQUEST_URL?.trim();
  const token = process.env.AGENTLOOM_CONNECTOR_REQUEST_TOKEN?.trim();
  return url?.startsWith("https://") && token ? { url, token } : null;
}

function mcpClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.AGENTLOOM_MCP_CLIENT_ID?.trim();
  const clientSecret = process.env.AGENTLOOM_MCP_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const autoEnabled = () => process.env.AGENTLOOM_REGISTRY_AUTO === "1";
const SWEEP_MS = 15 * 60_000;
/** A grant with less than this left is replaced; tokens live an hour. */
const RENEW_BEFORE_MS = 30 * 60_000;
let sweeping = false;

export function registryRoutes(ctx: RouterContext) {
  const { deps, authed, prepareMcpServer, insertMcpServer, announceMcpServer, mcpOAuth } = ctx;

  /** The member's connection to one app in their space, made if missing, on every bot. */
  async function ensureServer(actor: Actor, entry: RegistryEntry) {
    const client = mcpClient();
    if (!client) {
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
        oauthClient: { ...client, scope: SCOPE },
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
    return server;
  }

  let tokenEndpoint: Promise<string> | undefined;
  /** The token endpoint of the instance's login issuer, which agentloom-mcp shares. */
  function tokenUrl(): Promise<string> {
    tokenEndpoint ??= (async () => {
      const issuer = process.env.OIDC_ISSUER?.trim().replace(/\/$/, "");
      if (!issuer) throw new Error("OIDC_ISSUER is unset");
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      });
      const url = ((await response.json()) as { token_endpoint?: unknown }).token_endpoint;
      if (typeof url !== "string" || !url.startsWith("https://"))
        throw new Error("login issuer names no token endpoint");
      return url;
    })().catch((error) => {
      tokenEndpoint = undefined;
      throw error;
    });
    return tokenEndpoint;
  }

  /** The member's login token, swapped at authentik for an agentloom-mcp one; null if none. */
  async function exchange(userId: string) {
    const client = mcpClient();
    if (!client) return null;
    const account = await runAsSystem("registry: the member's SSO login", () =>
      deps.prisma.account.findFirst({
        where: { userId, providerId: "oidc" },
        select: { accountId: true },
      }),
    );
    if (!account) return null;
    // Better Auth refreshes the login when it has lapsed, and stores the new one.
    const login = await runAsSystem("registry: renew the member's SSO login", () =>
      deps.auth.api.getAccessToken({ body: { accountId: account.accountId, userId } }),
    ).catch(() => null);
    if (!login?.accessToken) {
      getLogger().warn("registry: no live SSO login to exchange", { userId });
      return null;
    }
    const response = await fetch(await tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client.clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: login.accessToken,
        scope: "openid profile email",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      getLogger().warn("registry token exchange refused", { status: response.status });
      return null;
    }
    const body = (await response.json()) as {
      access_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    if (typeof body.access_token !== "string") return null;
    return {
      access_token: body.access_token,
      token_type: typeof body.token_type === "string" ? body.token_type : "Bearer",
      ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    };
  }

  /** Every app for one member in one space, with a fresh grant where it needs one. */
  async function connectAll(actor: Actor, grant: () => ReturnType<typeof exchange>) {
    for (const entry of registryEntries()) {
      const server = await ensureServer(actor, entry);
      const ref = { id: server.id, endpoint: server.endpoint, secretId: server.secretId };
      const context = { spaceId: actor.spaceId, userId: actor.userId };
      const expiresAt = await mcpOAuth.grantExpiresAt(ref, context);
      if (expiresAt !== undefined && expiresAt - Date.now() > RENEW_BEFORE_MS) continue;
      // Without a grant the app is still added, and waits on the ordinary popup.
      const tokens = await grant();
      if (!tokens) continue;
      // The row was read before the server existed or before its secret moved; read it again.
      const fresh = await deps.prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
      await mcpOAuth.storeGrant(
        { id: fresh.id, endpoint: fresh.endpoint, secretId: fresh.secretId },
        context,
        tokens,
      );
    }
  }

  /** One grant per member per pass: every app accepts the same agentloom-mcp token. */
  function grantFor(userId: string) {
    let held: ReturnType<typeof exchange> | undefined;
    return () => (held ??= exchange(userId));
  }

  async function sweep() {
    if (sweeping || !registryEntries().length) return;
    sweeping = true;
    try {
      const members = await runAsSystem("registry: every SSO member's spaces", () =>
        deps.prisma.spaceMember.findMany({
          where: { member: { user: { accounts: { some: { providerId: "oidc" } } } } },
          select: { spaceId: true, userId: true, member: { select: { user: { select: { email: true } } } } },
        }),
      );
      const grants = new Map<string, () => ReturnType<typeof exchange>>();
      for (const row of members) {
        const actor: Actor = {
          spaceId: row.spaceId,
          userId: row.userId,
          email: row.member.user.email,
          isDeploymentOwner: false,
        };
        if (!grants.has(row.userId)) grants.set(row.userId, grantFor(row.userId));
        await runAsTenant(actor, () => connectAll(actor, grants.get(row.userId)!)).catch((error) =>
          getLogger().warn("registry auto-connect failed", { error: String(error) }),
        );
      }
    } finally {
      sweeping = false;
    }
  }

  if (autoEnabled() && !(globalThis as { agentloomSweep?: boolean }).agentloomSweep) {
    (globalThis as { agentloomSweep?: boolean }).agentloomSweep = true;
    setTimeout(() => void sweep().catch(() => undefined), 30_000).unref?.();
    setInterval(() => void sweep().catch(() => undefined), SWEEP_MS).unref?.();
  }

  return {
    registry: {
      list: authed.registry.list.handler(async ({ context }) => {
        const { title, entries } = registryInfo();
        if (autoEnabled() && mcpClient()) {
          await connectAll(context.actor, grantFor(context.actor.userId)).catch((error) =>
            getLogger().warn("registry auto-connect failed", { error: String(error) }),
          );
        }
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
        const entry = registryEntries().find((e) => e.id === input.id);
        if (!entry) {
          throw new ORPCError("NOT_FOUND", { message: "That app is not offered here." });
        }
        const server = await ensureServer(context.actor, entry);
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
