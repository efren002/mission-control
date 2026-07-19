import { applicationConfig } from "@/lib/config";

import type { HealthResponse } from "./types";

export async function getSystemHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const response = await fetch(`${applicationConfig.apiUrl}/health`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}`);
  }

  return (await response.json()) as HealthResponse;
}
