// AgentLoom: Projects. Each member has a Gitea account the app makes for them;
// a project is one of its repositories. Bots reach it through Gitea's own MCP
// server (a "Projects" connection registered and assigned here, carrying the
// member's token), and the app reads it through the admin account acting as
// the member (Gitea's Sudo header), so no member token is needed to browse.
import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { McpServerConfigInput } from "@rakazo/contracts";
import { markdownToDocx } from "../markdown-docx.js";
import type { RouterContext } from "./context.js";

const SLUG = "projects";
/** The Gitea MCP tools a Projects connection offers (GITEA_TOOLS on the server). Working in
 * the member's own projects never asks: each gets an always-allow rule at setup. */
const PROJECT_TOOLS = [
  "create_repo",
  "list_my_repos",
  "get_repository_tree",
  "get_file_contents",
  "get_dir_contents",
  "create_or_update_file",
  "list_commits",
];
const MAX_FILE_BYTES = 200_000;
const MAX_DOWNLOAD_BYTES = 25_000_000;

type Gitea = { url: string; adminUser: string; adminPassword: string; mcpUrl: string };

function giteaConfig(): Gitea | null {
  const url = process.env.GITEA_URL?.trim().replace(/\/+$/, "");
  const adminUser = process.env.GITEA_ADMIN_USER?.trim();
  const adminPassword = process.env.GITEA_ADMIN_PASSWORD;
  const mcpUrl = process.env.GITEA_MCP_URL?.trim();
  return url && adminUser && adminPassword && mcpUrl
    ? { url, adminUser, adminPassword, mcpUrl }
    : null;
}

