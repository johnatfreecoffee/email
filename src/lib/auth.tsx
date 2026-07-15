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
/** Bump to invalidate older auto-login sessions and force the password form. */
const AUTH_SESSION_VERSION = "v2-password";
const AUTH_VERSION_KEY = "mc-auth-version";

/** Build-time shared secret sent as X-MC-Auth after a successful login. */
const SHARED_SECRET =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MC_API_SECRET || "" : "";

/** Single-tenant login credentials (UI gate; API still uses MC_API_SECRET). */
const LOGIN_EMAIL = "john@freecoffee.dev";
const LOGIN_PASSWORD = "[redacted]";

export interface MCUser {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "user";
  allowed_modules: string[];
}

const STANDALONE_USER: MCUser = {
  id: "local",
  email: LOGIN_EMAIL,
  display_name: "John",
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

function persistSession(token: string, user: MCUser = STANDALONE_USER) {
  localStorage.setItem(AUTH_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<MCUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Restore prior session only — no auto-login.
  useEffect(() => {
    // Wipe sessions created before password login shipped (auto-seeded secret).
    if (localStorage.getItem(AUTH_VERSION_KEY) !== AUTH_SESSION_VERSION) {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.setItem(AUTH_VERSION_KEY, AUTH_SESSION_VERSION);
    }

    const stored = localStorage.getItem(AUTH_KEY);
    const storedUser = localStorage.getItem(USER_KEY);

    if (stored) {
      // Drop sessions that don't match the current API secret (rotated key).
      if (SHARED_SECRET && stored !== SHARED_SECRET) {
        localStorage.removeItem(AUTH_KEY);
        localStorage.removeItem(USER_KEY);
      } else {
        try {
          setToken(stored);
          setUser(storedUser ? (JSON.parse(storedUser) as MCUser) : STANDALONE_USER);
        } catch {
          localStorage.removeItem(AUTH_KEY);
          localStorage.removeItem(USER_KEY);
        }
      }
    }

    setChecked(true);
  }, []);

  const refreshUser = useCallback(async () => {
    // Local-only user — nothing to refresh.
  }, []);

  const handleLogin = async () => {
    setLoading(true);
    setError("");
    try {
      const enteredEmail = email.toLowerCase().trim();
      const enteredPassword = password;

      if (!enteredEmail || !enteredPassword) {
        setError("Enter email and password");
        return;
      }

      if (enteredEmail !== LOGIN_EMAIL || enteredPassword !== LOGIN_PASSWORD) {
        setError("Invalid email or password");
        return;
      }

      if (!SHARED_SECRET) {
        setError("App is misconfigured (missing API secret)");
        return;
      }

      persistSession(SHARED_SECRET, STANDALONE_USER);
      setToken(SHARED_SECRET);
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
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h1 className="text-[22px] font-bold text-foreground mb-1">Email</h1>
            <p className="text-[13px] text-muted-foreground">Sign in to continue</p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
            className="space-y-3"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError("");
              }}
              placeholder="Email"
              autoFocus
              autoComplete="email"
              className="w-full px-4 py-3 bg-muted/40 border border-border rounded-xl text-[14px] text-white placeholder-[#6B7280] focus:outline-none focus:border-[#06B6D4] transition-colors"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              placeholder="Password"
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
