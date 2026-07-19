import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogApi } from "./api";

const project = {
  id: "project-1",
  name: "Project",
  status: "active",
  memory: "",
  test_command: null,
  app_command: null,
};

describe("catalog API request reuse", () => {
  afterEach(() => vi.mocked(fetch).mockReset());

  it("deduplicates and briefly reuses stable collection requests", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([project]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const token = "cache-test-token";
    const [first, second] = await Promise.all([
      catalogApi.projects(token),
      catalogApi.projects(token),
    ]);
    const third = await catalogApi.projects(token);

    expect(first).toEqual([project]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalidates reusable responses after a mutation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([project]))
      .mockResolvedValueOnce(Response.json(project))
      .mockResolvedValueOnce(Response.json([project]));

    const token = "invalidation-test-token";
    await catalogApi.projects(token);
    await catalogApi.createProject(token, "Project");
    await catalogApi.projects(token);

    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
