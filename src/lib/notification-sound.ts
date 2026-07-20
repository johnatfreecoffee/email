// In-app "new mail" alert tones, synthesized with the Web Audio API so there
// are no binary assets to ship and nothing for the Artifact/CSP layer to
// block. Playing any tone also unlocks the shared AudioContext, so the very
// first poll-driven ding after a page load works (the login click already
// counts as the unlocking gesture in practice, and the Settings "Play"
// button guarantees it).

export type NotificationSoundName = "chime" | "ding" | "tri-tone" | "pop";

export const NOTIFICATION_SOUNDS: Array<{ value: NotificationSoundName; label: string }> = [
  { value: "chime", label: "Chime" },
  { value: "ding", label: "Ding" },
  { value: "tri-tone", label: "Tri-tone" },
  { value: "pop", label: "Pop" },
];

export function isValidNotificationSound(v: unknown): v is NotificationSoundName {
  return typeof v === "string" && NOTIFICATION_SOUNDS.some((s) => s.value === v);
}

// One note in a tone: frequency, when it starts (s from now), how long it
// rings, its peak gain, and the oscillator shape.
interface Note {
  freq: number;
  delay: number;
  dur: number;
  peak: number;
  type: OscillatorType;
}

const TONES: Record<NotificationSoundName, Note[]> = {
  // Soft rising two-tone (A5 → D6) — the default.
  chime: [
    { freq: 880.0, delay: 0.0, dur: 0.16, peak: 0.16, type: "sine" },
    { freq: 1174.7, delay: 0.09, dur: 0.28, peak: 0.16, type: "sine" },
  ],
  // Single bell-ish note with a bright harmonic.
  ding: [
    { freq: 987.8, delay: 0.0, dur: 0.42, peak: 0.18, type: "sine" },
    { freq: 1975.5, delay: 0.0, dur: 0.22, peak: 0.05, type: "sine" },
  ],
  // Three quick ascending notes (C6 · E6 · G6).
  "tri-tone": [
    { freq: 1046.5, delay: 0.0, dur: 0.14, peak: 0.14, type: "triangle" },
    { freq: 1318.5, delay: 0.11, dur: 0.14, peak: 0.14, type: "triangle" },
    { freq: 1568.0, delay: 0.22, dur: 0.24, peak: 0.14, type: "triangle" },
  ],
  // Short, dry blip.
  pop: [{ freq: 660.0, delay: 0.0, dur: 0.09, peak: 0.2, type: "triangle" }],
};

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    // Autoplay policy can leave the context suspended until a gesture; a
    // resume() attempt is safe to call repeatedly.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Play a notification tone. No-ops silently if audio is unavailable. */
export function playNotificationSound(name: NotificationSoundName = "chime"): void {
  const audio = getContext();
  if (!audio) return;
  const notes = TONES[name] || TONES.chime;
  const now = audio.currentTime;
  for (const n of notes) {
    try {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      const start = now + n.delay;
      const end = start + n.dur;
      // Fast attack, exponential decay — reads as a soft mallet/bell.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(n.peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    } catch {
      // ignore a single failed note
    }
  }
}
