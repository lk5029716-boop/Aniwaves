import NodeCache from "node-cache";

const cache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

export function cacheGet<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function cacheSet<T>(key: string, value: T, ttl = 1800): void {
  cache.set(key, value, ttl);
}

export function cacheDel(key: string): void {
  cache.del(key);
}
