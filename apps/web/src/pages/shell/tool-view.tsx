// AgentLoom: what an app asked the chat to show (packages/core agentloom-view.ts). Live is a
// plain image of the app's picture stream, so nothing from the app runs in this page.
import { Trans } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

type ViewBlock = Extract<MessageBlock, { kind: "view" }>;

function OpenLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[13px] underline underline-offset-2"
    >
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

const origin = (url: string) => new URL(url).origin;

function LiveView({ block }: { block: ViewBlock }) {
  const [ended, setEnded] = useState(false);
  // A browser feeds one picture stream to one element, so each mount asks for its own.
  const [attempt, setAttempt] = useState(() => Math.random().toString(36).slice(2));
  const src = `${block.url}?v=${attempt}`;
  if (!block.url) return null;
  return (
    <div data-testid="tool-view-live" className="w-full max-w-sm rounded-2xl border bg-card p-3">
      <p className="mb-2 truncate text-[13px] text-muted-foreground" dir="auto">
        {block.title}
      </p>
      {ended ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          <Trans>This view has ended, or the app needs you to sign in.</Trans>
          <button
            type="button"
            className="ms-2 underline underline-offset-2"
            onClick={() => {
              setAttempt(Math.random().toString(36).slice(2));
              setEnded(false);
            }}
          >
            <Trans>Retry</Trans>
          </button>
        </p>
      ) : (
        <img
          src={src}
          alt={block.title}
          onError={() => setEnded(true)}
          className="max-h-[70vh] w-full rounded-lg object-contain"
        />
      )}
      <div className="mt-2">
        <OpenLink url={origin(block.url)}>
          <Trans>Open the app</Trans>
        </OpenLink>
      </div>
    </div>
  );
}

export function ToolView({ block }: { block: ViewBlock }) {
  if (block.view === "live") return <LiveView block={block} />;
  if (block.view === "page" && block.url) {
    return (
      <div data-testid="tool-view-page" className="rounded-2xl border bg-card px-3 py-2">
        <OpenLink url={block.url}>{block.title || <Trans>Open</Trans>}</OpenLink>
      </div>
    );
  }
  return (
    <div data-testid="tool-view-media" className="w-full max-w-xl rounded-2xl border bg-card p-3">
      {block.title ? (
        <p className="mb-2 truncate text-[13px] text-muted-foreground" dir="auto">
          {block.title}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {(block.images ?? []).map((image) => (
          <a key={image.url} href={image.url} target="_blank" rel="noreferrer">
            <img
              src={image.url}
              alt={image.caption}
              loading="lazy"
              className="w-full rounded-lg object-cover"
            />
            {image.caption ? (
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {image.caption}
              </span>
            ) : null}
          </a>
        ))}
      </div>
    </div>
  );
}
