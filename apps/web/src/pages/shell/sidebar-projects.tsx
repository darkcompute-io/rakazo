import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Button } from "@rakazo/ui-web";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Printer,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/**
 * AgentLoom: Projects in the sidebar. A project is one of the member's Gitea
 * repositories; bots create and keep them, and this shows them: the README as
 * status, the files, recent activity as the log, and downloads.
 */
export function SidebarProjects() {
  const queries = useSpaceQueries();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ ...queries.projects.list.queryOptions(), refetchInterval: 30_000 });
  const data = list.data;
  if (!data?.enabled) return null;

  return (
    <div className="mt-3 px-2" data-testid="sidebar-projects">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-foreground hover:bg-accent/60"
      >
        <Trans>Projects</Trans>
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col">
          {data.projects.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12px] leading-snug text-muted-foreground">
              <Trans>When work is worth keeping, a bot offers to start a project for it.</Trans>
            </p>
          ) : (
            data.projects.map((project) => (
              <button
                key={project.name}
                type="button"
                data-testid="sidebar-project"
                onClick={() => setSelected(project.name)}
                className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-[13.5px] text-foreground hover:bg-accent"
                title={project.description || project.name}
              >
                <Folder size={15} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
      <ProjectDialog name={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function saveFile(filename: string, base64: string, mime: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ProjectDialog({ name, onClose }: { name: string | null; onClose: () => void }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = useQuery({
    ...queries.projects.get.queryOptions({ input: { name: name ?? "" } }),
    enabled: Boolean(name),
  });
  const file = useQuery({
    ...queries.projects.file.queryOptions({ input: { name: name ?? "", path: path ?? "" } }),
    enabled: Boolean(name && path),
  });
  const files = useMemo(
    () =>
      (project.data?.files ?? [])
        .filter((entry) => entry.type === "file")
        .sort((a, b) => a.path.localeCompare(b.path)),
    [project.data],
  );

  const rendered = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  async function download(one?: string, format?: "docx") {
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.projects.download({
        name,
        ...(one ? { path: one } : {}),
        ...(format ? { format } : {}),
      });
      saveFile(result.filename, result.base64, result.mime);
    } catch (err) {
      setError(errorText(err, t`Could not download`));
    } finally {
      setBusy(false);
    }
  }

  const showing = path ?? "README.md";
  const body = path ? file.data : null;
  const markdown = showing.toLowerCase().endsWith(".md");
  const text = path ? (body && !body.binary ? body.content : null) : (project.data?.readme ?? null);

  async function copy() {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(errorText(err, t`Could not copy`));
    }
  }

  /** PDF the way a browser makes one: the rendered file in a print view. */
  function print() {
    const html = rendered.current?.innerHTML;
    if (!html) return;
    const view = window.open("", "_blank", "noopener=no,width=900,height=1000");
    if (!view) {
      setError(t`Allow pop-ups to save as PDF.`);
      return;
    }
    const doc = view.document;
    doc.title = showing.replace(/\.[^.]+$/, "");
    const style = doc.createElement("style");
    style.textContent =
      "body{font:15px/1.6 -apple-system,Segoe UI,Inter,sans-serif;color:#111;max-width:760px;margin:40px auto;padding:0 24px}" +
      "h1,h2,h3{line-height:1.25}table{border-collapse:collapse;width:100%;margin:12px 0}" +
      "th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:13px}th{background:#f3f3f1}" +
      "pre,code{font-family:Menlo,Consolas,monospace;background:#f3f3f1;border-radius:4px}pre{padding:10px;white-space:pre-wrap}" +
      "a{color:#3b4bd8}button,svg{display:none}@page{margin:18mm}";
    doc.head.appendChild(style);
    const main = doc.createElement("main");
    main.innerHTML = html;
    doc.body.appendChild(main);
    view.focus();
    setTimeout(() => view.print(), 250);
  }

  return (
    <Dialog
      open={Boolean(name)}
      onOpenChange={(next) => {
        if (!next) {
          setPath(null);
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="flex h-[min(80vh,720px)] w-[min(96vw,1000px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-[17px]">
              <FolderOpen size={18} className="text-muted-foreground" />
              <span className="truncate">{name}</span>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px]">
              {project.data?.description || t`A project your bots keep.`}
              {project.data?.updatedAt ? ` · ${t`Updated`} ${when(project.data.updatedAt)}` : ""}
            </DialogDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !files.length}
            onClick={() => void download()}
            className="me-8 shrink-0"
          >
            <Download size={14} />
            <Trans>Download all</Trans>
          </Button>
        </DialogHeader>
        {error ? <p className="px-5 pt-2 text-[12px] text-destructive">{error}</p> : null}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-border p-2 md:border-b-0 md:border-e">
            <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Trans>Files</Trans>
            </p>
            {project.isPending ? (
              <p className="px-2 py-1 text-[12.5px] text-muted-foreground">
                <Trans>Loading…</Trans>
              </p>
            ) : files.length === 0 ? (
              <p className="px-2 py-1 text-[12.5px] text-muted-foreground">
                <Trans>Nothing here yet.</Trans>
              </p>
            ) : (
              files.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => setPath(entry.path === "README.md" ? null : entry.path)}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] hover:bg-accent ${
                    showing === entry.path ? "bg-accent text-foreground" : "text-foreground/85"
                  }`}
                >
                  <FileText size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.path}</span>
                </button>
              ))
            )}
            {project.data?.activity.length ? (
              <>
                <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Trans>Activity</Trans>
                </p>
                {project.data.activity.map((entry) => (
                  <div key={entry.sha} className="px-2 py-1.5">
                    <p className="text-[12.5px] leading-snug text-foreground/90">{entry.message}</p>
                    <p className="text-[11.5px] text-muted-foreground">{when(entry.date)}</p>
                  </div>
                ))}
              </>
            ) : null}
          </aside>
          <section className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2.5">
              <span className="truncate text-[13px] text-muted-foreground">{showing}</span>
              {files.some((entry) => entry.path === showing) ? (
                <div
                  className="flex shrink-0 items-center gap-0.5"
                  data-testid="project-file-actions"
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={text === null}
                    onClick={() => void copy()}
                    title={t`Copy`}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                  </Button>
                  {markdown ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void download(showing, "docx")}
                        title={t`Download as a Word document`}
                      >
                        <FileType size={14} />
                        <Trans>Word</Trans>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={print}
                        title={t`Print or save as PDF`}
                      >
                        <Printer size={14} />
                        <Trans>PDF</Trans>
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void download(showing)}
                    title={t`Download the file as it is`}
                  >
                    <Download size={14} />
                    <Trans>Download</Trans>
                  </Button>
                </div>
              ) : null}
            </div>
            <div ref={rendered} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[14px]">
              {path ? (
                file.isPending ? (
                  <p className="text-muted-foreground">
                    <Trans>Loading…</Trans>
                  </p>
                ) : body?.binary ? (
                  <p className="text-muted-foreground">
                    <Trans>This file can't be shown here. Download it to open it.</Trans>
                  </p>
                ) : markdown ? (
                  <ChatMarkdown>{body?.content ?? ""}</ChatMarkdown>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px]">
                    {body?.content}
                  </pre>
                )
              ) : project.data?.readme ? (
                <ChatMarkdown>{project.data.readme}</ChatMarkdown>
              ) : (
                <p className="text-muted-foreground">
                  <Trans>No status yet. Bots keep a short status in README.md.</Trans>
                </p>
              )}
              {body?.truncated ? (
                <p className="mt-3 text-[12px] text-muted-foreground">
                  <Trans>Showing the start of this file. Download it for the rest.</Trans>
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
