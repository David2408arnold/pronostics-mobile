/* Remplit l'onglet Résultats avec les journées déjà jouées.

   Règle non négociable : pour chaque match, le modèle n'est ajusté que sur les rencontres
   ANTÉRIEURES à sa date. Sans cela, on obtiendrait une précision flatteuse et fausse.
   Les entrées produites ici sont marquées « reconstruit » : ce sont des pronostics
   recalculés après coup, pas des pronostics qui ont été publiés à l'avance.

   Usage : node outils/retrospectif.mjs [nombre_de_jours]   (défaut : 21)              */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lireResultats, ajusterMixte, lambdas, lambdasMarche, grille, marches, sansMarge, CHAMPIONNATS } from "./modele.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOSSIER = join(RACINE, "donnees");
const BASE = "https://www.football-data.co.uk";
const SUIVIS = ["F1", "F2", "E0", "E1", "E2", "E3", "EC", "SP1", "SP2", "I1", "I2", "D1", "D2",
  "N1", "B1", "P1", "T1", "G1", "SC0", "SC1", "SC2", "SC3"];
const NB_SAISONS = 3, DEMI_VIE = 180, REGUL = 2.5, MIN_MATCHS_FIABLE = 5;
const JOURS = Math.max(1, +(process.argv[2] || 21));

const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

