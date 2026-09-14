/* Construction quotidienne des données de l'application.
   Télécharge résultats + matchs à venir depuis football-data.co.uk, estime le modèle
   par championnat, calcule les probabilités et les marges, met à jour le suivi des signaux.

   Usage :  node outils/construire.mjs
   Sortie :  donnees/jour.json  donnees/forces.json  donnees/historique.json          */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lireResultats, lireFixtures, ajuster, ajusterMixte, lambdas, grille, marches,
  sansMarge, marge, apparier, CHAMPIONNATS, NOMS_BOOKS, lambdasMarche
} from "./modele.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOSSIER = join(RACINE, "donnees");
const BASE = "https://www.football-data.co.uk";

/* Championnats suivis. Ajouter un code ici suffit à l'inclure dans l'application. */
const SUIVIS = ["F1", "F2", "E0", "E1", "E2", "E3", "EC", "SP1", "SP2", "I1", "I2", "D1", "D2",
  "N1", "B1", "P1", "T1", "G1", "SC0", "SC1", "SC2", "SC3"];
const NB_SAISONS = 3;          // saison en cours + 2 précédentes (au-delà, la pondération temporelle annule l'apport)
/* Seuil de signal. Mesure faite sur 6 050 matchs (outils/calibrer.mjs) : le poids optimal
   du modèle face au consensus du marché est 0 — le modèle n'apporte aucune information que
   le prix ne contient déjà. Les signaux sont donc calculés sur la probabilité du MARCHÉ
   (cotes moyennes, marge retirée) confrontée à la MEILLEURE cote disponible. L'avantage
   mesuré est celui de la prise de prix, pas celui d'une prédiction supérieure. */
const SEUIL_SIGNAL = 0.02;     // marge minimale, sur la probabilité de marché
const DEMI_VIE = 180;
const REGUL = 2.5;
const MIN_MATCHS_FIABLE = 5;   // matchs pondérés minimum par équipe
const PROBA_MIN_G = 0.10;      // issues moins probables : estimation de marché non fiable

