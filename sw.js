/* Service worker : rend l'application utilisable hors connexion.

   Stratégie unique — RÉSEAU D'ABORD, cache en repli.

   La coquille était initialement servie « cache d'abord ». C'est plus rapide, mais toute
   correction n'arrivait qu'au chargement suivant : on pouvait lire du code de la veille sans
   le savoir. L'application pèse une soixantaine de kilo-octets : la fraîcheur vaut mieux que
   les quelques dizaines de millisecondes gagnées. Hors connexion, le cache prend le relais et
   tout reste utilisable.                                                                     */

const VERSION = "v21";
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

  const cible = url.pathname.includes("/donnees/") ? DONNEES : COQUILLE;
  e.respondWith(
    fetch(req)
      .then(r => {
        if (r && r.ok) { const c = r.clone(); caches.open(cible).then(x => x.put(req, c)); }
        return r;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});