function codeSaison(dec) {
  const n = new Date();
  let a = n.getUTCFullYear() % 100;
  if (n.getUTCMonth() < 6) a -= 1;
  a -= dec;
  return String(a).padStart(2, "0") + String((a + 1) % 100).padStart(2, "0");
}
async function telecharger(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "pronostics-mobile/1.0" }, signal: AbortSignal.timeout(30000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

console.log(`Reconstruction des ${JOURS} derniers jours\n`);
const saisons = Array.from({ length: NB_SAISONS }, (_, i) => codeSaison(i));
const limite = Date.now() - JOURS * 864e5;

const sortie = [];
for (const div of SUIVIS) {
  const brut = [];
  for (const s of saisons) {
    const t = await telecharger(`${BASE}/mmz4281/${s}/${div}.csv`);
    if (t) brut.push(...lireResultats(t));
  }
  const vus = new Set(), ms = [];
  for (const m of brut.sort((a, b) => a.d - b.d)) {
    const k = m.d + "|" + m.h + "|" + m.a;
    if (!vus.has(k)) { vus.add(k); ms.push(m); }
  }
  if (ms.length < 150) { console.log(`${div.padEnd(4)} ignoré (${ms.length} matchs)`); continue; }

  // journées à reconstruire
  const jours = [...new Set(ms.filter(m => m.d >= limite).map(m => iso(m.d)))].sort();
  if (!jours.length) { console.log(`${div.padEnd(4)} aucune journée récente`); continue; }

  let produits = 0;
  for (const jour of jours) {
    const t0 = Date.parse(jour + "T00:00:00Z");
    const passe = ms.filter(m => m.d < t0);                 // strictement antérieur
    if (passe.length < 150) continue;
    const M = ajusterMixte(passe, { demiVie: DEMI_VIE, regul: REGUL, ref: t0, iters: 80 });
    for (const m of ms.filter(x => iso(x.d) === jour)) {
      const L = lambdas(M, m.h, m.a);
      if (!L) continue;
      const P = grille(L[0], L[1], M.rho, 10), mk = marches(P);
      const poidsMin = Math.min(M.wn[M.ix[m.h]], M.wn[M.ix[m.a]]);
      const cons = (m.oh && m.od && m.oa) ? sansMarge([m.oh, m.od, m.oa]) : null;
      const issueReelle = m.hg > m.ag ? "1" : m.hg === m.ag ? "N" : "2";
      const probas = [["1", mk.H], ["N", mk.D], ["2", mk.A]];
      const issuePrevue = probas.reduce((x, y) => y[1] > x[1] ? y : x)[0];
      const issueMarche = cons
        ? [["1", cons[0]], ["N", cons[1]], ["2", cons[2]]].reduce((x, y) => y[1] > x[1] ? y : x)[0]
        : null;
      const prevu = mk.scores[0] ? mk.scores[0][0] : null;
      const reel = `${m.hg}-${m.ag}`;
      sortie.push({
        d: jour, div, nom: CHAMPIONNATS[div] || div, h: m.h, a: m.a,
        fiable: poidsMin >= MIN_MATCHS_FIABLE, poids: r2(poidsMin),
        pm: [r3(mk.H), r3(mk.D), r3(mk.A)],
        pq: cons ? [r3(cons[0]), r3(cons[1]), r3(cons[2])] : null,
        ...(() => {
          const ouv = m.oo && m.ou ? sansMarge([m.oo, m.ou]) : null;
          const Lq = cons && ouv ? lambdasMarche([cons[0], cons[1], cons[2], ouv[0]], M.rho) : null;
          return Lq ? { lHm: r2(Lq[0]), lAm: r2(Lq[1]) } : {};
        })(),
        prevu, reel, lH: r2(L[0]), lA: r2(L[1]), butsReels: m.hg + m.ag,
        issuePrevue, issueReelle, issueMarche,
        pIssueReelle: r3(probas.find(x => x[0] === issueReelle)[1]),
        exact: prevu === reel,
        okIssue: issuePrevue === issueReelle,
        okMarche: issueMarche ? issueMarche === issueReelle : null,
        reconstruit: true
      });
      produits++;
    }
  }
  console.log(`${div.padEnd(4)} ${String(produits).padStart(4)} matchs reconstruits sur ${jours.length} journées`);
}

/* ─── fusion avec l'existant ─── */
const chemin = join(DOSSIER, "resultats.json");
let res = { maj: null, bilan: null, matchs: [] };
if (existsSync(chemin)) { try { res = JSON.parse(readFileSync(chemin, "utf8")); } catch { } }
const cles = new Set(res.matchs.map(x => `${x.d}|${x.h}|${x.a}`));
let ajoutes = 0;
for (const x of sortie) {
  const k = `${x.d}|${x.h}|${x.a}`;
  if (cles.has(k)) {
    // un vrai pronostic publié à l'avance prime toujours ; on ne lui ajoute que les buts
    // attendus du marché s'il ne les avait pas, sans toucher au reste
    const e = res.matchs.find(z => `${z.d}|${z.h}|${z.a}` === k);
    if (e && e.lHm == null && x.lHm != null) { e.lHm = x.lHm; e.lAm = x.lAm; }
    continue;
  }
  cles.add(k); res.matchs.push(x); ajoutes++;
}
res.matchs.sort((x, y) => (y.d + y.h).localeCompare(x.d + x.h));
res.matchs = res.matchs.slice(0, 400);

const juges = res.matchs.filter(x => x.fiable);
const avecMarche = juges.filter(x => x.okMarche !== null);
res.bilan = {
  n: juges.length,
  exact: juges.filter(x => x.exact).length,
  okIssue: juges.filter(x => x.okIssue).length,
  okMarche: avecMarche.filter(x => x.okMarche).length,
  nMarche: avecMarche.length,
  erreurButs: juges.length ? r3(juges.reduce((t, x) => t + Math.abs((x.lH + x.lA) - x.butsReels), 0) / juges.length) : null,
  erreurEcart: juges.length ? r3(juges.reduce((t, x) => {
    const [ph, pa] = x.prevu.split("-").map(Number), [rh, ra] = x.reel.split("-").map(Number);
    return t + Math.abs((ph - pa) - (rh - ra));
  }, 0) / juges.length) : null,
  depuis: juges.length ? juges[juges.length - 1].d : null
};
res.maj = new Date().toISOString();
writeFileSync(chemin, JSON.stringify(res), "utf8");

const B = res.bilan;
console.log(`\n${ajoutes} matchs ajoutés · ${B.n} jugés au total`);
console.log(`   issue correcte      : ${(100 * B.okIssue / B.n).toFixed(1)} %`
  + (B.nMarche ? `   (marché : ${(100 * B.okMarche / B.nMarche).toFixed(1)} %)` : ""));
console.log(`   score exact         : ${(100 * B.exact / B.n).toFixed(1)} %`);
console.log(`   erreur sur le total : ${B.erreurButs} buts en moyenne`);
console.log(`   erreur sur l'écart  : ${B.erreurEcart} buts en moyenne`);
