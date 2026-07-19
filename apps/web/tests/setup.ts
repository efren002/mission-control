import "@testing-library/jest-dom/vitest";

import { vi } from "vitest";

// Tests never reach the real API; unanswered requests resolve as 404 so
// hooks with network side effects (for example admin auto-login) stay inert.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response(null, { status: 404 })),
);
