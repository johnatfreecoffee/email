// Push notification helpers + a shared subscription store.
//
// The store is module-level so EVERY surface (footer bell, Settings toggle,
// the enable banner) reads and writes the same state — enabling from one
// place lights up all of them instantly.
//
// The VAPID public key is fetched from the server (GET /api/email/push) so
// the client always subscribes against the key the server signs with —
// a baked build-time key can drift from the runtime key and produce
// subscriptions that 403 forever. If an existing browser subscription was
// created under a different key, it is unsubscribed and recreated.
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "./auth";
import { toast } from "./toast";

// Build-time fallback only (used if the server key fetch fails)
const VAPID_PUBLIC_KEY_FALLBACK = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getPushPermission(): Promise<NotificationPermission> {
  if (!isPushSupported()) return "denied";
  return Notification.permission;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return reg;
  } catch (e) {
    console.error("SW registration failed:", e);
    return null;
  }
}

/** The key the SERVER actually signs with — source of truth. */
async function fetchServerVapidKey(): Promise<string> {
  try {
    const res = await apiFetch("/api/email/push");
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.vapidPublicKey === "string" && data.vapidPublicKey) {
        return data.vapidPublicKey;
      }
    }
  } catch {}
  return VAPID_PUBLIC_KEY_FALLBACK;
}

function keysEqual(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const av = new Uint8Array(a);
  if (av.length !== b.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== b[i]) return false;
  return true;
}

export async function subscribeToPush(): Promise<PushSubscription | null> {
  try {
    const reg = await registerServiceWorker();
    if (!reg) return null;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const serverKey = await fetchServerVapidKey();
    if (!serverKey) return null;
    const appServerKey = urlBase64ToUint8Array(serverKey);

    // A subscription bound to an OLD key can't be reused — sends 403 forever
    // and re-subscribing with a new key throws. Drop it and start clean.
    const existing = await reg.pushManager.getSubscription();
    if (existing && !keysEqual(existing.options?.applicationServerKey, appServerKey)) {
      try {
        await apiFetch("/api/email/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
      } catch {}
      await existing.unsubscribe().catch(() => {});
    }

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey as BufferSource,
    });

    const label = `${navigator.userAgent.includes("Mobile") ? "Mobile" : "Desktop"} ${
      navigator.userAgent.includes("Chrome") ? "Chrome" :
      navigator.userAgent.includes("Safari") ? "Safari" :
      navigator.userAgent.includes("Firefox") ? "Firefox" : "Browser"
    }`;

    await apiFetch("/api/email/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        label,
      }),
    });

    return subscription;
  } catch (e) {
    console.error("Push subscription failed:", e);
    return null;
  }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;

    await apiFetch("/api/email/push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });

    await subscription.unsubscribe();
    return true;
  } catch (e) {
    console.error("Unsubscribe failed:", e);
    return false;
  }
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// ---------- Shared push store ----------

interface PushState {
  supported: boolean;
  enabled: boolean;
  loading: boolean;
}

let pushState: PushState = { supported: false, enabled: false, loading: false };
const pushListeners = new Set<(s: PushState) => void>();
let pushInitStarted = false;

function setPushState(patch: Partial<PushState>) {
  pushState = { ...pushState, ...patch };
  for (const l of pushListeners) l(pushState);
}

async function initPushState() {
  if (pushInitStarted || typeof window === "undefined") return;
  pushInitStarted = true;
  const supported = isPushSupported();
  setPushState({ supported });
  if (!supported) return;
  await registerServiceWorker();
  const sub = await getCurrentSubscription();
  setPushState({ enabled: !!sub });
}

/** Toggle push on/off with user feedback. All consumers stay in sync. */
export async function togglePush(): Promise<void> {
  if (pushState.loading) return;
  setPushState({ loading: true });
  if (pushState.enabled) {
    const ok = await unsubscribeFromPush();
    if (ok) {
      setPushState({ enabled: false, loading: false });
      toast("Notifications disabled");
    } else {
      setPushState({ loading: false });
      toast("Could not disable notifications");
    }
  } else {
    const sub = await subscribeToPush();
    setPushState({ enabled: !!sub, loading: false });
    toast(sub ? "Notifications enabled" : "Could not enable notifications — check browser permission");
  }
}

/** Shared push-subscription state so every control stays in lockstep. */
export function usePush() {
  const [state, setState] = useState<PushState>(pushState);

  useEffect(() => {
    const listener = (s: PushState) => setState(s);
    pushListeners.add(listener);
    setState(pushState);
    initPushState();
    return () => {
      pushListeners.delete(listener);
    };
  }, []);

  const toggle = useCallback(() => togglePush(), []);

  return { supported: state.supported, enabled: state.enabled, loading: state.loading, toggle };
}
