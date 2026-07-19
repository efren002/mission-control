"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import { applicationConfig } from "@/lib/config";

const STORAGE_KEY = "mission-control.admin-token";
const TOKEN_CHANGE_EVENT = "mission-control.admin-token-change";

let autoLoginAttempted = false;
type AdminTokenState = {
  token: string;
  updateToken: (value: string) => void;
};
const AdminTokenContext = createContext<AdminTokenState | null>(null);

async function fetchLocalSessionToken(): Promise<string> {
  try {
    const response = await fetch(`${applicationConfig.apiUrl}/auth/local-session`);
    if (!response.ok) return "";
    const data = (await response.json()) as { token?: string };
    return data.token ?? "";
  } catch {
    return "";
  }
}

function storeToken(value: string) {
  if (value) sessionStorage.setItem(STORAGE_KEY, value);
  else sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(TOKEN_CHANGE_EVENT, { detail: value }));
}

function useAdminTokenState() {
  const [token, setToken] = useState("");

  useEffect(() => {
    const syncToken = (event?: Event) => {
      if (event instanceof CustomEvent) {
        setToken(event.detail);
        return;
      }
      setToken(sessionStorage.getItem(STORAGE_KEY) ?? "");
    };

    syncToken();
    window.addEventListener(TOKEN_CHANGE_EVENT, syncToken);

    // Local single-user convenience: the API only serves this endpoint for
    // development on localhost, so a missing token is filled automatically.
    if (!autoLoginAttempted && !sessionStorage.getItem(STORAGE_KEY)) {
      autoLoginAttempted = true;
      void fetchLocalSessionToken().then((fetched) => {
        if (fetched && !sessionStorage.getItem(STORAGE_KEY)) storeToken(fetched);
      });
    }

    return () => window.removeEventListener(TOKEN_CHANGE_EVENT, syncToken);
  }, []);

  const updateToken = (value: string) => {
    setToken(value);
    storeToken(value);
  };

  return { token, updateToken };
}

export function AdminTokenProvider({ children }: { children: ReactNode }) {
  const value = useAdminTokenState();
  return (
    <AdminTokenContext.Provider value={value}>
      {children}
    </AdminTokenContext.Provider>
  );
}

export function useAdminToken() {
  const shared = useContext(AdminTokenContext);
  if (!shared) {
    throw new Error("useAdminToken must be used within AdminTokenProvider");
  }
  return shared;
}
