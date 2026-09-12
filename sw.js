/* Service worker : rend l'application utilisable hors connexion.
   - coquille de l'application (html/css/js/icônes) : cache d'abord, actualisé en arrière-plan
   - données du jour (json) : réseau d'abord, repli sur le cache si hors ligne          */

const VERSION = "v1";
const COQUILLE = "coquille-" + VERSION;
const DONNEES = "donnees-" + VERSION;

const FICHIERS = [
  "./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest",
  "./icones/icone-192.png", "./icones/icone-512.png",
  "./icones/icone-maskable-512.png", "./icones/apple-touch-icon.png", "./icones/favicon-32.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(COQUILLE)
      .then(c => Promise.allSettled(FICHIERS.map(f => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== COQUILLE && k !== DONNEES).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // données : on privilégie la fraîcheur, le cache ne sert que de filet hors ligne
  if (url.pathname.includes("/donnees/")) {
    e.respondWith(
      fetch(req)
        .then(r => { const c = r.clone(); caches.open(DONNEES).then(x => x.put(req, c)); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // coquille : réponse immédiate depuis le cache, mise à jour silencieuse ensuite
  e.respondWith(
    caches.match(req).then(hit => {
      const reseau = fetch(req)
        .then(r => { if (r && r.ok) { const c = r.clone(); caches.open(COQUILLE).then(x => x.put(req, c)); } return r; })
        .catch(() => hit);
      return hit || reseau;
    })
  );
});
