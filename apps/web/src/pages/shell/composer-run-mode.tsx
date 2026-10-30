import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionAutoReviewSettings, ApprovalMode } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Button, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web/components/ui/popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * AgentLoom: how much a bot asks before it acts, one click from the composer.
 * The same setting as Settings > Confirmations > Mode, for whichever copy applies in
 * this Space: "Just go" is never ask, "Auto" has a model check, "Ask" asks.
 */
export function ComposerRunMode({ disabled }: { disabled?: boolean }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  const query = useQuery(queries.autoReview.get.queryOptions());
  const settings = query.data ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const justGo = settings?.mode === "never";
  const modes: Array<{ mode: ApprovalMode; label: string; hint: string }> = [
    { mode: "never", label: t`Just go`, hint: t`Bots act without asking.` },
    ...(settings?.checkerAvailable || settings?.mode === "auto"
      ? [
          {
            mode: "auto" as const,
            label: t`Auto`,
            hint: t`A model checks each new action instead of asking you.`,
          },
        ]
      : []),
    { mode: "ask", label: t`Ask`, hint: t`Bots ask before actions they have not done before.` },
  ];
  const current = modes.find((m) => m.mode === settings?.mode);

  async function save(mode: ApprovalMode) {
    if (!settings || saving || mode === settings.mode) return;
    setSaving(true);
    setError(null);
    try {
      const next: ActionAutoReviewSettings = await rpc.autoReview.set({ mode });
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
            title={
              justGo
                ? t`Just go is on: bots act without asking`
                : t`How much bots ask before acting`
            }
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
        <ToggleGroup
          aria-label={t`Run mode`}
          data-testid="composer-run-mode-choice"
          value={settings ? [settings.mode] : []}
          onValueChange={([next]) => {
            if (next) void save(next as ApprovalMode);
          }}
          disabled={saving || !settings}
          spacing={1}
          className="rounded-lg bg-muted p-1"
        >
          {modes.map(({ mode, label }) => (
            <ToggleGroupItem
              key={mode}
              value={mode}
              className="h-7 flex-1 px-2 text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {current ? (
          <p className="text-[12px] leading-snug text-muted-foreground">{current.hint}</p>
        ) : null}
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
