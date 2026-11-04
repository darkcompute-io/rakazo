// AgentLoom: the space you are in, and a dropdown to the others. The roster below it shows
// one space at a time, so a team space and a personal one never share a list.
import { useLingui } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Check, ChevronsUpDown, Plus, Users } from "lucide-react";

export type SwitcherSpace = { id: string; name: string; shared?: boolean; unread: number };

export function SpaceSwitcher({
  spaces,
  currentId,
  onSelect,
  onNewSpace,
}: {
  spaces: readonly SwitcherSpace[];
  currentId: string | undefined;
  onSelect: (spaceId: string) => void;
  onNewSpace: () => void;
}) {
  const { t } = useLingui();
  const current = spaces.find((space) => space.id === currentId) ?? spaces[0];
  if (!current) return null;
  const elsewhere = spaces.reduce(
    (n, space) => n + (space.id === current.id ? 0 : space.unread),
    0,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="space-switcher"
        aria-label={t`Switch space`}
        className="mb-1 flex w-full items-center gap-2 rounded-xl border border-sidebar-border bg-card px-3 py-2 text-start text-sm font-medium text-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring dark:bg-input"
      >
        {current.shared ? (
          <Users size={15} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{current.name}</span>
        {elsewhere > 0 ? (
          <span
            data-testid="space-switcher-unread"
            className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground"
          >
            {elsewhere}
          </span>
        ) : null}
        <ChevronsUpDown size={15} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {spaces.map((space) => (
          <DropdownMenuItem
            key={space.id}
            data-testid={`space-switcher-item-${space.id}`}
            onClick={() => {
              if (space.id !== current.id) onSelect(space.id);
            }}
            className="flex items-center gap-2"
          >
            {space.id === current.id ? (
              <Check size={15} aria-hidden="true" className="shrink-0" />
            ) : (
              <span className="w-[15px] shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{space.name}</span>
            {space.shared ? (
              <Users size={14} aria-label={t`Shared`} className="shrink-0 text-muted-foreground" />
            ) : null}
            {space.unread > 0 && space.id !== current.id ? (
              <span className="rounded-full bg-primary px-1.5 text-xs leading-5 text-primary-foreground">
                {space.unread}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onNewSpace} className="flex items-center gap-2">
          <Plus size={15} aria-hidden="true" className="shrink-0" />
          <span>{t`New space`}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
