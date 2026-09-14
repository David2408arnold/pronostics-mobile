/* Comment mieux prédire le score exact ?

   Le score affiché dépend entièrement des deux buts attendus (λ domicile, λ extérieur)
   et de la correction des petits scores (ρ, Dixon-Coles). On compare, en walk-forward
   strict, plusieurs sources de λ et de ρ :

     modèle + DC        λ du modèle, ρ estimé                  (actuel)
     modèle sans DC     λ du modèle, ρ = 0
     marché + DC        λ déduits des cotes 1X2 ET plus/moins 2,5 de clôture, ρ du championnat
     marché sans DC     idem, ρ = 0
     mélange + DC       moyenne des λ du modèle et du marché

   Le marché a déjà battu le modèle sur l'issue : on vérifie si ses λ implicites donnent
   aussi de meilleurs scores. Critères : log-loss du score exact (le seul critère propre)
   et taux de score exact trouvé, avec deux règles d'affichage (mode brut, mode dans
   l'issue pronostiquée). On contrôle aussi la calibration des scores fréquents.

   Usage : node outils/tester-scores.mjs <dossier_csv>                                   */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCSV, toObjects, pdate, num, sansMarge, ajusterMixte, lambdas } from "./modele.mjs";

const DOSSIER = process.argv[2];
if (!DOSSIER) { console.error("Usage : node outils/tester-scores.mjs <dossier_csv>"); process.exit(1); }
const AMORCE = 380, REFIT = 20, G = 10;

const F = [1]; for (let i = 1; i <= 25; i++) F[i] = F[i - 1] * i;
const po = (k, l) => Math.exp(-l) * Math.pow(l, k) / F[k];

/** Grille normalisée des scores 0..G, avec correction Dixon-Coles. */
function grilleScores(l, m, rho) {
  const P = []; let t = 0;
  for (let x = 0; x <= G; x++) {
    P[x] = [];
    for (let y = 0; y <= G; y++) {
      let c = 1;
      if (x === 0 && y === 0) c = 1 - l * m * rho; else if (x === 0 && y === 1) c = 1 + l * rho;
      else if (x === 1 && y === 0) c = 1 + m * rho; else if (x === 1 && y === 1) c = 1 - rho;
      const v = Math.max(0, c) * po(x, l) * po(y, m);
      P[x][y] = v; t += v;
    }
  }
  for (let x = 0; x <= G; x++) for (let y = 0; y <= G; y++) P[x][y] /= t;
  return P;
}
/** Probabilités 1, N, 2 et plus de 2,5 buts sur une grille réduite (rapide, pour l'ajustement). */
function resume(l, m, rho) {
  let H = 0, D = 0, A = 0, O = 0, t = 0;
  for (let x = 0; x <= 7; x++) for (let y = 0; y <= 7; y++) {
    let c = 1;
    if (x === 0 && y === 0) c = 1 - l * m * rho; else if (x === 0 && y === 1) c = 1 + l * rho;
    else if (x === 1 && y === 0) c = 1 + m * rho; else if (x === 1 && y === 1) c = 1 - rho;
    const v = Math.max(0, c) * po(x, l) * po(y, m);
    t += v; if (x > y) H += v; else if (x === y) D += v; else A += v;
    if (x + y > 2.5) O += v;
  }
  return [H / t, D / t, A / t, O / t];
}
/** λ implicites du marché : ceux dont la grille reproduit le mieux 1, N, 2 et plus de 2,5. */
function lambdasMarche(cible, rho) {
  const err = (l, m) => { const r = resume(l, m, rho); let e = 0; for (let k = 0; k < 4; k++) e += (r[k] - cible[k]) ** 2; return e; };
  let bl = 1.4, bm = 1.1, be = Infinity;
  for (let l = 0.2; l <= 3.8; l += 0.1) for (let m = 0.2; m <= 3.4; m += 0.1) {
    const e = err(l, m); if (e < be) { be = e; bl = l; bm = m; }
  }
  for (const pas of [0.02, 0.005]) {
    const l0 = bl, m0 = bm;
    for (let l = l0 - 6 * pas; l <= l0 + 6 * pas; l += pas) for (let m = m0 - 6 * pas; m <= m0 + 6 * pas; m += pas) {
      if (l <= 0.05 || m <= 0.05) continue;
      const e = err(l, m); if (e < be) { be = e; bl = l; bm = m; }
    }
  }
  return [bl, bm];
}
function mode(P, issue) {
  let best = null, bp = -1;
  for (let x = 0; x <= G; x++) for (let y = 0; y <= G; y++) {
    if (issue && (issue === "1" ? !(x > y) : issue === "N" ? x !== y : !(x < y))) continue;
    if (P[x][y] > bp) { bp = P[x][y]; best = [x, y]; }
  }
  return best;
}
function issueFavorite(P) {
  let H = 0, D = 0, A = 0;
  for (let x = 0; x <= G; x++) for (let y = 0; y <= G; y++) { if (x > y) H += P[x][y]; else if (x === y) D += P[x][y]; else A += P[x][y]; }
  return H >= D && H >= A ? "1" : D >= A ? "N" : "2";
}

