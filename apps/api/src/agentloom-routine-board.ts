// AgentLoom: the Routines page's rows. A routine is stuck when its latest run is waiting on a
// person or ended badly; those sort first, then the ones that are on, then by name.
const STUCK = new Set([
  "waiting_input",
  "waiting_takeover",
  "failed",
  "setup_failed",
  "interrupted",
]);

type Row = {
  id: string;
  name: string;
  botId: string;
  active: boolean;
  nextRunAt: Date | null;
  bot: { name: string };
  runs: { status: string; createdAt: Date }[];
};

export function routineBoard(rows: Row[]) {
  return rows
    .map((row) => {
      const last = row.runs[0];
      return {
        id: row.id,
        name: row.name,
        botId: row.botId,
        botName: row.bot.name,
        active: row.active,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: last?.createdAt.toISOString() ?? null,
        lastStatus: last?.status ?? null,
        stuck: last ? STUCK.has(last.status) : false,
      };
    })
    .sort(
      (a, b) =>
        Number(b.stuck) - Number(a.stuck) ||
        Number(b.active) - Number(a.active) ||
        a.name.localeCompare(b.name),
    );
}