/* ─────────── utilitaires ─────────── */
function codeSaison(dec) {
  const n = new Date();
  let a = n.getUTCFullYear() % 100;
  if (n.getUTCMonth() < 6) a -= 1;          // avant juillet, on est encore dans la saison précédente
  a -= dec;
  return String(a).padStart(2, "0") + String((a + 1) % 100).padStart(2, "0");
}
async function telecharger(url, essais = 3) {
  for (let i = 0; i < essais; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "pronostics-mobile/1.0" }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      if (i === essais - 1) { console.warn("  ! échec " + url + " : " + e.message); return null; }
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
const r2 = x => x == null ? null : Math.round(x * 100) / 100;

/* ─────────── 1. téléchargement ─────────── */
console.log("1. Téléchargement des résultats");
const saisons = Array.from({ length: NB_SAISONS }, (_, i) => codeSaison(i));
console.log("   saisons : " + saisons.join(", "));
const resultats = {};           // code championnat -> matchs
let nbFichiers = 0;
for (const div of SUIVIS) {
  resultats[div] = [];
  for (const s of saisons) {
    const txt = await telecharger(`${BASE}/mmz4281/${s}/${div}.csv`);
    if (!txt) continue;
    const ms = lireResultats(txt).filter(m => m.div === div || !m.div);
    if (ms.length) { resultats[div].push(...ms); nbFichiers++; }
  }
  if (resultats[div].length) console.log(`   ${div.padEnd(4)} ${String(resultats[div].length).padStart(5)} matchs`);
}
console.log(`   ${nbFichiers} fichiers, ${Object.values(resultats).flat().length} matchs au total`);

/* ─────────── 1 bis. résultats récents via l'API ─────────── */
/* Les CSV de football-data.co.uk accusent 3 à 6 jours de retard : mesuré le 12/09/2026,
   la Ligue 1 s'arrêtait au 06/09. L'API football-data.org publie les scores environ
   3 h 30 après le coup de sifflet. On complète donc les CSV avec elle.
   Les équipes sont associées par signature de résultats, jamais par leur nom :
   voir outils/associer-equipes.mjs. */
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_DIV = { PL: "E0", ELC: "E1", FL1: "F1", BL1: "D1", SA: "I1", DED: "N1", PPL: "P1", PD: "SP1" };
let ajoutsApi = 0, ignoresApi = 0;
let recents = null;                 // rencontres renvoyees par l'API, portee module

if (!TOKEN) {
  console.log("1 bis. FOOTBALL_DATA_TOKEN absent, on s'en tient aux CSV");
} else {
  console.log("1 bis. Résultats récents via l'API");
  let assoc = {};
  const cheminAssoc = join(DOSSIER, "equipes-api.json");
  if (existsSync(cheminAssoc)) { try { assoc = JSON.parse(readFileSync(cheminAssoc, "utf8")); } catch { } }

  const dISO = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const depuis = dISO(9);
  /* On interroge compétition par compétition, et non l'endpoint global /matches :
     mesuré le 12/09/2026, ce dernier accuse un jour de retard et omettait 27 matchs
     du jour même, dont Chelsea 2-2 Hull City. Huit appels par exécution, pour une
     limite de dix par minute. */
  const anneeApi = new Date().getUTCFullYear() - (new Date().getUTCMonth() < 6 ? 1 : 0);
  recents = [];
  /* Limite du palier gratuit : 10 appels par minute, partagés avec associer-equipes.mjs.
     Espacer de 700 ms ne suffisait pas : 5 championnats sur 8 étaient refusés à chaque
     exécution et leurs scores n'arrivaient jamais. On espace donc de 6,5 s, et si l'API
     impose malgré tout une pause (« Wait N seconds »), on attend puis on réessaie. */
  const pause = ms => new Promise(t => setTimeout(t, ms));
  for (const code of Object.keys(API_DIV)) {
    let fait = false;
    for (let essai = 1; essai <= 3 && !fait; essai++) {
      try {
        const r = await fetch(`https://api.football-data.org/v4/competitions/${code}/matches?season=${anneeApi}`,
          { headers: { "X-Auth-Token": TOKEN }, signal: AbortSignal.timeout(30000) });
        const j = await r.json();
        if (j.errorCode || r.status === 429) {
          const attente = +((String(j.message || "").match(/(\d+)\s*second/) || [])[1] || 60);
          if (essai < 3 && /limit/i.test(String(j.message || "")) ) {
            console.log(`   … ${code} : limite de débit, pause de ${attente + 2} s`);
            await pause((attente + 2) * 1000);
            continue;
          }
          throw new Error(j.message || "HTTP " + r.status);
        }
        recents.push(...(j.matches || []).filter(m => m.utcDate.slice(0, 10) >= depuis));
        fait = true;
      } catch (e) {
        if (essai === 3) console.log(`   ! ${code} indisponible : ${e.message}`);
        else await pause(5000);
      }
    }
    await pause(6500);
  }
  if (!recents.length) { recents = null; console.log("   ! aucune donnée API, on continue sans"); }

  if (recents) {
    for (const div of SUIVIS) {
      const connus = new Set(resultats[div].map(m => `${iso(m.d)}|${m.h}|${m.a}`));
      for (const m of recents) {
        if (m.status !== "FINISHED" || m.score.fullTime.home == null) continue;
        const d = API_DIV[m.competition.code];
        if (d !== div) continue;
        const t = assoc[div] || {};
        const h = t[m.homeTeam.id], a = t[m.awayTeam.id];
        if (!h || !a) { ignoresApi++; continue; }          // association inconnue : on n'invente rien
        const jour = Date.parse(m.utcDate.slice(0, 10) + "T00:00:00Z");
        // le CSV peut dater le match de la veille : on teste les trois jours
        const deja = [-1, 0, 1].some(k => connus.has(`${iso(jour + k * 864e5)}|${h}|${a}`));
        if (deja) continue;
        resultats[div].push({
          d: jour, div, h, a, hg: m.score.fullTime.home, ag: m.score.fullTime.away,
          oh: null, od: null, oa: null, ht: null, at: null, htc: null, atc: null, source: "api"
        });
        connus.add(`${iso(jour)}|${h}|${a}`);
        ajoutsApi++;
      }
    }
    console.log(`   ${ajoutsApi} résultats ajoutés que les CSV n'avaient pas encore`
      + (ignoresApi ? `, ${ignoresApi} ignorés faute d'association` : ""));
  }
}

/* Rencontres déjà jouées : on les marque pour que l'application ne les présente pas
   comme à venir, avec des cotes sur lesquelles il est trop tard pour miser. */
const joues = new Map();
if (TOKEN) {
  const assocJ = (() => {
    const c = join(DOSSIER, "equipes-api.json");
    try { return existsSync(c) ? JSON.parse(readFileSync(c, "utf8")) : {}; } catch { return {}; }
  })();
  for (const m of recents || []) {
    const div = API_DIV[m.competition.code];
    if (!div || m.status === "TIMED" || m.status === "SCHEDULED") continue;
    const t = assocJ[div] || {};
    const h = t[m.homeTeam.id], a = t[m.awayTeam.id];
    if (!h || !a) continue;
    joues.set(`${div}|${h}|${a}`, {
      statut: m.status,
      // champ distinct : « score » est déjà le score pronostiqué
      scoreReel: m.score.fullTime.home != null ? `${m.score.fullTime.home}-${m.score.fullTime.away}` : null
    });
  }
  console.log(`   ${joues.size} rencontres deja jouees ou en cours reperees`);
}

console.log("2. Téléchargement des matchs à venir");
const brut = await telecharger(`${BASE}/fixtures.csv`);
if (!brut) { console.error("ERREUR : fixtures.csv indisponible, arrêt sans modifier les données existantes."); process.exit(1); }
const fixtures = lireFixtures(brut);
console.log(`   ${fixtures.length} rencontres annoncées`);

/* ─────────── 2. estimation par championnat ─────────── */
console.log("3. Estimation des modèles");
const modeles = {}, forces = {}, infos = {};
for (const div of SUIVIS) {
  const ms = resultats[div];
  if (!ms || ms.length < 150) { console.log(`   ${div.padEnd(4)} ignoré (${ms ? ms.length : 0} matchs, trop peu)`); continue; }
  const M = ajusterMixte(ms, { demiVie: DEMI_VIE, regul: REGUL });
  modeles[div] = M;
  const auj = Date.now();
  infos[div] = {
    nom: CHAMPIONNATS[div] || div, matchs: M.n, equipes: M.teams.length,
    buts: r3(M.c), domicile: r3(M.g), rho: r3(M.rho), dernier: iso(M.ref),
    // un championnat couvert par l'API a des resultats du jour ; les autres
    // dependent des CSV, publies deux fois par semaine seulement
    api: Object.values(API_DIV).includes(div),
    retardJours: Math.max(0, Math.round((auj - M.ref) / 864e5))
  };
  forces[div] = {
    nom: CHAMPIONNATS[div] || div,
    equipes: M.teams.map(t => {
      const i = M.ix[t];
      return { nom: t, att: r3(M.att[i]), def: r3(M.def[i]), poids: r3(M.wn[i]), indice: r3(M.att[i] / M.def[i]) };
    }).sort((a, b) => b.indice - a.indice)
  };
  console.log(`   ${div.padEnd(4)} ${String(M.n).padStart(5)} matchs, ${M.teams.length} équipes, domicile ×${M.g.toFixed(2)}`);
}

/* ─────────── 3. probabilités des matchs à venir ─────────── */
console.log("4. Calcul des probabilités");
const matchs = [];
let ignores = 0;
for (const f of fixtures) {
  const M = modeles[f.div];
  if (!M) { ignores++; continue; }
  const h = apparier(f.h, M.teams), a = apparier(f.a, M.teams);
  if (!h || !a) { ignores++; continue; }
  const L = lambdas(M, h, a);
  const mk = marches(grille(L[0], L[1], M.rho, 10));
  const poidsMin = Math.min(M.wn[M.ix[h]], M.wn[M.ix[a]]);

  // consensus du marché : cotes moyennes débarrassées de la marge — c'est l'estimateur de référence
  let cons = null;
  if (f.avgH && f.avgD && f.avgA) { const p = sansMarge([f.avgH, f.avgD, f.avgA]); cons = { H: r3(p[0]), D: r3(p[1]), A: r3(p[2]) }; }
  let consOU = null;
  if (f.avgO && f.avgU) { const p = sansMarge([f.avgO, f.avgU]); consOU = { O: r3(p[0]), U: r3(p[1]) }; }

  // Un signal compare la MEILLEURE cote disponible à la probabilité du marché.
  // La marge du modèle est conservée à titre indicatif, jamais pour classer.
  const signaux = [];
  // il faut au moins deux bookmakers cotés pour parler de meilleur prix.
  // Et on écarte les issues sous 10 % : la mesure de calibration montre que le marché y
  // reste surestimé d'environ 2 points, ce qui fabriquerait des avantages inexistants.
  const MIN_BOOKS = 2, PROBA_MIN = PROBA_MIN_G;
  const candidats = [
    ["1", cons && cons.H, mk.H, f.maxH, f.nb1x2],
    ["N", cons && cons.D, mk.D, f.maxD, f.nb1x2],
    ["2", cons && cons.A, mk.A, f.maxA, f.nb1x2],
    ["+2,5 buts", consOU && consOU.O, mk.o25, f.maxO, f.nbOu],
    ["-2,5 buts", consOU && consOU.U, 1 - mk.o25, f.maxU, f.nbOu]
  ];
  for (const [sel, pMarche, pModele, cote, nbBooks] of candidats) {
    if (!cote || !pMarche || nbBooks < MIN_BOOKS || pMarche < PROBA_MIN) continue;
    const mMarche = marge(pMarche, cote);
    if (mMarche >= SEUIL_SIGNAL)
      signaux.push({ sel, p: r3(pMarche), pModele: r3(pModele), cote: r2(cote), marge: r3(mMarche), margeModele: r3(marge(pModele, cote)) });
  }
  signaux.sort((x, y) => y.marge - x.marge);

  // meilleur écart du match, même sous le seuil : permet d'afficher un classement honnête
  let meilleur = null;
  for (const [sel, pMarche, pModele, cote, nbBooks] of candidats) {
    if (!cote || !pMarche || nbBooks < MIN_BOOKS || pMarche < PROBA_MIN) continue;
    const mg = marge(pMarche, cote);
    if (!meilleur || mg > meilleur.marge)
      meilleur = { sel, p: r3(pMarche), pModele: r3(pModele), cote: r2(cote), marge: r3(mg) };
  }

  matchs.push({
    div: f.div, nom: CHAMPIONNATS[f.div] || f.div, d: iso(f.d), heure: f.heure,
    h: f.h, a: f.a,
    pH: r3(mk.H), pD: r3(mk.D), pA: r3(mk.A), pO: r3(mk.o25), pBtts: r3(mk.btts),
    lH: r2(L[0]), lA: r2(L[1]), score: mk.scores[0] ? mk.scores[0][0] : null,
    cH: r2(f.maxH), cD: r2(f.maxD), cA: r2(f.maxA), cO: r2(f.maxO), cU: r2(f.maxU), nbBooks: f.nb1x2,
    cons, consOU, fiable: poidsMin >= MIN_MATCHS_FIABLE, poids: r2(poidsMin),
    // buts attendus du marché : meilleurs que ceux du modèle pour le score exact
    ...(() => {
      const Lq = cons && consOU ? lambdasMarche([cons.H, cons.D, cons.A, consOU.O], M.rho) : null;
      return Lq ? { lHm: r2(Lq[0]), lAm: r2(Lq[1]) } : {};
    })(),
    parBook: f.parBook.map(c => c.map(x => r2(x))),
    ...(joues.get(`${f.div}|${h}|${a}`) || {}),
    signaux, meilleur
  });
}
matchs.sort((x, y) => (x.d + x.heure).localeCompare(y.d + y.heure));
console.log(`   ${matchs.length} rencontres exploitables, ${ignores} ignorées (championnat non suivi ou équipe inconnue)`);
console.log(`   ${matchs.reduce((s, m) => s + m.signaux.length, 0)} signaux au-dessus de ${(100 * SEUIL_SIGNAL).toFixed(0)} % de marge de marché`);

/* ─────────── 4. suivi honnête des signaux passés ─────────── */
console.log("5. Mise à jour du suivi des signaux");
const cheminHisto = join(DOSSIER, "historique.json");
let histo = { signaux: [], bilan: null };
if (existsSync(cheminHisto)) { try { histo = JSON.parse(readFileSync(cheminHisto, "utf8")); } catch { } }

// index des résultats connus, pour régler les signaux en attente
const resIdx = new Map();
for (const div of Object.keys(resultats))
  for (const m of resultats[div]) resIdx.set(`${iso(m.d)}|${m.h}|${m.a}`, m);

// a) enregistrer les nouveaux signaux du jour
const deja = new Set(histo.signaux.map(s => s.id));
let nouveaux = 0;
for (const m of matchs) {
  if (!m.fiable) continue;                       // on ne suit que les signaux jugés exploitables
  for (const s of m.signaux) {
    const id = `${m.d}|${m.h}|${m.a}|${s.sel}`;
    if (deja.has(id)) continue;
    histo.signaux.push({ id, d: m.d, div: m.div, match: `${m.h} - ${m.a}`, sel: s.sel, p: s.p, pModele: s.pModele, cote: s.cote, marge: s.marge, margeModele: s.margeModele, res: null, gain: null });
    deja.add(id); nouveaux++;
  }
}
// b) régler ceux dont le résultat est désormais connu
let regles = 0;
for (const s of histo.signaux) {
  if (s.res) continue;
  const [d, reste] = [s.d, s.match];
  const [h, a] = reste.split(" - ");
  const m = resIdx.get(`${d}|${h}|${a}`);
  if (!m) continue;
  let gagne;
  if (s.sel === "1") gagne = m.hg > m.ag;
  else if (s.sel === "N") gagne = m.hg === m.ag;
  else if (s.sel === "2") gagne = m.hg < m.ag;
  else if (s.sel === "+2,5 buts") gagne = m.hg + m.ag > 2.5;
  else if (s.sel === "-2,5 buts") gagne = m.hg + m.ag < 2.5;
  else continue;
  s.res = gagne ? "gagne" : "perdu";
  s.gain = r3(gagne ? s.cote - 1 : -1);
  s.score = `${m.hg}-${m.ag}`;
  regles++;
}
// c) bilan cumulé, à mise constante d'une unité
const clos = histo.signaux.filter(s => s.res);
const gain = clos.reduce((t, s) => t + s.gain, 0);
const gagnes = clos.filter(s => s.res === "gagne").length;
const moy = clos.length ? gain / clos.length : 0;
const sd = clos.length > 1 ? Math.sqrt(clos.reduce((t, s) => t + (s.gain - moy) ** 2, 0) / (clos.length - 1)) : 0;
const se = clos.length ? sd / Math.sqrt(clos.length) : 0;
histo.bilan = {
  proposes: histo.signaux.length, regles: clos.length, gagnes,
  mises: clos.length, gain: r3(gain),
  rendement: clos.length ? r3(gain / clos.length) : null,
  ic95: clos.length > 1 ? [r3(moy - 1.96 * se), r3(moy + 1.96 * se)] : null,
  depuis: histo.signaux.length ? histo.signaux.map(s => s.d).sort()[0] : null
};
console.log(`   ${nouveaux} nouveaux signaux, ${regles} réglés, ${clos.length} réglés au total`);
if (clos.length) console.log(`   rendement cumulé : ${(100 * gain / clos.length).toFixed(2)} % sur ${clos.length} paris`);

/* ─────────── 4 bis. archivage des pronostics et confrontation aux scores ─────────── */
console.log("6. Pronostics et scores reels");
const cheminPron = join(DOSSIER, "pronostics.json");
const cheminRes = join(DOSSIER, "resultats.json");
let pron = { attente: {} };
if (existsSync(cheminPron)) { try { pron = JSON.parse(readFileSync(cheminPron, "utf8")); } catch { } }
let res = { maj: null, bilan: null, matchs: [] };
if (existsSync(cheminRes)) { try { res = JSON.parse(readFileSync(cheminRes, "utf8")); } catch { } }

/* a) on enregistre le pronostic de chaque match a venir, une seule fois.
      Le premier pronostic fait foi : le reecrire la veille du match donnerait
      une precision flatteuse mais fausse. */
let archives = 0;
for (const m of matchs) {
  const cle = `${m.d}|${m.h}|${m.a}`;
  if (pron.attente[cle]) continue;
  pron.attente[cle] = {
    d: m.d, div: m.div, nom: m.nom, heure: m.heure, h: m.h, a: m.a,
    score: m.score, lH: m.lH, lA: m.lA, lHm: m.lHm, lAm: m.lAm,
    pH: m.pH, pD: m.pD, pA: m.pA,
    cons: m.cons, fiable: m.fiable, poids: m.poids, pose: new Date().toISOString().slice(0, 10)
  };
  archives++;
}

/* b) tout pronostic dont le resultat est connu rejoint l'historique des scores */
const dejaVus = new Set(res.matchs.map(x => `${x.d}|${x.h}|${x.a}`));
let confrontes = 0;
for (const [cle, p] of Object.entries(pron.attente)) {
  const vrai = resIdx.get(cle);
  if (!vrai) continue;
  delete pron.attente[cle];
  if (dejaVus.has(cle)) continue;
  const issueReelle = vrai.hg > vrai.ag ? "1" : vrai.hg === vrai.ag ? "N" : "2";
  const probas = [["1", p.pH], ["N", p.pD], ["2", p.pA]];
  const issuePrevue = probas.reduce((x, y) => y[1] > x[1] ? y : x)[0];
  const consProbas = p.cons ? [["1", p.cons.H], ["N", p.cons.D], ["2", p.cons.A]] : null;
  const issueMarche = consProbas ? consProbas.reduce((x, y) => y[1] > x[1] ? y : x)[0] : null;
  res.matchs.push({
    d: p.d, div: p.div, nom: p.nom, h: p.h, a: p.a, fiable: p.fiable,
    prevu: p.score, reel: `${vrai.hg}-${vrai.ag}`, poids: p.poids,
    pm: [r3(p.pH), r3(p.pD), r3(p.pA)],
    pq: p.cons ? [r3(p.cons.H), r3(p.cons.D), r3(p.cons.A)] : null,
    lH: p.lH, lA: p.lA, lHm: p.lHm, lAm: p.lAm, butsReels: vrai.hg + vrai.ag,
    issuePrevue, issueReelle, issueMarche,
    pIssueReelle: r3(probas.find(x => x[0] === issueReelle)[1]),
    exact: p.score === `${vrai.hg}-${vrai.ag}`,
    okIssue: issuePrevue === issueReelle,
    okMarche: issueMarche ? issueMarche === issueReelle : null,
    reconstruit: !!p.reconstruit
  });
  dejaVus.add(cle);
  confrontes++;
}

/* c) on garde les 400 derniers matchs, le bilan cumule reste complet */
res.matchs.sort((x, y) => (y.d + y.h).localeCompare(x.d + x.h));
res.matchs = res.matchs.slice(0, 400);

const juges = res.matchs.filter(x => x.fiable);
const compte = (f) => juges.filter(f).length;
const avecMarche = juges.filter(x => x.okMarche !== null);
res.bilan = {
  n: juges.length,
  exact: compte(x => x.exact),
  okIssue: compte(x => x.okIssue),
  okMarche: avecMarche.filter(x => x.okMarche).length,
  nMarche: avecMarche.length,
  erreurButs: juges.length
    ? r3(juges.reduce((t, x) => t + Math.abs((x.lH + x.lA) - x.butsReels), 0) / juges.length)
    : null,
  erreurEcart: juges.length
    ? r3(juges.reduce((t, x) => {
        const [ph, pa] = x.prevu.split("-").map(Number);
        const [rh, ra] = x.reel.split("-").map(Number);
        return t + Math.abs((ph - pa) - (rh - ra));
      }, 0) / juges.length)
    : null,
  depuis: juges.length ? juges[juges.length - 1].d : null
};
res.maj = new Date().toISOString();

writeFileSync(cheminPron, JSON.stringify(pron), "utf8");
writeFileSync(cheminRes, JSON.stringify(res), "utf8");
console.log(`   ${archives} pronostics archives, ${confrontes} confrontes aux scores`);
console.log(`   historique : ${res.bilan.n} matchs juges, issue correcte ${res.bilan.n ? (100 * res.bilan.okIssue / res.bilan.n).toFixed(1) : "-"} %`
  + (res.bilan.nMarche ? ` contre ${(100 * res.bilan.okMarche / res.bilan.nMarche).toFixed(1)} % pour le marche` : ""));
console.log(`   ${Object.keys(pron.attente).length} pronostics en attente de resultat`);

/* ─────────── 5. écriture ─────────── */
if (!existsSync(DOSSIER)) mkdirSync(DOSSIER, { recursive: true });
/* Âge des cotes. fixtures.csv ne porte aucun horodatage, et il liste encore des
   rencontres déjà jouées : ses cotes ont donc au moins un jour. On mesure l'âge
   réel en comparant à la construction précédente : tant que les cotes d'un match
   ne bougent pas, on conserve la date à laquelle on les a vues pour la première fois. */
const cheminJourPrec = join(DOSSIER, "jour.json");
let precedent = null;
if (existsSync(cheminJourPrec)) { try { precedent = JSON.parse(readFileSync(cheminJourPrec, "utf8")); } catch { } }
const cotesPrec = new Map();
for (const m of (precedent && precedent.matchs) || [])
  cotesPrec.set(`${m.div}|${m.h}|${m.a}`, { cH: m.cH, cD: m.cD, cA: m.cA, vues: m.cotesVues });
const maintenantISO = new Date().toISOString().slice(0, 16) + "Z";
for (const m of matchs) {
  const p = cotesPrec.get(`${m.div}|${m.h}|${m.a}`);
  const identiques = p && p.cH === m.cH && p.cD === m.cD && p.cA === m.cA;
  m.cotesVues = identiques && p.vues ? p.vues : maintenantISO;
}
const ages = matchs.map(m => (Date.now() - Date.parse(m.cotesVues)) / 36e5).filter(x => isFinite(x));
if (ages.length) {
  const moy = ages.reduce((a, b) => a + b, 0) / ages.length;
  console.log(`   age moyen des cotes : ${moy.toFixed(1)} h (max ${Math.max(...ages).toFixed(1)} h)`);
}

// classement des écarts les plus favorables, seuil atteint ou non
const classement = matchs
  .filter(m => m.fiable && m.meilleur)
  .map(m => ({ ...m.meilleur, h: m.h, a: m.a, nom: m.nom, d: m.d, heure: m.heure }))
  .sort((x, y) => y.marge - x.marge)
  .slice(0, 15);

const jour = {
  genere: new Date().toISOString(),
  seuil: SEUIL_SIGNAL, demiVie: DEMI_VIE, regul: REGUL, probaMin: PROBA_MIN_G,
  books: NOMS_BOOKS, ecartMediane: 1.08,
  championnats: infos,
  classement,
  matchs
};
/* Le champ « genere » change a chaque execution : ecrire sans regarder le reste
   produirait un commit toutes les 3 heures pour rien. On compare donc le contenu
   utile, horodatage exclu. */
const cheminJour = join(DOSSIER, "jour.json");
const sansHorodatage = o => { const c = { ...o }; delete c.genere; return JSON.stringify(c); };
let jourIdentique = false;
if (existsSync(cheminJour)) {
  try { jourIdentique = sansHorodatage(JSON.parse(readFileSync(cheminJour, "utf8"))) === sansHorodatage(jour); }
  catch { }
}
if (jourIdentique) console.log("   jour.json inchange, pas de reecriture");
else writeFileSync(cheminJour, JSON.stringify(jour), "utf8");
writeFileSync(join(DOSSIER, "forces.json"), JSON.stringify(forces), "utf8");
writeFileSync(cheminHisto, JSON.stringify(histo, null, 1), "utf8");

const ko = n => (n / 1024).toFixed(1) + " ko";
console.log("7. Écriture terminée");
console.log(`   jour.json        ${ko(JSON.stringify(jour).length)}`);
console.log(`   forces.json      ${ko(JSON.stringify(forces).length)}`);
console.log(`   historique.json  ${ko(JSON.stringify(histo).length)}`);
console.log(`   resultats.json   ${ko(JSON.stringify(res).length)}`);
console.log(`   pronostics.json  ${ko(JSON.stringify(pron).length)}`);
