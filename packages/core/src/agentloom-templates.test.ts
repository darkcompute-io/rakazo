import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spaceTemplates, templateSpawnKey } from "./agentloom-templates.js";

describe("space templates", () => {
  it("reads templates, bots and routines", () => {
    const list = spaceTemplates(
      JSON.stringify([
        {
          id: "fleet",
          name: "Fleet",
          apps: ["fleet", "Not An Id"],
          bots: [
            {
              key: "watch",
              name: "Fleet watch",
              instructions: "Watch.",
              routines: [{ name: "Morning", prompt: "Check.", cron: "0 8 * * *" }],
            },
          ],
        },
      ]),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.apps).toEqual(["fleet"]);
    expect(list[0]!.bots[0]!.routines[0]!.timezone).toBe("UTC");
    expect(templateSpawnKey("fleet", "watch")).toBe("template:fleet:watch");
  });

  it("drops a template with a broken bot or routine, and a repeated id", () => {
    const bad = spaceTemplates(
      JSON.stringify([
        { id: "a", name: "A", bots: [{ key: "x", name: "X" }] },
        { id: "b", name: "B", bots: [{ key: "x", name: "X", instructions: "i", routines: [{ name: "r" }] }] },
        { id: "c", name: "C", bots: [] },
        { id: "c", name: "C again", bots: [] },
      ]),
    );
    expect(bad.map((t) => t.id)).toEqual(["c"]);
    expect(spaceTemplates("not json")).toEqual([]);
  });

  it("reads every template agentloom.corp ships", () => {
    const path = process.env.AGENTLOOM_TEMPLATES_FIXTURE;
    if (!path) return;
    const list = spaceTemplates(readFileSync(path, "utf8"));
    expect(list.map((t) => t.id)).toEqual(["fleet", "marketing", "admin", "development", "plccode"]);
    expect(list.every((t) => t.bots.length > 0)).toBe(true);
  });
});
