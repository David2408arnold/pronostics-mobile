/* Mesure du poids optimal à donner au modèle face au consensus du marché.

   Le modèle Dixon-Coles seul prédit moins bien que les bookmakers. Plutôt que de
   l'utiliser brut, on l'utilise pour *dévier légèrement* du prix de marché :

       p_finale = w · p_modèle + (1 − w) · p_marché

   Ce script cherche le w qui minimise le log-loss, en walk-forward strict :
   pour chaque match, le modèle n'a vu que les matchs antérieurs.

   Usage : node outils/calibrer.mjs <dossier_csv>                                  */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lireResultats, ajuster, lambdas, grille, marches, sansMarge } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/calibrer.mjs <dossier_csv>"); process.exit(1); }

const AMORCE = 380, REFIT = 10;
const POIDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/* lecture de tous les CSV du dossier, regroupés par championnat */
const parDiv = {};
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv"))) {
  for (const m of lireResultats(readFileSync(join(DOSSIER, f), "utf8"))) {
    if (!m.div || !m.oh || !m.od || !m.oa) continue;
    (parDiv[m.div] ||= []).push(m);
  }
}

const global = { n: 0, ll: POIDS.map(() => 0), brier: POIDS.map(() => 0) };
const detail = [];

for (const div of Object.keys(parDiv).sort()) {
  const ms = parDiv[div].sort((a, b) => a.d - b.d);
  // déduplication (les saisons peuvent se recouvrir)
  const vus = new Set(), uniq = [];
  for (const m of ms) { const k = m.d + "|" + m.h + "|" + m.a; if (!vus.has(k)) { vus.add(k); uniq.push(m); } }
  if (uniq.length < AMORCE + 100) { console.log(`${div} : ignoré (${uniq.length} matchs)`); continue; }

  let M = null, n = 0;
  const ll = POIDS.map(() => 0);
  for (let i = AMORCE; i < uniq.length; i++) {
    if (!M || (i - AMORCE) % REFIT === 0) M = ajuster(uniq.slice(0, i), { ref: uniq[i].d, iters: 60 });
    const m = uniq[i], L = lambdas(M, m.h, m.a);
    if (!L) continue;
    const mk = marches(grille(L[0], L[1], M.rho, 8));
    const pm = [mk.H, mk.D, mk.A];
    const pb = sansMarge([m.oh, m.od, m.oa]);
    const res = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
    n++;
    POIDS.forEach((w, k) => {
      const p = w * pm[res] + (1 - w) * pb[res];
      ll[k] -= Math.log(Math.max(p, 1e-9));
    });
  }
  const moy = ll.map(x => x / n);
  const meilleur = moy.indexOf(Math.min(...moy));
  detail.push({ div, n, moy, meilleur: POIDS[meilleur] });
  global.n += n;
  moy.forEach((v, k) => global.ll[k] += v * n);
  console.log(`${div.padEnd(4)} ${String(n).padStart(5)} matchs — meilleur poids modèle : ${POIDS[meilleur]}`
    + `  (log-loss ${moy[meilleur].toFixed(4)} contre ${moy[0].toFixed(4)} pour le marché seul et ${moy[10].toFixed(4)} pour le modèle seul)`);
}

console.log("\n" + "═".repeat(74));
console.log("SYNTHÈSE sur " + global.n + " matchs");
console.log("poids modèle │ log-loss moyen │ écart avec le marché seul");
const moyG = global.ll.map(x => x / global.n);
const ref = moyG[0];
POIDS.forEach((w, k) => {
  const d = ref - moyG[k];
  const barre = d > 0 ? "█".repeat(Math.round(d * 2000)) : "";
  console.log(`     ${String(w).padEnd(4)}    │    ${moyG[k].toFixed(5)}     │ ${d >= 0 ? "+" : ""}${d.toFixed(5)} ${barre}`);
});
const best = moyG.indexOf(Math.min(...moyG));
console.log("═".repeat(74));
console.log(`Poids optimal du modèle : ${POIDS[best]}  (gain de ${(ref - moyG[best]).toFixed(5)} de log-loss sur le marché seul)`);
console.log(POIDS[best] === 0
  ? "→ Le modèle n'apporte rien : s'en tenir au prix de marché."
  : `→ Le modèle apporte une information résiduelle, mais le marché doit garder ${(100 * (1 - POIDS[best])).toFixed(0)} % du poids.`);
