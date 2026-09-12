/* Quelle méthode de retrait de marge estime le mieux les vraies probabilités ?

   Une cote de 21 n'implique pas une probabilité de 1/21 : les bookmakers chargent
   davantage de marge sur les gros outsiders (biais favori / outsider). Retirer la marge
   proportionnellement surestime donc les petites probabilités — et fabrique de faux
   avantages sur les cotes élevées.

   On compare trois méthodes sur les résultats réels, par log-loss et par calibration.

   Usage : node outils/comparer-marge.mjs <dossier_csv>                               */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lireResultats } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/comparer-marge.mjs <dossier_csv>"); process.exit(1); }

/* ── méthodes ── */
const proportionnelle = c => { const r = c.map(o => 1 / o), s = r.reduce((a, b) => a + b, 0); return r.map(x => x / s); };

/** Méthode par puissance : on cherche k tel que Σ (1/oᵢ)^k = 1.
    k > 1 comprime davantage les petites probabilités que les grandes. */
function puissance(c) {
  const r = c.map(o => 1 / o);
  let lo = 0.5, hi = 3;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    const s = r.reduce((a, x) => a + Math.pow(x, k), 0);
    if (s > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const p = r.map(x => Math.pow(x, k));
  const s = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / s);
}

/** Méthode de Shin : suppose une proportion z de parieurs informés. */
function shin(c) {
  const r = c.map(o => 1 / o), S = r.reduce((a, b) => a + b, 0);
  let lo = 0, hi = 0.35;
  const probs = z => r.map(x => (Math.sqrt(z * z + 4 * (1 - z) * x * x / S) - z) / (2 * (1 - z)));
  for (let i = 0; i < 60; i++) {
    const z = (lo + hi) / 2;
    const s = probs(z).reduce((a, b) => a + b, 0);
    if (s > 1) lo = z; else hi = z;
  }
  const p = probs((lo + hi) / 2), s = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / s);
}

const METHODES = { proportionnelle, puissance, shin };

/* ── lecture ── */
const vus = new Set(), ms = [];
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv")))
  for (const m of lireResultats(readFileSync(join(DOSSIER, f), "utf8"))) {
    if (!m.oh || !m.od || !m.oa) continue;
    const k = m.d + "|" + m.h + "|" + m.a;
    if (vus.has(k)) continue;
    vus.add(k); ms.push(m);
  }
console.log(`${ms.length} matchs avec cotes\n`);

/* ── évaluation ── */
const res = {};
for (const nom of Object.keys(METHODES)) res[nom] = { ll: 0, brier: 0, n: 0 };
// calibration par tranche de probabilité, pour voir où ça dérape
const TRANCHES = [[0, .05], [.05, .1], [.1, .2], [.2, .35], [.35, .5], [.5, .7], [.7, 1]];
const cal = {}; for (const n of Object.keys(METHODES)) cal[n] = TRANCHES.map(() => ({ n: 0, p: 0, o: 0 }));

for (const m of ms) {
  const issue = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
  for (const [nom, fn] of Object.entries(METHODES)) {
    const p = fn([m.oh, m.od, m.oa]);
    res[nom].ll -= Math.log(Math.max(p[issue], 1e-9));
    for (let k = 0; k < 3; k++) res[nom].brier += (p[k] - (issue === k ? 1 : 0)) ** 2;
    res[nom].n++;
    for (let k = 0; k < 3; k++) {
      const t = TRANCHES.findIndex(([a, b]) => p[k] >= a && p[k] < b);
      if (t >= 0) { cal[nom][t].n++; cal[nom][t].p += p[k]; cal[nom][t].o += (issue === k ? 1 : 0); }
    }
  }
}

console.log("méthode          │ log-loss │  Brier  │ verdict");
console.log("─".repeat(62));
const scores = Object.entries(res).map(([n, r]) => [n, r.ll / r.n, r.brier / r.n]);
const meilleur = scores.reduce((a, b) => b[1] < a[1] ? b : a);
for (const [n, ll, br] of scores)
  console.log(`${n.padEnd(16)} │ ${ll.toFixed(5)}  │ ${br.toFixed(5)} │ ${n === meilleur[0] ? "← meilleure" : "+" + (ll - meilleur[1]).toFixed(5)}`);

console.log("\nCalibration — probabilité annoncée contre fréquence réelle");
console.log("tranche      │ " + Object.keys(METHODES).map(n => n.slice(0, 12).padEnd(21)).join("│"));
console.log("─".repeat(76));
TRANCHES.forEach(([a, b], i) => {
  let ligne = `${(100 * a).toFixed(0).padStart(3)}–${(100 * b).toFixed(0).padStart(3)} %   │ `;
  for (const n of Object.keys(METHODES)) {
    const c = cal[n][i];
    ligne += c.n < 50 ? "        —            │ "
      : `${(100 * c.p / c.n).toFixed(1)}% → ${(100 * c.o / c.n).toFixed(1)}% (${(100 * (c.o - c.p) / c.n >= 0 ? "+" : "")}${(100 * (c.o - c.p) / c.n).toFixed(1)})`.padEnd(21) + "│ ";
  }
  console.log(ligne);
});
console.log("\nUne valeur négative dans la parenthèse = probabilité surestimée par la méthode.");
