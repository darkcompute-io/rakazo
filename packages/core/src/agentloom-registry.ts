// AgentLoom: the apps an instance offers with one click, its own titled section at the top
// of Integrations, with a way to ask for one it lacks. Each instance has its own file (agentloom/registry.yaml for DMZ,
// agentloom/corp/registry.yaml for CORP), which agentloom/gen-compose.py writes into the
// compose as AGENTLOOM_REGISTRY, so one image serves both.
//
// Each app's /api/mcp takes the member's own authentik token, asked for through the
// instance's pre-registered client (AGENTLOOM_MCP_CLIENT_ID/_SECRET), so a bot can do
// only what that person can. askWrites: a tool not declared read-only asks a person in
// every mode, Just go included.
//
// AGENTLOOM_REGISTRY is { title, apps: [...] }; a bare list is read as apps. "Request a
// connector" posts to AGENTLOOM_CONNECTOR_REQUEST_URL (apps/api/src/routes/registry.ts).

export type RegistryEntry = {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  open: string | null;
  icon: string | null;
  askWrites: boolean;
  /** Team spaces this app goes into, by team id; null = every space. */
  teams: string[] | null;
  /** Other hosts this app's views may show, such as where it keeps its images. */
  viewHosts: string[];
};

/** A space the instance keeps in step with an authentik group (CORP): who is in the
 * group is who is in the space, checked from each member's own token on every sweep. */
export type RegistryTeam = { id: string; name: string; group: string; isDefault: boolean };

export type RegistryTeams = {
  /** The organization the team spaces live in, made once by slug. */
  org: { name: string; slug: string };
  /** The email of the account that owns every team space (rename, invite, delete). */
  owner: string;
  spaces: RegistryTeam[];
  /** People whose bots may not reach their other spaces; everyone else's may. */
  crossSpaceOff: string[];
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The connection slug a registry entry's MCP server is stored under. */
export function registrySlug(id: string): string {
  return `dc-${id}`;
}

export type RegistryInfo = {
  /** The section's heading, e.g. "Darkcompute apps". */
  title: string;
  entries: RegistryEntry[];
  teams: RegistryTeams | null;
  /** Tool name patterns, `*` matching anything; see registryToolPolicy. */
  policy: { never: string[]; ask: string[] };
};

function parseTeams(raw: unknown): RegistryTeams | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const org = t.org as Record<string, unknown> | undefined;
  if (!org || typeof org.name !== "string" || typeof org.slug !== "string" || !ID.test(org.slug))
    return null;
  if (typeof t.owner !== "string" || !t.owner.includes("@")) return null;
  const spaces = (Array.isArray(t.spaces) ? t.spaces : []).flatMap((e): RegistryTeam[] => {
    const r = (e ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID.test(r.id)) return [];
    if (typeof r.name !== "string" || typeof r.group !== "string" || !r.group) return [];
    return [{ id: r.id, name: r.name.slice(0, 60), group: r.group, isDefault: r.default === true }];
  });
  if (!spaces.length || spaces.filter((s) => s.isDefault).length > 1) return null;
  return {
    org: { name: org.name.slice(0, 60), slug: org.slug },
    owner: t.owner.toLowerCase(),
    spaces,
    crossSpaceOff: (Array.isArray(t.crossSpaceOff) ? t.crossSpaceOff : []).filter(
      (address): address is string => typeof address === "string",
    ),
  };
}

function parsePolicy(raw: unknown): RegistryInfo["policy"] {
  const doc = (raw ?? {}) as Record<string, unknown>;
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter(
      (item): item is string => typeof item === "string" && item.startsWith("mcp__"),
    );
  return { never: list(doc.never), ask: list(doc.ask) };
}