/** A stable Gitea username for a member: their ids are mixed case, Gitea's are not. */
export function giteaUsername(userId: string): string {
  return `al-${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function gitea(
  g: Gitea,
  path: string,
  init: { method?: string; body?: unknown; sudo?: string; auth?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: init.auth ?? basic(g.adminUser, g.adminPassword),
    Accept: "application/json",
  };
  if (init.sudo) headers.Sudo = init.sudo;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${g.url}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function giteaJson<T>(
  g: Gitea,
  path: string,
  init: Parameters<typeof gitea>[2] = {},
): Promise<T> {
  const response = await gitea(g, path, init);
  if (!response.ok) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `Projects store answered ${response.status} for ${init.method ?? "GET"} ${path.split("?")[0]}`,
    });
  }
  return (await response.json()) as T;
}

/** Make the member's Gitea account if missing, and return a fresh token for it. */
async function mintMemberToken(g: Gitea, username: string): Promise<string> {
  const password = randomBytes(24).toString("base64url");
  const existing = await gitea(g, `/users/${username}`);
  if (existing.status === 404) {
    await giteaJson(g, "/admin/users", {
      method: "POST",
      body: {
        username,
        email: `${username}@users.agentloom.local`,
        password,
        must_change_password: false,
        visibility: "private",
      },
    });
  } else if (existing.ok) {
    // The password is never kept; set a new one to mint a token with it.
    await giteaJson(g, `/admin/users/${username}`, {
      method: "PATCH",
      body: { login_name: username, source_id: 0, password, must_change_password: false },
    });
  } else {
    throw new ORPCError("BAD_GATEWAY", { message: `Projects store answered ${existing.status}` });
  }
  const token = await giteaJson<{ sha1: string }>(g, `/users/${username}/tokens`, {
    method: "POST",
    auth: basic(username, password),
    body: {
      name: `agentloom-${Date.now()}`,
      scopes: ["write:repository", "write:user", "write:issue"],
    },
  });
  return token.sha1;
}

export function projectsRoutes(ctx: RouterContext) {
  const { deps, authed, prepareMcpServer, insertMcpServer, announceMcpServer } = ctx;

  /** The member's Gitea account, Projects connection, and its assignment to every bot of theirs. */
  async function ensureProjects(g: Gitea, actor: Actor): Promise<string> {
    const username = giteaUsername(actor.userId);
    let server = await deps.prisma.mcpServer.findFirst({
      where: { spaceId: actor.spaceId, userId: actor.userId, slug: SLUG },
    });
    if (!server) {
      const token = await mintMemberToken(g, username);
      const input = McpServerConfigInput.parse({
        slug: SLUG,
        name: "Projects",
        description:
          "The user's projects: folders (repositories) where bots keep documents, files, status and a log.",
        enabled: true,
        transport: "streamable_http",
        endpoint: g.mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      });
      const stored = await prepareMcpServer(actor, input);
      const row = await deps.prisma.$transaction((tx) => insertMcpServer(tx, actor, input, stored));
      void announceMcpServer(row, actor).catch(() => undefined);
      server = row;
    }
    await deps.prisma.actionApprovalRule.createMany({
      data: PROJECT_TOOLS.map((tool) => ({
        spaceId: actor.spaceId,
        createdByUserId: actor.userId,
        effect: "always_allow",
        matchKind: "tool",
        matchValue: `mcp__${SLUG}__${tool}`,
      })),
      skipDuplicates: true,
    });
    const bots = await deps.prisma.bot.findMany({
      where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
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
    return username;
  }

  function requireGitea(): Gitea {
    const g = giteaConfig();
    if (!g)
      throw new ORPCError("PRECONDITION_FAILED", { message: "Projects are not set up here." });
    return g;
  }

  async function repo(g: Gitea, username: string, name: string) {
    const response = await gitea(g, `/repos/${username}/${encodeURIComponent(name)}`, {
      sudo: username,
    });
    if (response.status === 404) throw new ORPCError("NOT_FOUND", { message: "No such project." });
    if (!response.ok)
      throw new ORPCError("BAD_GATEWAY", { message: `Projects store answered ${response.status}` });
    return (await response.json()) as {
      name: string;
      description: string;
      updated_at: string;
      empty: boolean;
      default_branch: string;
    };
  }

  return {
    projects: {
      list: authed.projects.list.handler(async ({ context }) => {
        const g = giteaConfig();
        if (!g) return { enabled: false, projects: [] };
        const username = await ensureProjects(g, context.actor);
        const repos = await giteaJson<
          {
            name: string;
            description: string;
            updated_at: string;
            empty: boolean;
            owner: { login: string };
          }[]
        >(g, "/user/repos?limit=50", { sudo: username });
        return {
          enabled: true,
          projects: repos
            .filter((r) => r.owner.login === username)
            .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
            .map((r) => ({
              name: r.name,
              description: r.description,
              updatedAt: r.updated_at,
              empty: r.empty,
            })),
        };
      }),

      get: authed.projects.get.handler(async ({ context, input }) => {
        const g = requireGitea();
        const username = giteaUsername(context.actor.userId);
        const r = await repo(g, username, input.name);
        const base = `/repos/${username}/${encodeURIComponent(r.name)}`;
        if (r.empty) {
          return {
            name: r.name,
            description: r.description,
            updatedAt: r.updated_at,
            readme: null,
            files: [],
            activity: [],
          };
        }
        const [tree, commits, readme] = await Promise.all([
          giteaJson<{ tree: { path: string; type: string; size?: number }[] }>(
            g,
            `${base}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=true&per_page=1000`,
            { sudo: username },
          ),
          giteaJson<
            { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
          >(g, `${base}/commits?limit=15&stat=false&files=false`, { sudo: username }),
          gitea(g, `${base}/raw/README.md`, { sudo: username }).then((res) =>
            res.ok ? res.text() : null,
          ),
        ]);
        return {
          name: r.name,
          description: r.description,
          updatedAt: r.updated_at,
          readme: readme ? readme.slice(0, MAX_FILE_BYTES) : null,
          files: tree.tree.map((entry) => ({
            path: entry.path,
            type: entry.type === "tree" ? ("dir" as const) : ("file" as const),
            size: entry.size ?? 0,
          })),
          activity: commits.map((c) => ({
            sha: c.sha.slice(0, 8),
            message: c.commit.message.split("\n")[0] ?? "",
            author: c.commit.author.name,
            date: c.commit.author.date,
          })),
        };
      }),

      file: authed.projects.file.handler(async ({ context, input }) => {
        const g = requireGitea();
        const username = giteaUsername(context.actor.userId);
        const path = input.path.split("/").map(encodeURIComponent).join("/");
        const response = await gitea(
          g,
          `/repos/${username}/${encodeURIComponent(input.name)}/raw/${path}`,
          {
            sudo: username,
          },
        );
        if (!response.ok) throw new ORPCError("NOT_FOUND", { message: "No such file." });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const binary = bytes.subarray(0, 8000).includes(0);
        const truncated = bytes.length > MAX_FILE_BYTES;
        return {
          path: input.path,
          content: binary ? "" : new TextDecoder().decode(bytes.subarray(0, MAX_FILE_BYTES)),
          truncated,
          binary,
        };
      }),

      download: authed.projects.download.handler(async ({ context, input }) => {
        const g = requireGitea();
        const username = giteaUsername(context.actor.userId);
        const r = await repo(g, username, input.name);
        const base = `/repos/${username}/${encodeURIComponent(r.name)}`;
        const one = input.path?.split("/").map(encodeURIComponent).join("/");
        const response = one
          ? await gitea(g, `${base}/raw/${one}`, { sudo: username })
          : await gitea(g, `${base}/archive/${encodeURIComponent(r.default_branch)}.zip`, {
              sudo: username,
            });
        if (!response.ok) throw new ORPCError("NOT_FOUND", { message: "Nothing to download yet." });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (one && input.format === "docx") {
          if (!/\.(md|markdown|txt)$/i.test(input.path!)) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Only a text or Markdown file becomes a Word document.",
            });
          }
          const base = (input.path!.split("/").pop() ?? "document").replace(/\.[^.]+$/, "");
          return {
            filename: `${base}.docx`,
            base64: (await markdownToDocx(bytes.toString("utf8"), base)).toString("base64"),
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          };
        }
        if (bytes.length > MAX_DOWNLOAD_BYTES) {
          throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "Too large to download here." });
        }
        return {
          filename: one ? (input.path!.split("/").pop() ?? "file") : `${r.name}.zip`,
          base64: bytes.toString("base64"),
          mime: one
            ? (response.headers.get("content-type") ?? "application/octet-stream")
            : "application/zip",
        };
      }),
    },
  };
}
