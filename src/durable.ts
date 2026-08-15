/**
 * Remove optional object fields whose runtime value is `undefined` before a
 * message crosses Pi's strict JSON session boundary. Arrays stay positional:
 * an undefined element is rejected instead of silently becoming `null`.
 */
export function omitUndefinedObjectFields<T>(value: T): T {
  const active = new WeakSet<object>();

  const visit = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (active.has(candidate)) throw new TypeError("durable message contains a cycle");
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item) => {
          if (item === undefined) {
            throw new TypeError("durable message contains an undefined array element");
          }
          return visit(item);
        });
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return candidate;

      const normalized: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate)) {
        if (item !== undefined) normalized[key] = visit(item);
      }
      return normalized;
    } finally {
      active.delete(candidate);
    }
  };

  return visit(value) as T;
}
