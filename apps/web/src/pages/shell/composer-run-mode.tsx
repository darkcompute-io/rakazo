import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionAutoReviewSettings } from "@rakazo/contracts";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web/components/ui/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSpaceQueries, writeSaved } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * AgentLoom: how much a bot asks before it acts, one click from the composer.
 * "Just go" is the same switch as Settings > Confirmations > Run actions without
 * asking, so the member's own "Ask before" rules (email, purchases) still ask.
 */
export function ComposerRunMode({ disabled }: { disabled?: boolean }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  const goId = useId();
  const reviewId = useId();
  const query = useQuery(queries.autoReview.get.queryOptions());
  const settings = query.data ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const justGo = settings?.skipApprovals ?? false;

  async function save(input: { enabled?: boolean; skipApprovals?: boolean }) {
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next: ActionAutoReviewSettings = await rpc.autoReview.set(input);
      await writeSaved(queryClient, queries.autoReview.get.queryKey(), () => next);
    } catch (err) {
      setError(errorText(err, t`Could not save`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            data-testid="composer-run-mode"
            aria-label={justGo ? t`Just go is on` : t`Run mode`}
            title={justGo ? t`Just go is on: bots act without asking` : t`How much bots ask before acting`}
            disabled={disabled || !settings}
            className={`size-8 shrink-0 rounded-full transition-colors ${
              justGo
                ? "bg-amber-400/15 text-amber-500 hover:bg-amber-400/25 hover:text-amber-500"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          />
        }
      >
        <Zap size={15} strokeWidth={2} fill={justGo ? "currentColor" : "none"} />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 gap-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor={goId} className="flex flex-col items-start gap-0.5 font-normal">
            <span className="text-[13.5px] text-foreground">
              <Trans>Just go</Trans>
            </span>
            <span className="text-[12px] leading-snug text-muted-foreground">
              <Trans>Act without asking. Your "Ask before" rules still ask.</Trans>
            </span>
          </Label>
          <Switch
            id={goId}
            data-testid="composer-just-go"
            checked={justGo}
            disabled={saving}
            onCheckedChange={(checked) => void save({ skipApprovals: checked })}
          />
        </div>
        {justGo ? null : (
          <div className="flex items-start justify-between gap-3">
            <Label htmlFor={reviewId} className="flex flex-col items-start gap-0.5 font-normal">
              <span className="text-[13.5px] text-foreground">
                <Trans>Check new sites for me</Trans>
              </span>
              <span className="text-[12px] leading-snug text-muted-foreground">
                <Trans>A model reviews pages it has not seen instead of asking you.</Trans>
              </span>
            </Label>
            <Switch
              id={reviewId}
              data-testid="composer-auto-review"
              checked={settings?.enabled ?? false}
              disabled={saving}
              onCheckedChange={(checked) => void save({ enabled: checked })}
            />
          </div>
        )}
        {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        <button
          type="button"
          className="self-start text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() =>
            setSearchParams((params) => {
              params.set("settings", "confirmations");
              return params;
            })
          }
        >
          <Trans>All confirmations</Trans>
        </button>
      </PopoverContent>
    </Popover>
  );
}
