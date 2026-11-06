import { describe, expect, it } from "vitest";
import {
  type ActionApprovalResolved,
  planActionGate,
} from "./action-approval.js";
import {
  registryAlwaysAsks,
  registryDestructiveAsks,
  registryAppAllowed,
  registryElsewhereNote,
  registryEntries,
  registryInfo,
  registryReadStaysInside,
  registrySlug,
  registryToolPolicy,
} from "./agentloom-registry.js";

const RAW = JSON.stringify([
  {
    id: "tasks",
    name: "Tasks",

    endpoint: "https://tasks.example/api/mcp",
    askWrites: false,
  },
  {
    id: "proxmox",
    name: "Proxmox",

    endpoint: "https://pve.example/mcp",
    askWrites: true,
  },
  { id: "Bad Id", name: "x", endpoint: "https://x/" },
  { id: "plain", name: "Plain", endpoint: "http://not-https/" },
  { id: "nowhere", name: "Nowhere" },
]);

describe("AgentLoom registry", () => {
  it("keeps only well-formed entries", () => {
    expect(registryEntries(RAW).map((e) => e.id)).toEqual(["tasks", "proxmox"]);
    expect(registryEntries("not json")).toEqual([]);
    expect(registryEntries(undefined)).toEqual([]);
  });

  it("reads the titled form", () => {
    const doc = JSON.stringify({
      title: "Darkcompute apps",
      apps: JSON.parse(RAW),
    });
    expect(registryInfo(doc).title).toBe("Darkcompute apps");
    expect(registryInfo(doc).entries.map((e) => e.id)).toEqual([
      "tasks",
      "proxmox",
    ]);
    expect(registryInfo("[]")).toMatchObject({ title: "Apps", entries: [] });
  });

  it("slugs a registry app apart from the member's own connections", () => {
    expect(registrySlug("tasks")).toBe("dc-tasks");
  });

  it("asks for an askWrites app's writes and nothing else", () => {
    const entries = registryEntries(RAW);
    expect(registryAlwaysAsks("mcp__dc-proxmox__vm_stop", false, entries)).toBe(
      true,
    );
    expect(
      registryAlwaysAsks("mcp__dc-proxmox__vm_stop", undefined, entries),
    ).toBe(true);
    expect(registryAlwaysAsks("mcp__dc-proxmox__vm_list", true, entries)).toBe(
      false,
    );
    expect(registryAlwaysAsks("mcp__dc-tasks__add_task", false, entries)).toBe(
      false,
    );
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
    expect(
      planActionGate({
        ...base,
        resolved: allow,
        mode: "never",
        alwaysAsk: true,
      }),
    ).toBe("ask");
    expect(planActionGate({ ...base, resolved: allow, mode: "never" })).toBe(
      "allow",
    );
    const deny: ActionApprovalResolved = {
      ...allow,
      decision: "deny",
      source: "deny",
    };
    expect(
      planActionGate({
        ...base,
        resolved: deny,
        mode: "never",
        alwaysAsk: true,
      }),
    ).toBe("deny");
  });
});

