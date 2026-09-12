/* Quel est le MEILLEUR pronostic auquel on puisse accéder ?

   On a comparé le modèle au marché. Mais « le marché » n'est pas une chose unique :
   un bookmaker vaut mieux qu'un autre, et le prix d'ouverture vaut moins que celui de
   clôture. On classe donc tous les prédicteurs réellement disponibles, sur les mêmes
   matchs, par log-loss et par précision.

   Usage : node outils/tester-predicteurs.mjs <dossier_csv>                            */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCSV, toObjects, pdate, num, sansMarge, ajusterMixte, lambdas, grille, marches } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/tester-predicteurs.mjs <dossier_csv>"); process.exit(1); }

const AMORCE = 380, REFIT = 20;

/* Séries de cotes à comparer : ouverture puis clôture, par bookmaker et en agrégé */
const SERIES = [
  ["Pinnacle ouverture", ["PSH", "PSD", "PSA"]],
  ["Pinnacle clôture", ["PSCH", "PSCD", "PSCA"]],
  ["Bet365 ouverture", ["B365H", "B365D", "B365A"]],
  ["Bet365 clôture", ["B365CH", "B365CD", "B365CA"]],
  ["moyenne ouverture", ["AvgH", "AvgD", "AvgA"]],
  ["moyenne clôture", ["AvgCH", "AvgCD", "AvgCA"]],
  ["meilleure cote clôture", ["MaxCH", "MaxCD", "MaxCA"]]
];

/* ── lecture brute : on garde toutes les colonnes de cotes ── */
const parDiv = {};
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv")))
  for (const o of toObjects(parseCSV(readFileSync(join(DOSSIER, f), "utf8")))) {
    const d = pdate(o.Date), hg = num(o.FTHG), ag = num(o.FTAG);
    const h = (o.HomeTeam || "").trim(), a = (o.AwayTeam || "").trim();
    if (!d || hg == null || ag == null || !h || !a || !o.Div) continue;
    (parDiv[o.Div.trim()] ||= []).push({
      d, div: o.Div.trim(), h, a, hg, ag,
      htc: num(o.HST), atc: num(o.AST), ht: num(o.HS), at: num(o.AS),
      brut: o
    });
  }

const NOMS = [...SERIES.map(s => s[0]), "notre modèle"];
const somme = new Array(NOMS.length).fill(0);
const bons = new Array(NOMS.length).fill(0);
let n = 0;

for (const div of Object.keys(parDiv).sort()) {
  const vus = new Set(), ms = [];
  for (const m of parDiv[div].sort((a, b) => a.d - b.d)) {
    const k = m.d + "|" + m.h + "|" + m.a;
    if (!vus.has(k)) { vus.add(k); ms.push(m); }
  }
  if (ms.length < AMORCE + 150) { console.log(`${div} ignoré`); continue; }

  let M = null, nDiv = 0;
  const sd = new Array(NOMS.length).fill(0), bd = new Array(NOMS.length).fill(0);

  for (let i = AMORCE; i < ms.length; i++) {
    if (!M || (i - AMORCE) % REFIT === 0)
      M = ajusterMixte(ms.slice(0, i), { demiVie: 180, regul: 2.5, ref: ms[i].d, iters: 60 });
    const m = ms[i];
    const cotes = SERIES.map(([, cols]) => cols.map(c => num(m.brut[c])));
    if (cotes.some(c => c.some(x => !x || x <= 1.01))) continue;     // on exige toutes les séries
    const L = lambdas(M, m.h, m.a);
    if (!L) continue;
    const mk = marches(grille(L[0], L[1], M.rho, 8));
    const probas = [...cotes.map(c => sansMarge(c)), [mk.H, mk.D, mk.A]];
    const res = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
    probas.forEach((p, k) => {
      sd[k] -= Math.log(Math.max(p[res], 1e-9));
      if (p.indexOf(Math.max(...p)) === res) bd[k]++;
    });
    nDiv++;
  }
  sd.forEach((v, k) => somme[k] += v);
  bd.forEach((v, k) => bons[k] += v);
  n += nDiv;
  const moy = sd.map(v => v / nDiv);
  const best = moy.indexOf(Math.min(...moy));
  console.log(`${div.padEnd(4)} ${String(nDiv).padStart(5)} matchs — meilleur : ${NOMS[best]} (${moy[best].toFixed(4)})`);
}

console.log("\n" + "═".repeat(68));
console.log(`CLASSEMENT DES PRÉDICTEURS — ${n} matchs`);
console.log("prédicteur                │ log-loss  │ issue correcte │ écart au meilleur");
console.log("─".repeat(68));
const moy = somme.map(v => v / n);
const meilleur = Math.min(...moy);
NOMS.map((nom, k) => ({ nom, ll: moy[k], acc: bons[k] / n }))
  .sort((a, b) => a.ll - b.ll)
  .forEach(x => {
    const d = x.ll - meilleur;
    console.log(`${x.nom.padEnd(25)} │ ${x.ll.toFixed(5)}  │    ${(100 * x.acc).toFixed(1)} %     │ `
      + (d === 0 ? "← le meilleur" : "+" + d.toFixed(5)));
  });
console.log("═".repeat(68));
