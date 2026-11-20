"use client";

/**
 * Deterministic Apple-palette sender monogram avatar.
 * Pure Apple system hues only (blue, teal, green, amber, coral, slate) — no purple.
 */

const PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: "rgba(0, 122, 255, 0.14)", fg: "#007AFF" },   // Apple Blue
  { bg: "rgba(50, 173, 230, 0.16)", fg: "#0E8AC7" },  // Apple Cyan/Teal
  { bg: "rgba(40, 205, 65, 0.14)", fg: "#1F9D38" },   // Apple Green
  { bg: "rgba(255, 149, 0, 0.15)", fg: "#D97706" },   // Apple Orange
  { bg: "rgba(255, 59, 48, 0.13)", fg: "#E03127" },   // Apple Coral/Red
  { bg: "rgba(100, 116, 139, 0.15)", fg: "#475569" }, // Neutral Slate
];

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function initialsOf(name?: string | null, email?: string | null): string {
  const cleanName = (name || "").replace(/["'<>()]/g, "").trim();
  if (cleanName && !cleanName.includes("@")) {
    const parts = cleanName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    if (parts[0]?.length >= 2) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    if (parts[0]?.[0]) return parts[0][0].toUpperCase();
  }
  const cleanEmail = (email || "").trim();
  const local = cleanEmail.split("@")[0] || cleanEmail;
  return (local[0] || "?").toUpperCase();
}

export function SenderAvatar({
  name,
  email,
  size = "md",
  inverted = false,
}: {
  name?: string | null;
  email?: string | null;
  size?: "sm" | "md" | "lg";
  inverted?: boolean;
}) {
  const seed = (email || name || "?").toLowerCase().trim();
  const tone = PALETTE[hashSeed(seed) % PALETTE.length];
  const text = initialsOf(name, email);

  const dims =
    size === "sm"
      ? "h-7 w-7 text-[11px]"
      : size === "lg"
        ? "h-10 w-10 text-[14px]"
        : "h-8 w-8 text-[12px]";

  return (
    <div
      className={`${dims} rounded-full flex items-center justify-center font-semibold tracking-tight flex-shrink-0 select-none`}
      style={
        inverted
          ? {
              backgroundColor: "rgba(255, 255, 255, 0.22)",
              color: "#FFFFFF",
            }
          : {
              backgroundColor: tone.bg,
              color: tone.fg,
            }
      }
      aria-hidden
    >
      {text}
    </div>
  );
}
