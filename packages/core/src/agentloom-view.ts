// AgentLoom: what a registry app asks the chat to show while a bot works. A tool answers with a
// top-level `view` in its JSON: live (a picture stream), media (images) or page (a link). Tool
// output is untrusted, so a view only ever names an https address on a registry app's own host:
// a page a bot read cannot make the chat load somebody else's image.
import { type RegistryEntry, registryEntries } from "./agentloom-registry.js";

export type ToolView = {
  view: "live" | "media" | "page";
  title: string;
  url?: string;
  images?: { url: string; caption: string }[];
};

const MAX_IMAGES = 12;

function hostsOf(entries: RegistryEntry[]): Set<string> {
  const hosts = new Set<string>();
  for (const entry of entries) {
    for (const value of [entry.endpoint, entry.open]) {
      if (!value) continue;
      try {
        hosts.add(new URL(value).hostname);
      } catch {
        // A registry entry that does not parse grants nothing.
      }
    }
    for (const host of entry.viewHosts ?? []) hosts.add(host);
  }
  return hosts;
}

function allowedUrl(value: unknown, hosts: Set<string>): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && hosts.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function fromObject(raw: Record<string, unknown>, hosts: Set<string>): ToolView | null {
  const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : "";
  if (raw.kind === "live" || raw.kind === "page") {
    const url = allowedUrl(raw.url, hosts);
    return url ? { view: raw.kind, title, url } : null;
  }
  if (raw.kind === "media" && Array.isArray(raw.images)) {
    const images = raw.images.slice(0, MAX_IMAGES).flatMap((image) => {
      const item = (image ?? {}) as Record<string, unknown>;
      const url = allowedUrl(item.url, hosts);
      if (!url) return [];
      return [{ url, caption: typeof item.caption === "string" ? item.caption.slice(0, 200) : "" }];
    });
    return images.length > 0 ? { view: "media", title, images } : null;
  }
  return null;
}

function search(value: unknown, hosts: Set<string>, depth: number): ToolView | null {
  if (depth > 3) return null;
  let parsed = value;
  if (typeof value === "string") {
    if (!value.includes("view")) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.view && typeof record.view === "object") {
    return fromObject(record.view as Record<string, unknown>, hosts);
  }
  // A catalog wrapper carries the app's answer as MCP content.
  for (const part of Array.isArray(record.content) ? record.content : []) {
    const text = (part as { text?: unknown } | null)?.text;
    const found = typeof text === "string" ? search(text, hosts, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

/** The view a connector tool's answer asks for, or null. Only connector tools may ask. */
export function toolViewFrom(
  toolName: string,
  content: readonly unknown[],
  entries: RegistryEntry[] = registryEntries(),
): ToolView | null {
  if (!toolName.startsWith("mcp__") && !toolName.endsWith("_execute_tool")) return null;
  const hosts = hostsOf(entries);
  if (hosts.size === 0) return null;
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text;
    const found = typeof text === "string" ? search(text, hosts, 0) : null;
    if (found) return found;
  }
  return null;
}
