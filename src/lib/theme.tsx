"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

export type ThemePref = "system" | "light" | "dark";
type Resolved = "light" | "dark";

interface ThemeContextType {
  /** The user's choice: follow the OS, or force light/dark. */
  pref: ThemePref;
  /** What is actually applied right now. */
  resolved: Resolved;
  setPref: (p: ThemePref) => void;
}

const STORAGE_KEY = "mc-theme";

const ThemeContext = createContext<ThemeContextType>({
  pref: "system",
  resolved: "light",
  setPref: () => {},
});

function systemResolved(): Resolved {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadPref(): ThemePref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Legacy values ("light"/"dark") parse as explicit prefs; anything else → system
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {}
  return "system";
}

function apply(resolved: Resolved) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.setAttribute("data-theme", resolved);
  // Keep the browser chrome in step (PWA/standalone)
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = resolved === "dark" ? "#1E1E1E" : "#F3F3F7";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize from what the no-flash inline script already applied, so
  // hydration doesn't flicker the opposite theme.
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [resolved, setResolved] = useState<Resolved>("light");

  useEffect(() => {
    const p = loadPref();
    setPrefState(p);
    setResolved(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  // Apply + persist on pref change; track the OS while pref is "system"
  useEffect(() => {
    const next = pref === "system" ? systemResolved() : pref;
    setResolved(next);
    apply(next);
    try { localStorage.setItem(STORAGE_KEY, pref); } catch {}

    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      const r: Resolved = e.matches ? "dark" : "light";
      setResolved(r);
      apply(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => setPrefState(p), []);

  return (
    <ThemeContext.Provider value={{ pref, resolved, setPref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
