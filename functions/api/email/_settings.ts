// Server-side settings reader — tolerant by design: returns the fallback
// when the email_settings table is missing (migration not yet applied),
// the row is absent, or the query fails. Mail delivery must never depend
// on settings availability.

import { Env, supabaseQuery } from "./_shared";

export const SETTINGS_DEFAULTS = {
  junk: { llmAssist: true, threshold: 0.7 },
  privacy: { blockRemoteContent: false },
} as const;

export async function readSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  try {
    const res = await supabaseQuery(env, `/email_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return fallback;
    const value = (res.data[0] as { value?: unknown })?.value;
    if (!value || typeof value !== "object") return fallback;
    // Shallow-merge over the fallback so missing fields keep defaults
    return { ...fallback, ...(value as Partial<T>) };
  } catch {
    return fallback;
  }
}
