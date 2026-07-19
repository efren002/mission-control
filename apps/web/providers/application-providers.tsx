"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { AdminTokenProvider } from "@/features/auth/use-admin-token";

interface ApplicationProvidersProps {
  children: ReactNode;
}

export function ApplicationProviders({ children }: ApplicationProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AdminTokenProvider>{children}</AdminTokenProvider>
    </QueryClientProvider>
  );
}
