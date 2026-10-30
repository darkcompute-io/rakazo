import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * AgentLoom: this instance's own apps, tiles in the featured grid of Integrations.
 * Add makes the connection in this space and signs in as you (an authentik popup that
 * passes straight through when you are already signed in); the bots then act as you.
 */
export function RegistryTiles() {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = useQuery(queries.registry.list.queryOptions());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  async function add(id: string, serverId: string | null) {
    setPending(id);
    setError(null);
    try {
      const target = serverId ?? (await rpc.registry.add({ id })).serverId;
      await connectMcpOauth(target);
      await queryClient.invalidateQueries({ queryKey: queries.registry.list.queryKey() });
    } catch (err) {
      setError({ id, text: errorText(err, t`Could not add it`) });
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {(list.data?.entries ?? []).map((entry) => {
        const added = entry.serverId !== null;
        const busy = pending === entry.id;
        return (
          <div
            key={`registry-${entry.id}`}
            data-testid={`registry-tile-${entry.id}`}
            className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
          >
            {entry.icon ? (
              <img
                src={entry.icon}
                alt=""
                loading="lazy"
                className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
              />
            ) : (
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
                {entry.name[0]}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-medium text-foreground">{entry.name}</div>
              <div
                className={`truncate text-[12.5px] ${error?.id === entry.id ? "text-destructive" : "text-muted-foreground"}`}
                title={error?.id === entry.id ? error.text : entry.description}
              >
                {error?.id === entry.id
                  ? error.text
                  : entry.askWrites
                    ? t`Signed in as you · changes ask first`
                    : t`Signed in as you`}
              </div>
            </div>
            {entry.open ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t`Open ${entry.name}`}
                title={t`Open ${entry.name}`}
                onClick={() => window.open(entry.open ?? "", "_blank", "noopener")}
              >
                <ExternalLink />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              title={added ? t`Sign in again` : undefined}
              onClick={() => void add(entry.id, entry.serverId)}
            >
              {busy ? <Trans>Adding…</Trans> : added ? <Trans>Added</Trans> : <Trans>Add</Trans>}
            </Button>
          </div>
        );
      })}
    </>
  );
}