describe("registry teams", () => {
  const app = (extra: Record<string, unknown> = {}) => ({
    id: "fleet",
    name: "Fleet",
    endpoint: "https://mcp-fleet.example/api/mcp",
    ...extra,
  });
  const teams = {
    org: { name: "Darkcompute", slug: "darkcompute" },
    owner: "Owner@Example.test",
    spaces: [
      {
        id: "everyone",
        name: "Darkcompute",
        group: "Employees",
        default: true,
      },
      { id: "fleet", name: "Fleet", group: "team-fleet" },
    ],
  };

  it("reads the teams block and an app's teams", () => {
    const info = registryInfo(
      JSON.stringify({
        apps: [app({ teams: ["fleet"] }), app({ id: "mail" })],
        teams,
      }),
    );
    expect(info.teams?.owner).toBe("owner@example.test");
    expect(info.teams?.spaces.map((s) => [s.id, s.isDefault])).toEqual([
      ["everyone", true],
      ["fleet", false],
    ]);
    const [fleet, mail] = info.entries;
    expect(registryAppAllowed(fleet!, "fleet")).toBe(true);
    expect(registryAppAllowed(fleet!, "everyone")).toBe(false);
    expect(registryAppAllowed(fleet!, null)).toBe(false);
    expect(registryAppAllowed(mail!, null)).toBe(true);
  });

  it("names the apps only some spaces have, for a bot that lacks them", () => {
    const note = registryElsewhereNote(
      JSON.stringify({
        apps: [
          app({ name: "Fleet tools", teams: ["fleet"] }),
          app({ id: "mail" }),
        ],
        teams,
      }),
    );
    expect(note).toContain("Fleet tools only in the");
    expect(note).toContain("Do not offer to add or reconnect");
    expect(
      registryElsewhereNote(JSON.stringify({ apps: [app({ id: "mail" })] })),
    ).toBeUndefined();
  });

  it("lets only a declared read on a registry app skip the taint review", () => {
    const entries = [app({ id: "fleet" })] as ReturnType<
      typeof registryEntries
    >;
    const inside = (name: string, readOnly?: boolean) =>
      registryReadStaysInside(name, readOnly, entries);
    expect(inside("mcp__dc-fleet__node_status", true)).toBe(true);
    expect(inside("mcp__dc-fleet__queue_action", false)).toBe(false);
    expect(inside("mcp__dc-fleet__unknown")).toBe(false);
    expect(inside("mcp__someone-else__read", true)).toBe(false);
  });

  it("reads the approval policy, most severe first, and leaves reads alone", () => {
    const { policy } = registryInfo(
      JSON.stringify({
        apps: [],
        policy: {
          never: [
            "mcp__dc-books__record_payment",
            "mcp__dc-*__*delete*",
            "not-a-tool",
          ],
          ask: ["mcp__dc-inbox__send_mail", "mcp__dc-books__*"],
        },
      }),
    );
    expect(policy.never).toHaveLength(2);
    const level = (name: string, readOnly?: boolean) =>
      registryToolPolicy(name, readOnly, policy);
    expect(level("mcp__dc-books__record_payment")).toBe("never");
    expect(level("mcp__dc-tasks__delete_task")).toBe("never");
    expect(level("mcp__dc-inbox__send_mail")).toBe("ask");
    expect(level("mcp__dc-books__add_document")).toBe("ask");
    expect(level("mcp__dc-books__record_payment", true)).toBeNull();
    expect(level("mcp__dc-tasks__create_task")).toBeNull();
    expect(level("mcp__dc-books.record_payment")).toBeNull();
    expect(
      registryToolPolicy("mcp__dc-x__delete", undefined, {
        never: [],
        ask: [],
      }),
    ).toBeNull();
  });

  it("asks for a registry app's destructive tool unnamed, and only a registry app's", () => {
    const entries = registryEntries(
      JSON.stringify([
        { id: "tasks", name: "Tasks", endpoint: "https://t.example/mcp" },
      ]),
    );
    expect(
      registryDestructiveAsks("mcp__dc-tasks__remove_goal", true, entries),
    ).toBe(true);
    expect(
      registryDestructiveAsks("mcp__dc-tasks__add_goal", false, entries),
    ).toBe(false);
    expect(
      registryDestructiveAsks("mcp__dc-tasks__add_goal", undefined, entries),
    ).toBe(false);
    expect(
      registryDestructiveAsks("mcp__mine__remove_goal", true, entries),
    ).toBe(false);
  });

  it("drops a teams block it cannot trust whole", () => {
    const two = {
      ...teams,
      spaces: teams.spaces.map((s) => ({ ...s, default: true })),
    };
    expect(
      registryInfo(JSON.stringify({ apps: [], teams: two })).teams,
    ).toBeNull();
    expect(
      registryInfo(
        JSON.stringify({ apps: [], teams: { ...teams, owner: "nobody" } }),
      ).teams,
    ).toBeNull();
    expect(registryInfo(JSON.stringify({ apps: [] })).teams).toBeNull();
  });
});
