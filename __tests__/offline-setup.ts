import { afterEach, beforeEach, vi } from "vitest";

// [tag:offline_no_network] Runtime tests may opt into explicit fake responses,
// but a forgotten fetch mock must never send a live request from offline gates.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error(
        "Network disabled in offline test suite; supply a fetch fake or use test-live",
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
