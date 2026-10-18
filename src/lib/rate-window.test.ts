import { describe, expect, it } from "vitest";
import { hit } from "./rate-window";

describe("hit", () => {
  it("allows up to the limit in a window, then blocks until it resets", () => {
    const key = `test:${Math.random()}`;
    const t = 1_000_000;
    expect(hit(key, 2, 60_000, t).ok).toBe(true);
    expect(hit(key, 2, 60_000, t + 1).ok).toBe(true);
    const blocked = hit(key, 2, 60_000, t + 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBe(60);
    expect(hit(key, 2, 60_000, t + 60_000).ok).toBe(true);
  });

  it("counts each key on its own", () => {
    const t = 2_000_000;
    expect(hit(`a:${t}`, 1, 60_000, t).ok).toBe(true);
    expect(hit(`b:${t}`, 1, 60_000, t).ok).toBe(true);
    expect(hit(`a:${t}`, 1, 60_000, t).ok).toBe(false);
  });
});
