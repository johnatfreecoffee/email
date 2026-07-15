// Email app service worker — push notifications + deep links
const CACHE_NAME = "email-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => clients.claim())
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Email", body: "New notification", type: "general" };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const isEmail = data.type === "email";

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [200, 100, 200],
    tag: isEmail ? `email-${data.messageId || Date.now()}` : `email-app-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    data: data,
    actions: isEmail
      ? [
          { action: "read", title: "Read" },
          { action: "dismiss", title: "Dismiss" },
        ]
      : [
          { action: "open", title: "Open" },
          { action: "dismiss", title: "Dismiss" },
        ],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const data = event.notification.data || {};
  let targetUrl = "/email";

  if (data.type === "email") {
    targetUrl = data.messageId ? `/email?msg=${data.messageId}` : "/email";
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.postMessage({
            type: "notification-click",
            data: data,
          });
          if (data.type === "email") {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