/* ── lecture ── */
const parDiv = {};
for (const f of readdirSync(DOSSIER).filter(x => x.toLowerCase().endsWith(".csv")))
  for (const o of toObjects(parseCSV(readFileSync(join(DOSSIER, f), "utf8")))) {
    const d = pdate(o.Date), hg = num(o.FTHG), ag = num(o.FTAG);
    const h = (o.HomeTeam || "").trim(), a = (o.AwayTeam || "").trim();
    if (!d || hg == null || ag == null || !h || !a || !o.Div) continue;
    const c1 = [num(o.AvgCH) || num(o.AvgH), num(o.AvgCD) || num(o.AvgD), num(o.AvgCA) || num(o.AvgA)];
    const cou = [num(o["AvgC>2.5"]) || num(o["Avg>2.5"]), num(o["AvgC<2.5"]) || num(o["Avg<2.5"])];
    (parDiv[o.Div.trim()] ||= []).push({
      d, h, a, hg, ag, htc: num(o.HST), atc: num(o.AST),
      c1: c1.every(x => x > 1.01) ? c1 : null, cou: cou.every(x => x > 1.01) ? cou : null
    });
  }

const NOMS = ["modèle + DC (actuel)", "modèle sans DC", "marché + DC", "marché sans DC", "mélange + DC"];
const S = NOMS.map(() => ({ ll: 0, mode: 0, modeIssue: 0, modeIssueM: 0, p11: 0, p10: 0, p00: 0 }));
let n = 0, reel11 = 0, reel10 = 0, reel00 = 0;
const t0 = Date.now();

for (const div of Object.keys(parDiv).sort()) {
  const vus = new Set(), ms = [];
  for (const m of parDiv[div].sort((a, b) => a.d - b.d)) { const k = m.d + m.h + m.a; if (!vus.has(k)) { vus.add(k); ms.push(m); } }
  if (ms.length < AMORCE + 150) { console.log(`${div} ignoré`); continue; }
  let M = null, nDiv = 0;
  for (let i = AMORCE; i < ms.length; i++) {
    if (!M || (i - AMORCE) % REFIT === 0) M = ajusterMixte(ms.slice(0, i), { demiVie: 180, regul: 2.5, ref: ms[i].d, iters: 60 });
    const m = ms[i];
    if (!m.c1 || !m.cou) continue;
    const Lm = lambdas(M, m.h, m.a);
    if (!Lm) continue;
    const p1 = sansMarge(m.c1), pou = sansMarge(m.cou);
    const cible = [p1[0], p1[1], p1[2], pou[0]];
    const Lq = lambdasMarche(cible, M.rho), Lq0 = lambdasMarche(cible, 0);
    const variantes = [
      [Lm, M.rho], [Lm, 0], [Lq, M.rho], [Lq0, 0],
      [[(Lm[0] + Lq[0]) / 2, (Lm[1] + Lq[1]) / 2], M.rho]
    ];
    const x = Math.min(m.hg, G), y = Math.min(m.ag, G);
    // issue jugee dans l'onglet Scores : le favori du MODELE
    const issM = issueFavorite(grilleScores(Lm[0], Lm[1], M.rho));
    variantes.forEach(([L, rho], k) => {
      const P = grilleScores(L[0], L[1], rho);
      S[k].ll -= Math.log(Math.max(P[x][y], 1e-12));
      const mo = mode(P);
      if (mo[0] === m.hg && mo[1] === m.ag) S[k].mode++;
      const mi = mode(P, issueFavorite(P));
      if (mi[0] === m.hg && mi[1] === m.ag) S[k].modeIssue++;
      const mm = mode(P, issM);
      if (mm[0] === m.hg && mm[1] === m.ag) S[k].modeIssueM++;
      S[k].p11 += P[1][1]; S[k].p10 += P[1][0]; S[k].p00 += P[0][0];
    });
    if (m.hg === 1 && m.ag === 1) reel11++;
    if (m.hg === 1 && m.ag === 0) reel10++;
    if (m.hg === 0 && m.ag === 0) reel00++;
    nDiv++;
  }
  n += nDiv;
  console.log(`${div.padEnd(4)} ${nDiv} matchs évalués`);
}

console.log(`\n${n} matchs, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
console.log("variante                 │ log-loss score │ exact mode │ exact dans son issue │ exact dans l'issue du MODELE");
console.log("─".repeat(92));
const ref = S[0].ll / n;
S.forEach((s, k) => {
  const ll = s.ll / n;
  console.log(`${NOMS[k].padEnd(24)} │ ${ll.toFixed(4)} (${(ref - ll >= 0 ? "+" : "") + (ref - ll).toFixed(4)}) │`
    + `  ${(100 * s.mode / n).toFixed(1).padStart(5)} %  │      ${(100 * s.modeIssue / n).toFixed(1).padStart(5)} %        │      ${(100 * s.modeIssueM / n).toFixed(1).padStart(5)} %`);
});
console.log("\nCalibration des scores fréquents (probabilité moyenne annoncée contre fréquence réelle) :");
console.log(`  réel             1-1 ${(100 * reel11 / n).toFixed(1)} %   1-0 ${(100 * reel10 / n).toFixed(1)} %   0-0 ${(100 * reel00 / n).toFixed(1)} %`);
S.forEach((s, k) => console.log(`  ${NOMS[k].padEnd(22)} 1-1 ${(100 * s.p11 / n).toFixed(1)} %   1-0 ${(100 * s.p10 / n).toFixed(1)} %   0-0 ${(100 * s.p00 / n).toFixed(1)} %`));
