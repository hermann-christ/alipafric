// Service worker minimal — requis par les navigateurs pour proposer
// l'installation du site comme application ("Ajouter à l'écran d'accueil").
// Ne met rien en cache pour l'instant : le site reste toujours à jour.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});