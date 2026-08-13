import { Injectable } from '@nestjs/common';

/// How many failures before a caller is locked out, and for how long.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

/// Failures older than this stop counting, so an occasional typo never adds up
/// to a lockout over days.
const WINDOW_MS = 15 * 60 * 1000;

type Entry = { failures: number[]; lockedUntil: number };

/**
 * Rate limit for the panel login.
 *
 * Held in memory: the panel is a single process, and a limiter that survives a
 * restart is not worth a table. If it is ever run behind more than one
 * instance this has to move to the database or a shared cache, since each
 * process would otherwise keep its own count.
 */
@Injectable()
export class LoginThrottle {
  private entries = new Map<string, Entry>();

  /// Seconds left on a lockout, or 0 when the caller may try again.
  lockedFor(key: string): number {
    const entry = this.entries.get(key);
    if (!entry || entry.lockedUntil <= Date.now()) return 0;
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }

  /// Records a failed attempt and locks the caller out once too many pile up.
  fail(key: string): void {
    const now = Date.now();
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < WINDOW_MS);
    entry.failures.push(now);
    if (entry.failures.length >= MAX_ATTEMPTS) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = [];
    }
    this.entries.set(key, entry);

    // A long-lived process should not accumulate an entry per attacker IP.
    if (this.entries.size > 5000) this.prune();
  }

  /// Clears the count after a successful sign-in.
  succeed(key: string): void {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      const stale =
        entry.lockedUntil < now &&
        entry.failures.every((t) => now - t > WINDOW_MS);
      if (stale) this.entries.delete(key);
    }
  }
}
