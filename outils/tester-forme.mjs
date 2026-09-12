/* La forme récente améliore-t-elle le pronostic ?

   Le modèle pondère déjà les matchs par leur ancienneté (demi-vie de 180 jours par
   défaut). S'appuyer davantage sur « les 10 derniers matchs » revient à raccourcir
   cette demi-vie. On balaie donc plusieurs valeurs, et on teste en plus un mélange
   explicite entre une vue longue et une vue courte.

   Protocole : walk-forward strict, le modèle ne voit que les matchs antérieurs.
   Critère : log-loss sur le 1X2 (plus bas = meilleur).

   Usage : node outils/tester-forme.mjs <dossier_csv>                                  */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lireResultats, ajuster, lambdas, grille, marches, sansMarge } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/tester-forme.mjs <dossier_csv>"); process.exit(1); }

const AMORCE = 380, REFIT = 20;
const DEMI_VIES = [30, 45, 60, 90, 180, 365, 3650];   // 3650 ≈ aucune décroissance
const MELANGES = [0.25, 0.5];                          // poids donné à la vue courte (45 j)

/* ─── lecture ─── */
const parDiv = {};
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv")))
  for (const m of lireResultats(readFileSync(join(DOSSIER, f), "utf8"))) {
    if (!m.div || !m.oh || !m.od || !m.oa) continue;
    (parDiv[m.div] ||= []).push(m);
  }

const noms = [...DEMI_VIES.map(d => `demi-vie ${d === 3650 ? "aucune" : d + " j"}`),
...MELANGES.map(w => `mélange 45 j à ${(100 * w).toFixed(0)} %`), "marché"];
const total = new Array(noms.length).fill(0);
let n = 0;

for (const div of Object.keys(parDiv).sort()) {
  const vus = new Set(), ms = [];
  for (const m of parDiv[div].sort((a, b) => a.d - b.d)) {
    const k = m.d + "|" + m.h + "|" + m.a;
    if (!vus.has(k)) { vus.add(k); ms.push(m); }
  }
  if (ms.length < AMORCE + 150) { console.log(`${div} ignoré (${ms.length} matchs)`); continue; }

  const t0 = Date.now();
  const somme = new Array(noms.length).fill(0);
  let nDiv = 0, modeles = null;

  for (let i = AMORCE; i < ms.length; i++) {
    if (!modeles || (i - AMORCE) % REFIT === 0) {
      const passe = ms.slice(0, i), ref = ms[i].d;
      modeles = DEMI_VIES.map(dv => ajuster(passe, { demiVie: dv, regul: 2.5, ref, iters: 60 }));
    }
    const m = ms[i];
    const probas = modeles.map(M => {
      const L = lambdas(M, m.h, m.a);
      if (!L) return null;
      const k = marches(grille(L[0], L[1], M.rho, 8));
      return [k.H, k.D, k.A];
    });
    if (probas.some(p => !p)) continue;

    const iLong = DEMI_VIES.indexOf(180), iCourt = DEMI_VIES.indexOf(45);
    const melanges = MELANGES.map(w => probas[iLong].map((p, k) => (1 - w) * p + w * probas[iCourt][k]));
    const marche = sansMarge([m.oh, m.od, m.oa]);
    const res = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;

    [...probas, ...melanges, marche].forEach((p, k) => {
      somme[k] -= Math.log(Math.max(p[res], 1e-9));
    });
    nDiv++;
  }
  somme.forEach((v, k) => total[k] += v);
  n += nDiv;
  const moy = somme.map(v => v / nDiv);
  const best = moy.indexOf(Math.min(...moy.slice(0, -1)));
  console.log(`${div.padEnd(4)} ${String(nDiv).padStart(5)} matchs (${((Date.now() - t0) / 1000).toFixed(0)} s)`
    + ` — meilleure variante : ${noms[best]} (${moy[best].toFixed(4)}), marché ${moy[moy.length - 1].toFixed(4)}`);
}

console.log("\n" + "═".repeat(66));
console.log(`SYNTHÈSE sur ${n} matchs`);
console.log("variante                    │ log-loss  │ écart avec la référence 180 j");
console.log("─".repeat(66));
const moy = total.map(v => v / n);
const ref = moy[DEMI_VIES.indexOf(180)];
moy.forEach((v, k) => {
  const d = ref - v;
  const marque = k === moy.length - 1 ? "  ← le marché" : d > 0.0005 ? "  ← mieux" : "";
  console.log(`${noms[k].padEnd(27)} │ ${v.toFixed(5)}  │ ${d >= 0 ? "+" : ""}${d.toFixed(5)}${marque}`);
});
const candidats = moy.slice(0, -1);
const best = candidats.indexOf(Math.min(...candidats));
console.log("═".repeat(66));
console.log(`Meilleure variante du modèle : ${noms[best]}`);
console.log(best === DEMI_VIES.indexOf(180)
  ? "→ Le réglage actuel est déjà le meilleur : donner plus de poids aux matchs récents n'aide pas."
  : `→ Gain de ${(ref - moy[best]).toFixed(5)} de log-loss sur le réglage actuel.`);
console.log(`Le marché reste devant de ${(moy[moy.length - 1] - moy[best] < 0 ? "" : "+")}${(moy[best] - moy[moy.length - 1]).toFixed(5)}.`);
