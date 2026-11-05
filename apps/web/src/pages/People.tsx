// AgentLoom: the owner's switch for who may have bots reach their other spaces.
import { Trans, useLingui } from "@lingui/react/macro";
import { Switch } from "@rakazo/ui-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { desktopBridge } from "../lib/desktop";
import { useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { WindowChrome } from "./WindowChrome";

export function PeoplePage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const options = queries.people.list.queryOptions({});
  const people = useQuery({ ...options, retry: false });
  const change = useMutation({
    mutationFn: (input: { userId: string; enabled: boolean }) => rpc.people.setCrossSpace(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: options.queryKey }),
  });
  if (people.isPending) return <PageLoading />;
  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground/90">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        {desktopBridge() ? <WindowChrome /> : null}
        <Link to="/app" className="flex items-center gap-0.5 rounded-lg py-1 pe-1 text-sm">
          <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
          <Trans>Bots</Trans>
        </Link>
        <h1 className="text-heading2 font-semibold">
          <Trans>People</Trans>
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
          <Trans>
            On: this person's bots can ask bots in their other spaces, which do the work with their
            own apps and approvals. Off: each of their spaces stands alone.
          </Trans>
        </p>
        {people.isError ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Only the owner can see this page.</Trans>
          </p>
        ) : (
          <table data-testid="people-table" className="w-full text-start text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Person</Trans>
                </th>
                <th className="py-2 pe-4 text-start font-normal">
                  <Trans>Spaces</Trans>
                </th>
                <th className="py-2 text-start font-normal">
                  <Trans>Across spaces</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {(people.data ?? []).map((person) => (
                <tr
                  key={person.userId}
                  data-testid={`people-row-${person.userId}`}
                  className="border-t"
                >
                  <td className="py-2 pe-4">
                    <div className="font-medium">{person.name}</div>
                    <div className="text-xs text-muted-foreground">{person.email}</div>
                  </td>
                  <td className="py-2 pe-4">{person.spaces.join(", ")}</td>
                  <td className="py-2">
                    <Switch
                      aria-label={t`Let ${person.name}'s bots reach their other spaces`}
                      title={
                        person.lockedOff ? t`Off in the registry, so this cannot be turned on` : ""
                      }
                      disabled={person.lockedOff || change.isPending}
                      checked={person.crossSpace && !person.lockedOff}
                      onCheckedChange={(enabled) =>
                        change.mutate({ userId: person.userId, enabled })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {change.isError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            <Trans>That change did not save.</Trans>
          </p>
        ) : null}
      </div>
    </div>
  );
}
