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
import { pushInitAction, type Permission } from "./push-policy";

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

/** Cached so turning notifications on doesn't wait on the network before subscribe. */
let cachedServerKey = "";

/** The key the SERVER actually signs with — source of truth. */
async function fetchServerVapidKey(): Promise<string> {
  try {
    const res = await apiFetch("/api/email/push");
    if (res.ok) {
      const data = await res.json();
      if (typeof data?.vapidPublicKey === "string" && data.vapidPublicKey) {
        cachedServerKey = data.vapidPublicKey;
        return cachedServerKey;
      }
    }
  } catch {}
  return cachedServerKey || VAPID_PUBLIC_KEY_FALLBACK;
}

function keysEqual(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const av = new Uint8Array(a);
  if (av.length !== b.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== b[i]) return false;
  return true;
}

const OPT_OUT_KEY = "mc-push-opted-out";
export const BANNER_DISMISSED_KEY = "mc-push-banner-dismissed";

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  return `${ua.includes("Mobile") ? "Mobile" : "Desktop"} ${
    ua.includes("Chrome") ? "Chrome" :
    ua.includes("Safari") ? "Safari" :
    ua.includes("Firefox") ? "Firefox" : "Browser"
  }`;
}

/** Upsert (by endpoint) on the server — safe to call on every open. */
async function saveSubscription(subscription: PushSubscription): Promise<void> {
  await apiFetch("/api/email/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), label: deviceLabel() }),
  });
}

/**
 * Create (or recreate) the push subscription. `prompt=false` never shows a
 * permission dialog — used for the silent re-subscribe when permission is
 * already granted.
 *
 * When prompting, ask BEFORE any other await. Safari and Chrome drop the
 * Allow dialog if service-worker registration is awaited first.
 */
