import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, Textarea, toast } from "@rakazo/ui-web";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web/components/ui/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus } from "lucide-react";
import { useState } from "react";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * AgentLoom: this instance's own apps, a titled section at the top of Integrations, and a
 * way to ask for one it lacks. Add makes the connection in this space and signs in as you
 * (an authentik popup that passes straight through when you are already signed in); the
 * bots then act as you. Nothing shows when the instance offers no apps and no address.
 */
export function RegistrySection() {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = useQuery(queries.registry.list.queryOptions());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const data = list.data;

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

  if (!data || (!data.entries.length && !data.requestable)) return null;
  return (
    <section className="mb-6" data-testid="registry-section">
      <h2 className="mb-2 px-2.5 text-[15px] font-medium text-foreground">{data.title}</h2>
      {data.entries.length === 0 ? (
        <p className="mb-1 px-2.5 text-[13px] text-muted-foreground">
          <Trans>Nothing here yet. Ask for the app you need.</Trans>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {data.entries.map((entry) => {
          const added = entry.serverId !== null;
          const busy = pending === entry.id;
          const failed = error?.id === entry.id ? error.text : null;
          return (
            <div
              key={entry.id}
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
                  className={`truncate text-[12.5px] ${failed ? "text-destructive" : "text-muted-foreground"}`}
                  title={failed ?? entry.description}
                >
                  {failed ??
                    (entry.askWrites
                      ? t`Signed in as you · changes ask first`
                      : t`Signed in as you`)}
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
        {data.requestable ? (
          <button
            type="button"
            data-testid="registry-request"
            onClick={() => setAsking(true)}
            className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-start hover:bg-accent/60"
          >
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-dashed border-border text-muted-foreground">
              <Plus size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-medium text-foreground">
                <Trans>Request a connector</Trans>
              </div>
              <div className="truncate text-[12.5px] text-muted-foreground">
                <Trans>An app or tool you need here</Trans>
              </div>
            </div>
          </button>
        ) : null}
      </div>
      {data.requestable ? <RequestDialog open={asking} onOpenChange={setAsking} /> : null}
    </section>
  );
}

function RequestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const [app, setApp] = useState("");
  const [why, setWhy] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await rpc.registry.request({ app, why });
      toast.success(t`Sent to the team.`);
      setApp("");
      setWhy("");
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, t`Could not send it`));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>Request a connector</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Once it is added it shows here for everyone.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          maxLength={120}
          placeholder={t`App or tool, e.g. Jira`}
          value={app}
          onChange={(event) => setApp(event.target.value)}
        />
        <Textarea
          rows={4}
          maxLength={2000}
          placeholder={t`What should a bot do there? (optional)`}
          value={why}
          onChange={(event) => setWhy(event.target.value)}
        />
        {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" disabled={sending || !app.trim()} onClick={() => void send()}>
            {sending ? <Trans>Sending…</Trans> : <Trans>Send request</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
