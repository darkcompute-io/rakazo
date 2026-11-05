// AgentLoom: a short name cache for the API and worker. Each run connects to every app a bot
// has, every connection looks its name up, and nothing in between remembers: the guest peaked
// at 2,673 queries a minute against a resolver that drops one address past 600 a minute, which
// surfaced as apps vanishing from a run and checkers timing out. A name that fails to resolve
// keeps its last answer for a while, so a resolver blip does not take every app with it.
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";

export type LookupAddress = { address: string; family: number };
type Resolve = (hostname: string, family: number) => Promise<LookupAddress[]>;

const FRESH_MS = 60_000;
const STALE_MS = 10 * 60_000;

export function createNameCache(resolve: Resolve, now: () => number = Date.now): Resolve {
  const answers = new Map<string, { at: number; list: LookupAddress[] }>();
  const pending = new Map<string, Promise<LookupAddress[]>>();
  return (hostname, family) => {
    if (isIP(hostname)) return resolve(hostname, family);
    const key = `${family}:${hostname.toLowerCase()}`;
    const known = answers.get(key);
    if (known && now() - known.at < FRESH_MS) return Promise.resolve(known.list);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const lookup = resolve(hostname, family)
      .then((list) => {
        answers.set(key, { at: now(), list });
        return list;
      })
      .catch((error: unknown) => {
        if (known && now() - known.at < STALE_MS) return known.list;
        throw error;
      })
      .finally(() => pending.delete(key));
    pending.set(key, lookup);
    return lookup;
  };
}

type Options = { family?: number | string; all?: boolean } | number | undefined;
const familyOf = (options: Options): number => {
  const raw = typeof options === "number" ? options : options?.family;
  return raw === 4 || raw === "IPv4" ? 4 : raw === 6 || raw === "IPv6" ? 6 : 0;
};
const wantsAll = (options: Options) => typeof options === "object" && options?.all === true;

/** Every dns.lookup in this process, callback or promise, goes through one cache. */
export function installNameCache(): void {
  const original = dns.promises.lookup.bind(dns.promises);
  const cached = createNameCache((hostname, family) =>
    original(hostname, { all: true, verbatim: true, family }),
  );
  dns.promises.lookup = (async (hostname: string, options?: Options) => {
    const list = await cached(hostname, familyOf(options));
    return wantsAll(options) ? list : list[0];
  }) as typeof dns.promises.lookup;
  dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (
      error: Error | null,
      address?: string | LookupAddress[],
      family?: number,
    ) => void;
    const opts = (typeof options === "function" ? undefined : options) as Options;
    cached(hostname, familyOf(opts)).then(
      (list) => {
        if (wantsAll(opts)) done(null, list);
        else done(null, list[0]?.address, list[0]?.family);
      },
      (error: Error) => done(error),
    );
  }) as typeof dns.lookup;
  syncBuiltinESMExports();
}
