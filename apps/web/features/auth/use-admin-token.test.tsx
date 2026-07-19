import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AdminTokenProvider,
  useAdminToken,
} from "@/features/auth/use-admin-token";

describe("useAdminToken", () => {
  beforeEach(() => sessionStorage.clear());

  it("synchronizes token changes between mounted consumers", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AdminTokenProvider>{children}</AdminTokenProvider>
    );
    const first = renderHook(() => useAdminToken(), { wrapper });
    const second = renderHook(() => useAdminToken(), { wrapper });

    act(() => first.result.current.updateToken("local-token"));

    expect(first.result.current.token).toBe("local-token");
    expect(second.result.current.token).toBe("local-token");
    expect(sessionStorage.getItem("mission-control.admin-token")).toBe("local-token");
  });
});
