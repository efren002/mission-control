"use client";

import { useQuery } from "@tanstack/react-query";

import { getSystemHealth } from "./api";

export function useSystemHealth() {
  return useQuery({
    queryKey: ["system", "health"],
    queryFn: ({ signal }) => getSystemHealth(signal),
    refetchInterval: 15_000,
  });
}