export async function subscribeToPush(opts: { prompt?: boolean } = {}): Promise<PushSubscription | null> {
  const prompt = opts.prompt !== false;
  try {
    if (!isPushSupported()) return null;

    let permission = Notification.permission;
    if (permission !== "granted" && prompt) permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const reg = await registerServiceWorker();
    if (!reg) return null;

    const serverKey = await fetchServerVapidKey();
    if (!serverKey) return null;
    const appServerKey = urlBase64ToUint8Array(serverKey);

    // A subscription bound to an OLD key can't be reused — sends 403 forever
    // and re-subscribing with a new key throws. Drop it and start clean.
    const existing = await reg.pushManager.getSubscription();
    const rawKey = existing?.options?.applicationServerKey;
    // Missing key (Safari) is not a mismatch. Rotating it drops a live Mac subscription.
    if (existing && (!rawKey || keysEqual(rawKey, appServerKey))) {
      await saveSubscription(existing);
      return existing;
    }
    if (existing) {
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
    await saveSubscription(subscription);
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
  /** Permission + subscription check finished (no banner flash before). */
  ready: boolean;
  permission: Permission;
}

let pushState: PushState = { supported: false, enabled: false, loading: false, ready: false, permission: "default" };
const pushListeners = new Set<(s: PushState) => void>();
let pushInitStarted = false;

function setPushState(patch: Partial<PushState>) {
  pushState = { ...pushState, ...patch };
  for (const l of pushListeners) l(pushState);
}

function currentPermission(): Permission {
  try { return Notification.permission as Permission; } catch { return "default"; }
}

async function initPushState() {
  if (pushInitStarted || typeof window === "undefined") return;
  pushInitStarted = true;
  const supported = isPushSupported();
  if (!supported) {
    setPushState({ supported, ready: true, permission: "denied" });
    return;
  }
  const permission = currentPermission();
  setPushState({ supported, permission });
  try {
    const reg = await registerServiceWorker();
    const existing = reg ? await reg.pushManager.getSubscription() : null;
    let keyMatches: boolean | null = true;
    if (existing && permission === "granted") {
      const serverKey = await fetchServerVapidKey();
      if (serverKey) {
        const raw = existing.options?.applicationServerKey;
        // Safari often leaves this null. Treat that as "keep the subscription".
        keyMatches = raw ? keysEqual(raw, urlBase64ToUint8Array(serverKey)) : null;
      }
    }
    const action = pushInitAction({
      supported,
      permission,
      hasSubscription: !!existing,
      keyMatches,
      optedOut: readLocal(OPT_OUT_KEY) === "1",
    });
    if (action === "sync" && existing) {
      // Already on: make sure the server still has this device (it prunes
      // dead endpoints) — no prompt, no toast.
      void saveSubscription(existing).catch(() => {});
      setPushState({ enabled: true, ready: true });
      return;
    }
    if (action === "resubscribe") {
      // Granted but the browser dropped / rotated the subscription (iOS PWA
      // does this). Recreate it silently instead of nagging.
      const sub = await subscribeToPush({ prompt: false });
      setPushState({ enabled: !!sub, ready: true, permission: currentPermission() });
      return;
    }
    setPushState({ enabled: !!existing && permission === "granted", ready: true });
  } catch {
    setPushState({ ready: true });
  }
}

/**
 * Show a banner in this click, before any await.
 * On an installed Mac PWA, Chrome already has site permission, but macOS
 * still has to allow the Email app. That system prompt only appears if a
 * document notification is created during the click. A service-worker push
 * does not ask, and macOS then drops the banner.
 */
export function showMacNotificationNow(title: string, body: string, tag: string): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const n = new Notification(title, { body, tag, icon: "/icon-192.png" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** Send Test. Call straight from the click so the Mac prompt can appear. */
export async function sendTestPush(): Promise<string> {
  const now = typeof Notification === "undefined" ? "denied" : Notification.permission;
  if (now === "granted") {
    showMacNotificationNow("Email", "Test notification", `email-test-${Date.now()}`);
  }
  let permission = now as Permission;
  if (permission === "default") {
    try {
      permission = (await Notification.requestPermission()) as Permission;
    } catch {
      permission = currentPermission();
    }
    if (permission === "granted") {
      showMacNotificationNow("Email", "Test notification", `email-test-${Date.now()}`);
    }
  }
  if (permission === "denied") {
    return "Blocked. System Settings → Notifications → Email → Allow.";
  }
  if (permission !== "granted") {
    return "Allow the prompt to turn notifications on.";
  }
  try {
    const push = await apiFetch("/api/email/push-test", { method: "POST" });
    const data = await push.json().catch(() => ({}));
    if (!data.success) {
      return "Asked this Mac to show a banner. No device is registered for background push yet.";
    }
    return "Asked this Mac to show a banner. Allow Email if macOS asks.";
  } catch (e) {
    return `Asked this Mac to show a banner. Background push failed: ${(e as Error).message}`;
  }
}

/**
 * Toggle push on/off.
 * Turning on creates a notification in the click. That is what makes macOS
 * show the Allow dialog for the installed Email app. Chrome's site
 * permission is often already granted, so requestPermission() alone is silent.
 */
export async function togglePush(): Promise<void> {
  if (pushState.loading) return;

  if (pushState.enabled) {
    setPushState({ loading: true });
    const ok = await unsubscribeFromPush();
    if (ok) {
      writeLocal(OPT_OUT_KEY, "1");
      setPushState({ enabled: false, loading: false, permission: currentPermission() });
      toast("Notifications disabled");
    } else {
      setPushState({ loading: false });
      toast("Could not disable notifications");
    }
    return;
  }

  if (!isPushSupported()) {
    toast("Notifications are not supported in this browser");
    return;
  }

  // Site permission is often already granted, so requestPermission() shows
  // nothing. Creating a notification in this same click is what makes macOS
  // ask to allow the Email app.
  const alreadyGranted = Notification.permission === "granted";
  if (alreadyGranted) {
    showMacNotificationNow("Email", "Allow Email if macOS asks. New mail will pop up here.", `email-push-on-${Date.now()}`);
  }
  const permissionPromise = alreadyGranted
    ? Promise.resolve(Notification.permission)
    : Notification.requestPermission();
  setPushState({ loading: true });

  let permission: Permission;
  try {
    permission = (await permissionPromise) as Permission;
  } catch {
    permission = currentPermission();
  }

  if (permission !== "granted") {
    setPushState({
      enabled: false,
      loading: false,
      permission: permission === "denied" ? "denied" : currentPermission(),
    });
    toast(
      permission === "denied"
        ? "Notifications are blocked. System Settings → Notifications → Email → Allow."
        : "Allow notifications in the prompt to turn them on."
    );
    return;
  }

  const sub = await subscribeToPush({ prompt: false });
  if (sub) writeLocal(OPT_OUT_KEY, null);
  setPushState({ enabled: !!sub, loading: false, permission: "granted" });
  if (sub) {
    toast("Notifications enabled");
    if (!alreadyGranted) {
      showMacNotificationNow("Email", "Banners are on. New mail will pop up here.", `email-push-on-${Date.now()}`);
    }
  } else {
    toast("Could not enable notifications — check browser permission");
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

  return {
    supported: state.supported,
    enabled: state.enabled,
    loading: state.loading,
    ready: state.ready,
    permission: state.permission,
    toggle,
  };
}

/** Permanent "don't ask again" for the enable-notifications banner. */
export function isPushBannerDismissed(): boolean {
  return !!readLocal(BANNER_DISMISSED_KEY);
}
export function dismissPushBanner(): void {
  writeLocal(BANNER_DISMISSED_KEY, String(Date.now()));
}
