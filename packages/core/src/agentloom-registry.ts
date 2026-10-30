// AgentLoom: the apps an instance offers with one click, the "Darkcompute" section of
// Integrations. Each instance has its own list (agentloom/registry.yaml for DMZ,
// agentloom/corp/registry.yaml for CORP), which agentloom/gen-compose.py writes into the
// compose as AGENTLOOM_REGISTRY, so one image serves both.
//
// Each app's /api/mcp takes the member's own authentik token, asked for through the
// instance's pre-registered client (AGENTLOOM_MCP_CLIENT_ID/_SECRET), so a bot can do
// only what that person can. askWrites: a tool not declared read-only asks a person in every mode, Just go included.

export type RegistryEntry = {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  open: string | null;
  icon: string | null;
  askWrites: boolean;
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The connection slug a registry entry's MCP server is stored under. */
export function registrySlug(id: string): string {
  return `dc-${id}`;
}

let cached: { raw: string | undefined; entries: RegistryEntry[] } | undefined;

/** The instance's entries; a malformed entry is dropped, never half-used. */
export function registryEntries(
  raw: string | undefined = globalThis.process?.env?.AGENTLOOM_REGISTRY,
): RegistryEntry[] {
  if (cached && cached.raw === raw) return cached.entries;
  let parsed: unknown = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  const entries = (Array.isArray(parsed) ? parsed : []).flatMap((e): RegistryEntry[] => {
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
        icon: typeof r.icon === "string" && /^https:\/\//.test(r.icon) ? r.icon : null,
        askWrites: r.askWrites === true,
      },
    ];
  });
  cached = { raw, entries };
  return entries;
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
