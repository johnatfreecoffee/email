// Push notification helpers
import { apiFetch } from "./auth";

// Fork note: this MUST match the VAPID keypair the server signs with
// (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the Pages Functions env). A fresh
// keypair was generated for this fork; the public half is wired via env.
const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
  "BGPBcDA1d-bXrIIIVdERHbDHjg9-nMfwFrm7vAMm7LPs70KhR_Xg39uxaFowLYP1YeJkyKwFUyuK7WJmQKL8FjU";

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

export async function subscribeToPush(): Promise<PushSubscription | null> {
  try {
    const reg = await registerServiceWorker();
    if (!reg) return null;

    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    // Subscribe
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });

    // Send to backend
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

    // Remove from backend
    await apiFetch("/api/email/push", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });

    // Unsubscribe locally
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
