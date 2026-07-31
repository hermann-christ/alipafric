// Service worker — gère l'installabilité PWA et les notifications push.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") return;
  event.respondWith(fetch(event.request));
});

// Réception d'une notification push envoyée par le serveur.
self.addEventListener("push", (event) => {
  let donnees = { titre: "AlipAfric", corps: "Nouvelle notification", url: "/admin" };
  try {
    donnees = event.data.json();
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(donnees.titre, {
      body: donnees.corps,
      icon: "/icons/icon-admin-192.png",
      badge: "/icons/icon-admin-192.png",
      data: { url: donnees.url || "/admin" },
    })
  );
});

// Clic sur la notification : ouvre (ou remet au premier plan) la page admin concernée.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/admin";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});