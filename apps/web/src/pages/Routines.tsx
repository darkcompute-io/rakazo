// AgentLoom: every routine in the current space on one page, with the ones that need a person
// first. A run waiting for input or failed stops quietly on its bot's panel otherwise.
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { statusLabel } from "./ActivityList";
import { WindowChrome } from "./WindowChrome";

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "-");

export function RoutinesPage() {
  const queries = useSpaceQueries();
  const board = useQuery({
    ...queries.routines.board.queryOptions({}),
    refetchInterval: 30_000,
  });
  if (board.isPending) return <PageLoading />;
  const rows = board.data ?? [];
  const stuck = rows.filter((row) => row.stuck).length;
  const spent = rows.reduce((total, row) => total + row.spent24h, 0);
  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        {desktopBridge() ? <WindowChrome /> : null}
        <Link to="/app" className="flex items-center gap-0.5 rounded-lg py-1 pe-1 text-sm">
          <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
          <Trans>Bots</Trans>
        </Link>
        <h1 className="text-heading2 font-semibold">
          <Trans>Routines</Trans>
        </h1>
        {stuck > 0 ? (
          <span
            data-testid="routines-stuck"
            className="rounded-full bg-destructive px-2 text-xs leading-5 text-white"
          >
            <Trans>{stuck} need attention</Trans>
          </span>
        ) : null}
        <span data-testid="routines-spent" className="ms-auto text-sm text-muted-foreground">
          <Trans>${spent.toFixed(2)} in 24 hours</Trans>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {board.isError ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not load routines</Trans>
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No routines in this space yet.</Trans>
          </p>
        ) : (
          <table data-testid="routines-board" className="w-full text-start text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Routine</Trans>
                </th>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Bot</Trans>
                </th>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>State</Trans>
                </th>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Last run</Trans>
                </th>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Result</Trans>
                </th>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Next run</Trans>
                </th>
                <th className="py-2 text-end font-normal">
                  <Trans>Cost, 24 hours</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`routines-row-${row.id}`}
                  className={row.stuck ? "border-t bg-destructive/10" : "border-t"}
                >
                  <td className="py-2 pe-4 font-medium">{row.name}</td>
                  <td className="py-2 pe-4">
                    <Link to={`/app/${row.botId}`} className="underline underline-offset-2">
                      {row.botName}
                    </Link>
                  </td>
                  <td className="py-2 pe-4">
                    {row.active ? <Trans>On</Trans> : <Trans>Paused</Trans>}
                  </td>
                  <td className="py-2 pe-4">{when(row.lastRunAt)}</td>
                  <td className="py-2 pe-4">
                    {row.lastStatus ? statusLabel(row.lastStatus as never) : "-"}
                  </td>
                  <td className="py-2 pe-4">{when(row.active ? row.nextRunAt : null)}</td>
                  <td className="py-2 text-end">${row.spent24h.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
