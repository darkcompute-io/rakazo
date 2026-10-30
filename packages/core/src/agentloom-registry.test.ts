import { describe, expect, it } from "vitest";
import { type ActionApprovalResolved, planActionGate } from "./action-approval.js";
import { registryAlwaysAsks, registryEntries, registrySlug } from "./agentloom-registry.js";

const RAW = JSON.stringify([
  { id: "projects", name: "Projects", auth: "projects" },
  {
    id: "tasks",
    name: "Tasks",
    auth: "person",
    endpoint: "https://tasks.example/api/mcp",
    askWrites: false,
  },
  {
    id: "proxmox",
    name: "Proxmox",
    auth: "person",
    endpoint: "https://pve.example/mcp",
    askWrites: true,
  },
  { id: "Bad Id", name: "x", auth: "person", endpoint: "https://x/" },
  { id: "plain", name: "Plain", auth: "person", endpoint: "http://not-https/" },
  { id: "who", name: "Who", auth: "admin", endpoint: "https://x/" },
]);

describe("AgentLoom registry", () => {
  it("keeps only well-formed entries", () => {
    expect(registryEntries(RAW).map((e) => e.id)).toEqual(["projects", "tasks", "proxmox"]);
    expect(registryEntries("not json")).toEqual([]);
    expect(registryEntries(undefined)).toEqual([]);
  });

  it("slugs a registry app apart from the member's own connections", () => {
    expect(registrySlug("tasks")).toBe("dc-tasks");
    expect(registrySlug("projects")).toBe("projects");
  });

  it("asks for an askWrites app's writes and nothing else", () => {
    const entries = registryEntries(RAW);
    expect(registryAlwaysAsks("mcp__dc-proxmox__vm_stop", false, entries)).toBe(true);
    expect(registryAlwaysAsks("mcp__dc-proxmox__vm_stop", undefined, entries)).toBe(true);
    expect(registryAlwaysAsks("mcp__dc-proxmox__vm_list", true, entries)).toBe(false);
    expect(registryAlwaysAsks("mcp__dc-tasks__add_task", false, entries)).toBe(false);
    expect(registryAlwaysAsks("mcp__other__x", false, entries)).toBe(false);
  });

  it("asks even under Just go, and a deny still wins", () => {
    const base = { consequential: true, checkerConfigured: false } as const;
    const allow: ActionApprovalResolved = {
      decision: "allow",
      source: "always_allow",
      matchingRules: [],
      decisiveRules: [],
    };
    expect(planActionGate({ ...base, resolved: allow, mode: "never", alwaysAsk: true })).toBe(
      "ask",
    );
    expect(planActionGate({ ...base, resolved: allow, mode: "never" })).toBe("allow");
    const deny: ActionApprovalResolved = { ...allow, decision: "deny", source: "deny" };
    expect(planActionGate({ ...base, resolved: deny, mode: "never", alwaysAsk: true })).toBe(
      "deny",
    );
  });
});
