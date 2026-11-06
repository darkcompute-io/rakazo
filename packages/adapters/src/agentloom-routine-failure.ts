// AgentLoom: a routine that failed in a team space files one item in Tasks' triage, one per routine
// per day, so a failure lands in the queue bots work and does not wait for someone to read a
// notification. The error text stays out: triage has a wider audience than the space, and an error
// can echo a value. A person's own spaces file nothing. Filing never affects the run.
import { registryInfo } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

type Prisma = {
  organization: {
    findUnique(args: {
      where: { slug: string };
      select: { metadata: true };
    }): Promise<{ metadata: string | null } | null>;
  };
  routine: {
    findUnique(args: {
      where: { id: string };
      select: { name: true };
    }): Promise<{ name: string } | null>;
  };
};

export async function fileRoutineFailure(
  prisma: Prisma,
  run: { routineId: string | null; spaceId: string },
  botName: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    teams?: { org: { slug: string } } | null;
    now?: number;
  } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const url = env.AGENTLOOM_CONNECTOR_REQUEST_URL?.trim();
  const token = env.AGENTLOOM_CONNECTOR_REQUEST_TOKEN?.trim();
  const teams = options.teams === undefined ? registryInfo().teams : options.teams;
  if (!url || !token || !teams || !run.routineId) return false;
  try {
    const org = await prisma.organization.findUnique({
      where: { slug: teams.org.slug },
      select: { metadata: true },
    });
    const map = (JSON.parse(org?.metadata || "{}") as { agentloomTeams?: Record<string, string> })
      .agentloomTeams;
    if (!map || !Object.values(map).includes(run.spaceId)) return false;
    const routine = await prisma.routine.findUnique({
      where: { id: run.routineId },
      select: { name: true },
    });
    const day = new Date(options.now ?? Date.now()).toISOString().slice(0, 10);
    const response = await (options.fetcher ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: `Routine failed: ${routine?.name ?? "unnamed"} (${botName})`,
        text: `The routine ${routine?.name ?? "unnamed"} on ${botName} failed on ${day}. Open the Routines page in AgentLoom to see the run.`,
        by: "agentloom",
        where: "agentloom routines",
        ext: `routine-failed:${run.routineId}:${day}`,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch (error) {
    getLogger().warn("routine failure not filed", { error: String(error) });
    return false;
  }
}
