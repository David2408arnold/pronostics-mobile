/* Estimer les forces sur les TIRS plutôt que sur les BUTS améliore-t-il le pronostic ?

   L'argument classique : un but est un événement rare, donc très bruité. Une équipe
   qui a cadré 8 fois et marqué 0 a probablement mieux joué que le score ne le dit.
   Les xG servent à cela ; faute de xG dans nos données, on utilise les tirs cadrés
   convertis au taux moyen du championnat, calculé sur les seules données passées.

   Variantes comparées, toutes en walk-forward strict :
     buts            — le modèle actuel
     tirs cadrés     — forces estimées sur tirs cadrés × taux de conversion
     tirs            — idem sur l'ensemble des tirs
     mélange 50/50   — moyenne des buts et des tirs cadrés convertis
     marché          — référence

   Usage : node outils/tester-xg.mjs <dossier_csv>                                     */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lireResultats, ajuster, lambdas, grille, marches, sansMarge } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/tester-xg.mjs <dossier_csv>"); process.exit(1); }

const AMORCE = 380, REFIT = 20, DEMI_VIE = 180, REGUL = 2.5;

/* Construit une copie des matchs où les buts sont remplacés par une estimation
   tirée des tirs. Le taux de conversion vient du passé uniquement. */
function convertir(passe, champH, champA) {
  let buts = 0, tirs = 0;
  for (const m of passe) {
    if (m[champH] == null || m[champA] == null) continue;
    buts += m.hg + m.ag;
    tirs += m[champH] + m[champA];
  }
  const taux = tirs > 0 ? buts / tirs : 0.1;
  return { taux, convertis: passe.map(m => (m[champH] == null || m[champA] == null) ? m
    : { ...m, hg: m[champH] * taux, ag: m[champA] * taux }) };
}
const melanger = (a, b) => a.map((m, i) => ({ ...m, hg: (m.hg + b[i].hg) / 2, ag: (m.ag + b[i].ag) / 2 }));

const NOMS = ["buts (actuel)", "tirs cadrés", "tirs", "mélange buts+cadrés", "marché"];
const total = new Array(NOMS.length).fill(0);
const brier = new Array(NOMS.length).fill(0);
let n = 0;

const parDiv = {};
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv")))
  for (const m of lireResultats(readFileSync(join(DOSSIER, f), "utf8"))) {
    if (!m.div || !m.oh || !m.od || !m.oa || m.htc == null) continue;
    (parDiv[m.div] ||= []).push(m);
  }

for (const div of Object.keys(parDiv).sort()) {
  const vus = new Set(), ms = [];
  for (const m of parDiv[div].sort((a, b) => a.d - b.d)) {
    const k = m.d + "|" + m.h + "|" + m.a;
    if (!vus.has(k)) { vus.add(k); ms.push(m); }
  }
  if (ms.length < AMORCE + 150) { console.log(`${div} ignoré (${ms.length} matchs)`); continue; }

  const t0 = Date.now();
  const somme = new Array(NOMS.length).fill(0), sb = new Array(NOMS.length).fill(0);
  let nDiv = 0, modeles = null, tauxCadres = 0;

  for (let i = AMORCE; i < ms.length; i++) {
    if (!modeles || (i - AMORCE) % REFIT === 0) {
      const passe = ms.slice(0, i), ref = ms[i].d;
      const o = { demiVie: DEMI_VIE, regul: REGUL, ref, iters: 60 };
      const cadres = convertir(passe, "htc", "atc");
      const tirs = convertir(passe, "ht", "at");
      tauxCadres = cadres.taux;
      const mButs = ajuster(passe, o);
      modeles = [
        mButs,
        { ...ajuster(cadres.convertis, { ...o, estimerRho: false }), rho: mButs.rho },
        { ...ajuster(tirs.convertis, { ...o, estimerRho: false }), rho: mButs.rho },
        { ...ajuster(melanger(passe, cadres.convertis), { ...o, estimerRho: false }), rho: mButs.rho }
      ];
    }
    const m = ms[i];
    const probas = modeles.map(M => {
      const L = lambdas(M, m.h, m.a);
      if (!L) return null;
      const k = marches(grille(L[0], L[1], M.rho, 8));
      return [k.H, k.D, k.A];
    });
    if (probas.some(p => !p)) continue;
    const marche = sansMarge([m.oh, m.od, m.oa]);
    const res = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
    [...probas, marche].forEach((p, k) => {
      somme[k] -= Math.log(Math.max(p[res], 1e-9));
      for (let j = 0; j < 3; j++) sb[k] += (p[j] - (res === j ? 1 : 0)) ** 2;
    });
    nDiv++;
  }
  somme.forEach((v, k) => total[k] += v);
  sb.forEach((v, k) => brier[k] += v);
  n += nDiv;
  const moy = somme.map(v => v / nDiv);
  const best = moy.indexOf(Math.min(...moy.slice(0, -1)));
  console.log(`${div.padEnd(4)} ${String(nDiv).padStart(5)} matchs (${((Date.now() - t0) / 1000).toFixed(0)} s)`
    + ` — meilleure : ${NOMS[best]} ${moy[best].toFixed(4)} | buts ${moy[0].toFixed(4)} | marché ${moy[4].toFixed(4)}`
    + ` | conversion ${(100 * tauxCadres).toFixed(1)} %`);
}

console.log("\n" + "═".repeat(70));
console.log(`SYNTHÈSE sur ${n} matchs`);
console.log("variante                │ log-loss  │  Brier   │ écart avec « buts »");
console.log("─".repeat(70));
const moy = total.map(v => v / n), mb = brier.map(v => v / n);
const ref = moy[0];
moy.forEach((v, k) => {
  const d = ref - v;
  const note = k === 4 ? "  ← le marché" : k === 0 ? "  ← référence" : d > 0.001 ? "  ← mieux" : d < -0.001 ? "  ← moins bien" : "  ≈ identique";
  console.log(`${NOMS[k].padEnd(23)} │ ${v.toFixed(5)}  │ ${mb[k].toFixed(5)} │ ${d >= 0 ? "+" : ""}${d.toFixed(5)}${note}`);
});
const cand = moy.slice(0, 4);
const best = cand.indexOf(Math.min(...cand));
console.log("═".repeat(70));
console.log(best === 0
  ? "→ Estimer les forces sur les tirs n'améliore pas le modèle."
  : `→ « ${NOMS[best]} » gagne ${(ref - moy[best]).toFixed(5)} de log-loss sur les buts.`);
console.log(`   Le marché garde ${(moy[best] - moy[4]).toFixed(5)} d'avance sur la meilleure variante.`);
