/* Une couche d'apprentissage par-dessus le modèle apporterait-elle quelque chose ?

   C'est la forme la plus honnête de la question « et si on mettait de l'IA ». Plutôt
   que de remplacer Dixon-Coles par un réseau, on teste la couche la moins coûteuse et
   la plus souvent payante : réapprendre la CALIBRATION de ses sorties.

   Trois corrections, toutes ajustées sur le seul passé, en walk-forward strict :
     puissance   p ∝ p^α        — corrige l'excès ou le manque de confiance
     mélange     p ← (1−λ)p + λ·taux de base du championnat
     les deux

   Si le modèle était mal calibré, ces corrections doivent gagner. Si elles ne gagnent
   rien, c'est que le problème n'est pas la mise en forme des probabilités mais
   l'information dont on dispose — et aucune couche d'apprentissage n'y changera rien.

   Usage : node outils/tester-calibration.mjs <dossier_csv>                             */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lireResultats, ajusterMixte, lambdas, grille, marches, sansMarge } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/tester-calibration.mjs <dossier_csv>"); process.exit(1); }

const AMORCE = 380, REFIT = 20, REAPPRENTISSAGE = 100;   // on réajuste α et λ tous les 100 matchs
const ALPHAS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];
const LAMBDAS = [0, 0.05, 0.1, 0.2];

const renorm = v => { const s = v.reduce((a, b) => a + b, 0); return v.map(x => x / s); };
const puissance = (p, a) => renorm(p.map(x => Math.pow(Math.max(x, 1e-9), a)));
const melange = (p, l, base) => renorm(p.map((x, i) => (1 - l) * x + l * base[i]));

const NOMS = ["modèle brut", "puissance α", "mélange λ", "les deux", "marché"];
const total = new Array(NOMS.length).fill(0);
let n = 0;

const parDiv = {};
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv")))
  for (const m of lireResultats(readFileSync(join(DOSSIER, f), "utf8"))) {
    if (!m.div || !m.oh || !m.od || !m.oa) continue;
    (parDiv[m.div] ||= []).push(m);
  }

for (const div of Object.keys(parDiv).sort()) {
  const vus = new Set(), ms = [];
  for (const m of parDiv[div].sort((a, b) => a.d - b.d)) {
    const k = m.d + "|" + m.h + "|" + m.a;
    if (!vus.has(k)) { vus.add(k); ms.push(m); }
  }
  if (ms.length < AMORCE + 200) { console.log(`${div} ignoré`); continue; }

  const somme = new Array(NOMS.length).fill(0);
  let nDiv = 0, M = null;
  let alpha = 1, lam = 0, alpha2 = 1, lam2 = 0;
  const archive = [];                 // {p, res} des matchs déjà vus, pour réapprendre

  for (let i = AMORCE; i < ms.length; i++) {
    if (!M || (i - AMORCE) % REFIT === 0)
      M = ajusterMixte(ms.slice(0, i), { demiVie: 180, regul: 2.5, ref: ms[i].d, iters: 60 });

    /* réapprentissage des paramètres de calibration, sur le passé uniquement */
    if (archive.length >= 200 && (i - AMORCE) % REAPPRENTISSAGE === 0) {
      const base = renorm(archive.reduce((t, x) => (t[x.res]++, t), [1, 1, 1]));
      const perte = (f) => archive.reduce((t, x) => t - Math.log(Math.max(f(x.p)[x.res], 1e-9)), 0);
      let meilleur = Infinity;
      for (const a of ALPHAS) { const v = perte(p => puissance(p, a)); if (v < meilleur) { meilleur = v; alpha = a; } }
      meilleur = Infinity;
      for (const l of LAMBDAS) { const v = perte(p => melange(p, l, base)); if (v < meilleur) { meilleur = v; lam = l; } }
      meilleur = Infinity;
      for (const a of ALPHAS) for (const l of LAMBDAS) {
        const v = perte(p => melange(puissance(p, a), l, base));
        if (v < meilleur) { meilleur = v; alpha2 = a; lam2 = l; }
      }
    }

    const m = ms[i], L = lambdas(M, m.h, m.a);
    if (!L) continue;
    const mk = marches(grille(L[0], L[1], M.rho, 8));
    const p = [mk.H, mk.D, mk.A];
    const res = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
    const base = archive.length ? renorm(archive.reduce((t, x) => (t[x.res]++, t), [1, 1, 1])) : [1 / 3, 1 / 3, 1 / 3];

    const variantes = [
      p,
      puissance(p, alpha),
      melange(p, lam, base),
      melange(puissance(p, alpha2), lam2, base),
      sansMarge([m.oh, m.od, m.oa])
    ];
    variantes.forEach((v, k) => somme[k] -= Math.log(Math.max(v[res], 1e-9)));
    archive.push({ p, res });
    nDiv++;
  }
  somme.forEach((v, k) => total[k] += v);
  n += nDiv;
  const moy = somme.map(v => v / nDiv);
  console.log(`${div.padEnd(4)} ${String(nDiv).padStart(5)} matchs — brut ${moy[0].toFixed(4)}`
    + ` | calibré ${Math.min(moy[1], moy[2], moy[3]).toFixed(4)} | marché ${moy[4].toFixed(4)}`
    + `   (α=${alpha}, λ=${lam})`);
}

console.log("\n" + "═".repeat(64));
console.log(`SYNTHÈSE sur ${n} matchs`);
console.log("variante          │ log-loss  │ gain sur le modèle brut");
console.log("─".repeat(64));
const moy = total.map(v => v / n), ref = moy[0];
moy.forEach((v, k) => {
  const d = ref - v;
  console.log(`${NOMS[k].padEnd(17)} │ ${v.toFixed(5)}  │ ${d >= 0 ? "+" : ""}${d.toFixed(5)}`
    + (k === 4 ? "  ← le marché" : k === 0 ? "  ← référence" : Math.abs(d) < 0.0005 ? "  ≈ rien" : d > 0 ? "  ← mieux" : "  ← moins bien"));
});
const best = moy.slice(0, 4).indexOf(Math.min(...moy.slice(0, 4)));
console.log("═".repeat(64));
console.log(best === 0
  ? "→ Recalibrer n'apporte rien : le modèle est déjà bien calibré, sa limite est l'information."
  : `→ « ${NOMS[best]} » gagne ${(ref - moy[best]).toFixed(5)}. Reste ${(moy[best] - moy[4]).toFixed(5)} derrière le marché.`);
