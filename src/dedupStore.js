// Bounded in-memory TTL set for Linear-Delivery ids. Good enough for a local
// proof; not durable across restarts by design (v1A has no persistence).

export class DedupStore {
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.seenAt = new Map(); // deliveryId -> expiry timestamp (ms)
  }

  #evictExpired(now) {
    for (const [id, expiresAt] of this.seenAt) {
      if (expiresAt <= now) this.seenAt.delete(id);
    }
  }

  // Returns true if this is a duplicate (already seen and not expired).
  // As a side effect, records the id as seen so subsequent calls dedupe.
  checkAndRecord(deliveryId, now = Date.now()) {
    this.#evictExpired(now);

    if (this.seenAt.has(deliveryId)) return true;

    if (this.seenAt.size >= this.maxEntries) {
      const oldestKey = this.seenAt.keys().next().value;
      if (oldestKey !== undefined) this.seenAt.delete(oldestKey);
    }

    this.seenAt.set(deliveryId, now + this.ttlMs);
    return false;
  }
}
