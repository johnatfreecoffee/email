"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";

// Routes that skip authentication entirely (public/read-only pages).
export const PUBLIC_ROUTES: string[] = [];

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
}

const AUTH_KEY = "mc-auth-token";
const USER_KEY = "mc-auth-user";

/** Build-time shared secret (same value as server MC_API_SECRET). */
const SHARED_SECRET =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MC_API_SECRET || "" : "";

export interface MCUser {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "user";
  allowed_modules: string[];
}

const STANDALONE_USER: MCUser = {
  id: "local",
  email: "admin@email.local",
  display_name: "Admin",
  role: "admin",
  allowed_modules: ["email"],
};

interface AuthContextType {
  token: string | null;
  user: MCUser | null;
  logout: () => void;
  isAdmin: boolean;
  hasModule: (moduleKey: string) => boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  user: null,
  logout: () => {},
  isAdmin: false,
  hasModule: () => false,
  refreshUser: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AUTH_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { "X-MC-Auth": token } : {};
}

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { ...authHeaders(), ...init?.headers };
  return fetch(url, { ...init, headers });
}

function persistSession(token: string) {
  localStorage.setItem(AUTH_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(STANDALONE_USER));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<MCUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // On mount: restore session, or auto-seed from NEXT_PUBLIC_MC_API_SECRET.
  useEffect(() => {
    const stored = localStorage.getItem(AUTH_KEY);
    const storedUser = localStorage.getItem(USER_KEY);

    if (stored) {
      // Prefer matching the current build-time secret if available
      if (SHARED_SECRET && stored !== SHARED_SECRET) {
        // Stale token from MC login / old secret — re-seed when we have one
        if (SHARED_SECRET) {
          persistSession(SHARED_SECRET);
          setToken(SHARED_SECRET);
          setUser(STANDALONE_USER);
        } else {
          try {
            setToken(stored);
            setUser(storedUser ? (JSON.parse(storedUser) as MCUser) : STANDALONE_USER);
          } catch {
            localStorage.removeItem(AUTH_KEY);
            localStorage.removeItem(USER_KEY);
          }
        }
      } else {
        try {
          setToken(stored);
          setUser(storedUser ? (JSON.parse(storedUser) as MCUser) : STANDALONE_USER);
        } catch {
          localStorage.removeItem(AUTH_KEY);
          localStorage.removeItem(USER_KEY);
        }
      }
    } else if (SHARED_SECRET) {
      // No stored token — auto-auth with the shared secret (single-tenant gate)
      persistSession(SHARED_SECRET);
      setToken(SHARED_SECRET);
      setUser(STANDALONE_USER);
    }

    setChecked(true);
  }, []);

  const refreshUser = useCallback(async () => {
    // No /api/auth/me in the fork — user is local-only.
  }, []);

  const handleLogin = async () => {
    setLoading(true);
    setError("");
    try {
      const entered = password.trim();
      if (!entered) {
        setError("Enter the access secret");
        return;
      }
      // Accept either the build-time public secret or whatever the user types
      // (server validates against MC_API_SECRET / sessions / legacy).
      if (SHARED_SECRET && entered !== SHARED_SECRET) {
        setError("Invalid access secret");
        return;
      }
      const tok = SHARED_SECRET || entered;
      persistSession(tok);
      setToken(tok);
      setUser(STANDALONE_USER);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  };

  const isAdmin = user?.role === "admin";

  const hasModule = useCallback(
    (moduleKey: string) => {
      if (!user) return false;
      if (user.role === "admin") return true;
      return user.allowed_modules.includes(moduleKey);
    },
    [user]
  );

  if (!checked) return null;

  const onPublicRoute = isPublicRoute(pathname);
  if (onPublicRoute) {
    return (
      <AuthContext.Provider
        value={{
          token: null,
          user: null,
          logout: () => {},
          isAdmin: false,
          hasModule: () => true,
          refreshUser: async () => {},
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  if (!token || !user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-full max-w-[360px] mx-4">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-[#06B6D4] to-[#34D399] mb-4">
              <svg
                className="w-8 h-8 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <h1 className="text-[22px] font-bold text-foreground mb-1">Email</h1>
            <p className="text-[13px] text-muted-foreground">
              Enter the access secret to continue
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
            className="space-y-3"
          >
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              placeholder="Access secret"
              autoFocus
              autoComplete="current-password"
              className="w-full px-4 py-3 bg-muted/40 border border-border rounded-xl text-[14px] text-white placeholder-[#6B7280] focus:outline-none focus:border-[#06B6D4] transition-colors"
            />
            {error && <p className="text-[12px] text-[#F87171]">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-[#06B6D4] to-[#0891B2] text-white text-[14px] font-medium hover:brightness-110 transition-all disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ token, user, logout, isAdmin, hasModule, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}