const globMatch = (pattern: string, name: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(name);

/**
 * The instance's approval policy for a tool. "never": a person's own chat may ask for it, each
 * time; a routine or another bot may not. "ask": a person approves it in every mode. A tool
 * declared read-only is outside the policy, and so is everything the file does not name.
 */
export function registryToolPolicy(
  toolName: string,
  readOnly: boolean | undefined,
  policy: RegistryInfo["policy"] = registryInfo().policy,
): "never" | "ask" | null {
  if (readOnly === true) return null;
  if (policy.never.some((pattern) => globMatch(pattern, toolName))) return "never";
  if (policy.ask.some((pattern) => globMatch(pattern, toolName))) return "ask";
  return null;
}

let cached: { raw: string | undefined; info: RegistryInfo } | undefined;

/** The instance's registry; a malformed entry is dropped, never half-used. */
export function registryInfo(
  raw: string | undefined = globalThis.process?.env?.AGENTLOOM_REGISTRY,
): RegistryInfo {
  if (cached && cached.raw === raw) return cached.info;
  let parsed: unknown = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  const doc: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { apps: parsed };
  const apps = Array.isArray(doc.apps) ? doc.apps : [];
  const entries = apps.flatMap((e): RegistryEntry[] => {
    if (!e || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const endpoint =
      typeof r.endpoint === "string" && /^https:\/\//.test(r.endpoint) ? r.endpoint : null;
    if (!ID.test(id) || !endpoint || typeof r.name !== "string") return [];
    return [
      {
        id,
        name: r.name.slice(0, 60),
        description: typeof r.description === "string" ? r.description.slice(0, 300) : "",
        endpoint,
        open: typeof r.open === "string" && /^https:\/\//.test(r.open) ? r.open : null,
        // An https URL, or one of the icons this image ships (agentloom/registry-icons).
        icon:
          typeof r.icon === "string" &&
          (/^https:\/\//.test(r.icon) || /^\/registry-icons\/[a-z0-9-]+\.svg$/.test(r.icon))
            ? r.icon
            : null,
        askWrites: r.askWrites === true,
        teams: Array.isArray(r.teams)
          ? r.teams.filter((t): t is string => typeof t === "string" && ID.test(t))
          : null,
        viewHosts: Array.isArray(r.viewHosts)
          ? r.viewHosts.filter((h): h is string => typeof h === "string" && /^[a-z0-9.-]+$/.test(h))
          : [],
      },
    ];
  });
  const info: RegistryInfo = {
    title:
      typeof doc.title === "string" && doc.title.trim() ? doc.title.trim().slice(0, 60) : "Apps",
    entries,
    teams: parseTeams(doc.teams),
    policy: parsePolicy(doc.policy),
  };
  cached = { raw, info };
  return info;
}

export function registryEntries(raw?: string): RegistryEntry[] {
  return (raw === undefined ? registryInfo() : registryInfo(raw)).entries;
}

/** A tool declared read-only on a registry app: its arguments reach only that company server. */
export function registryReadStaysInside(
  toolName: string,
  readOnly: boolean | undefined,
  entries: RegistryEntry[] = registryEntries(),
): boolean {
  if (readOnly !== true) return false;
  return entries.some((entry) => toolName.startsWith(`mcp__${registrySlug(entry.id)}__`));
}

/** A call into an askWrites entry's tool that is not declared read-only. */
export function registryAlwaysAsks(
  toolName: string,
  readOnly: boolean | undefined,
  entries: RegistryEntry[] = registryEntries(),
): boolean {
  if (readOnly === true) return false;
  return entries.some(
    (entry) => entry.askWrites && toolName.startsWith(`mcp__${registrySlug(entry.id)}__`),
  );
}

/**
 * A registry app's tool its own server calls destructive. It asks every time without being named
 * in the policy, so a tool added to an app later cannot run unasked before the policy catches up.
 */
export function registryDestructiveAsks(
  toolName: string,
  destructive: boolean | undefined,
  entries: RegistryEntry[] = registryEntries(),
): boolean {
  if (destructive !== true) return false;
  return entries.some((entry) => toolName.startsWith(`mcp__${registrySlug(entry.id)}__`));
}

/**
 * One line for a bot's instructions naming the apps only some spaces have, so a bot without
 * them sends the person to the right space instead of offering to reconnect them.
 */
export function registryElsewhereNote(raw?: string): string | undefined {
  const info = raw === undefined ? registryInfo() : registryInfo(raw);
  const byTeam = new Map<string, string[]>();
  for (const entry of info.entries) {
    for (const team of entry.teams ?? []) {
      byTeam.set(team, [...(byTeam.get(team) ?? []), entry.name]);
    }
  }
  if (byTeam.size === 0) return undefined;
  const parts = [...byTeam].map(([team, apps]) => {
    const name = info.teams?.spaces.find((space) => space.id === team)?.name ?? team;
    return `${apps.join(", ")} only in the ${name} space`;
  });
  return `Some apps are not in every space: ${parts.join("; ")}. If someone needs one and you do not have its tools, ask a bot in that space if your directory lists one, otherwise tell them to switch to that space with the space switcher. Do not offer to add or reconnect it.`;
}

/** Whether a registry app belongs in a space: unrestricted, or that space is one of its teams. */
export function registryAppAllowed(entry: RegistryEntry, spaceTeam: string | null): boolean {
  return entry.teams === null || (spaceTeam !== null && entry.teams.includes(spaceTeam));
}
