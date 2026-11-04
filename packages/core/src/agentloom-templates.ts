// AgentLoom: space templates - a named set of bots, each with its instructions and its
// routines, that a new space can start from. Each instance has its own file
// (agentloom/corp/space-templates.yaml), which agentloom/gen-compose.py writes into the
// compose as AGENTLOOM_SPACE_TEMPLATES. A template's routines are made paused: nothing runs
// on a schedule until a person turns it on.

export type TemplateRoutine = { name: string; prompt: string; cron: string; timezone: string };
export type TemplateBot = {
  key: string;
  name: string;
  description: string;
  instructions: string;
  routines: TemplateRoutine[];
};
export type SpaceTemplate = {
  id: string;
  name: string;
  description: string;
  /** The apps its bots are written to use, by registry id - shown, never enforced. */
  apps: string[];
  bots: TemplateBot[];
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

let cached: { raw: string | undefined; list: SpaceTemplate[] } | undefined;

/** The instance's templates; a malformed bot or routine drops its template whole. */
export function spaceTemplates(
  raw: string | undefined = globalThis.process?.env?.AGENTLOOM_SPACE_TEMPLATES,
): SpaceTemplate[] {
  if (cached && cached.raw === raw) return cached.list;
  let parsed: unknown = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  const seen = new Set<string>();
  const list = (Array.isArray(parsed) ? parsed : []).flatMap((t): SpaceTemplate[] => {
    const r = (t ?? {}) as Record<string, unknown>;
    const id = str(r.id, 32);
    if (!ID.test(id) || seen.has(id) || !str(r.name, 60)) return [];
    const bots: TemplateBot[] = [];
    for (const b of Array.isArray(r.bots) ? r.bots : []) {
      const x = (b ?? {}) as Record<string, unknown>;
      const key = str(x.key, 32);
      if (!ID.test(key) || !str(x.name, 60) || !str(x.instructions, 20_000)) return [];
      const routines: TemplateRoutine[] = [];
      for (const ro of Array.isArray(x.routines) ? x.routines : []) {
        const y = (ro ?? {}) as Record<string, unknown>;
        if (!str(y.name, 80) || !str(y.prompt, 8000) || !str(y.cron, 120)) return [];
        routines.push({
          name: str(y.name, 80),
          prompt: str(y.prompt, 8000),
          cron: str(y.cron, 120),
          timezone: str(y.timezone, 64) || "UTC",
        });
      }
      bots.push({
        key,
        name: str(x.name, 60),
        description: str(x.description, 300),
        instructions: str(x.instructions, 20_000),
        routines,
      });
    }
    seen.add(id);
    return [
      {
        id,
        name: str(r.name, 60),
        description: str(r.description, 300),
        apps: (Array.isArray(r.apps) ? r.apps : []).filter(
          (a): a is string => typeof a === "string" && ID.test(a),
        ),
        bots,
      },
    ];
  });
  cached = { raw, list };
  return list;
}

/** The idempotency key a template's bot is made under in one space. */
export function templateSpawnKey(templateId: string, botKey: string): string {
  return `template:${templateId}:${botKey}`;
}
