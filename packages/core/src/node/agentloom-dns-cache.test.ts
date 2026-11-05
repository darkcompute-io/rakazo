import { describe, expect, it, vi } from "vitest";
import { createNameCache } from "./agentloom-dns-cache.js";

const answer = [{ address: "10.0.0.1", family: 4 }];

describe("name cache", () => {
  it("asks once a minute, and once for lookups in flight together", async () => {
    let now = 0;
    const resolve = vi.fn(async () => answer);
    const cached = createNameCache(resolve, () => now);
    await Promise.all([cached("a.example", 0), cached("A.example", 0)]);
    await cached("a.example", 0);
    expect(resolve).toHaveBeenCalledTimes(1);
    now = 61_000;
    await cached("a.example", 0);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer through a resolver blip, then lets the failure through", async () => {
    let now = 0;
    const blip = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    const resolve = vi
      .fn<() => Promise<typeof answer>>()
      .mockResolvedValueOnce(answer)
      .mockRejectedValue(blip);
    const cached = createNameCache(resolve, () => now);
    await cached("a.example", 0);
    now = 120_000;
    await expect(cached("a.example", 0)).resolves.toEqual(answer);
    now = 700_000;
    await expect(cached("a.example", 0)).rejects.toThrow("EAI_AGAIN");
  });

  it("never caches an address literal or a first failure", async () => {
    const resolve = vi.fn(async () => answer);
    const cached = createNameCache(resolve);
    await cached("10.0.0.9", 0);
    await cached("10.0.0.9", 0);
    expect(resolve).toHaveBeenCalledTimes(2);
    const failing = createNameCache(async () => {
      throw new Error("nope");
    });
    await expect(failing("b.example", 0)).rejects.toThrow("nope");
  });
});
