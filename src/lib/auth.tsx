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

/** Single-tenant login (UI gate; API still uses MC_API_SECRET). Set in env — never commit values. */
const LOGIN_EMAIL = (
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_OWNER_EMAIL : "") || ""
).toLowerCase().trim();
const LOGIN_PASSWORD = (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_OWNER_PASSWORD : "") || "";

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
  display_name: "Owner",
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

function getStoredUserId(): string {
  if (typeof window === "undefined") return "local";
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MCUser;
      if (typeof parsed.id === "string" && parsed.id.trim()) return parsed.id.trim();
    }
  } catch {
    /* ignore */
  }
  return "local";
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { "X-MC-User-Id": getStoredUserId() };
  if (token) headers["X-MC-Auth"] = token;
  return headers;
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

      if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
        setError("App is misconfigured (missing owner login env)");
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
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{
          backgroundColor: "var(--mc-canvas-bg)",
          backgroundImage:
            "radial-gradient(ellipse 65% 45% at 50% 0%, rgba(0, 122, 255, 0.08), transparent 70%)",
        }}
      >
        <div className="mc-window-sheet w-full max-w-[376px] p-7">
          <div className="text-center mb-6">
            {/* Matches the PWA app icon: white envelope on black */}
            <div
              className="inline-flex items-center justify-center w-14 h-14 rounded-[16px] mb-3.5 shadow-sm"
              style={{ backgroundColor: "#000000", border: "1px solid var(--mc-border)" }}
            >
              <svg
                className="w-7 h-7 text-white"
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
            <h1 className="text-[20px] font-semibold tracking-[-0.02em] mb-1" style={{ color: "var(--mc-text)" }}>
              Mail
            </h1>
            <p className="text-[13px]" style={{ color: "var(--mc-text-muted)" }}>
              Sign in to your cloud workspace
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
            className="space-y-2.5"
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
              className="w-full px-3.5 py-2.5 rounded-[10px] text-[14px] focus:outline-none transition-all"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border)",
                color: "var(--mc-text)",
              }}
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
              className="w-full px-3.5 py-2.5 rounded-[10px] text-[14px] focus:outline-none transition-all"
              style={{
                backgroundColor: "var(--mc-bg-tertiary)",
                border: "1px solid var(--mc-border)",
                color: "var(--mc-text)",
              }}
            />
            {error && (
              <p className="text-[12px] pt-0.5" style={{ color: "var(--mc-red)" }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 mt-1 rounded-[10px] text-white text-[14px] font-medium hover:brightness-110 active:scale-[0.99] transition-all disabled:opacity-50"
              style={{ backgroundColor: "var(--mc-accent)" }}
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
