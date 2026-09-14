/* Associe les équipes de l'API football-data.org à nos noms football-data.co.uk.

   Apparier sur les noms est dangereux : le test a produit « Athletic » (Bilbao) associé
   à « Ath Madrid ». Attribuer un résultat à la mauvaise équipe corromprait le modèle en
   silence. On n'utilise donc pas du tout les noms.

   Méthode : chaque équipe possède une signature de résultats — l'ensemble des
   « date | buts marqués | buts encaissés » de ses matchs joués. Cette signature est
   quasi unique et identique dans les deux sources. On apparie par recouvrement maximal,
   et on n'accepte qu'au-dessus d'un seuil de preuves.

   Sortie : donnees/equipes-api.json   { division: { idApi: "Nom chez nous" } }

   Usage : FOOTBALL_DATA_TOKEN=... node outils/associer-equipes.mjs                     */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lireResultats } from "./modele.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOSSIER = join(RACINE, "donnees");
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) { console.error("FOOTBALL_DATA_TOKEN manquant."); process.exit(1); }

/* Compétitions de l'API présentes dans nos données */
export const CORRESPONDANCE = {
  PL: "E0", ELC: "E1", FL1: "F1", BL1: "D1", SA: "I1", DED: "N1", PPL: "P1", PD: "SP1"
};
const MIN_PREUVES = 2;          // nombre minimal de résultats communs pour valider

function codeSaison() {
  const n = new Date();
  let a = n.getUTCFullYear() % 100;
  if (n.getUTCMonth() < 6) a -= 1;
  return String(a).padStart(2, "0") + String((a + 1) % 100).padStart(2, "0");
}
const iso = ms => new Date(ms).toISOString().slice(0, 10);

async function api(chemin) {
  const r = await fetch("https://api.football-data.org/v4" + chemin, {
    headers: { "X-Auth-Token": TOKEN }, signal: AbortSignal.timeout(30000)
  });
  const j = await r.json();
  if (r.status === 429 || (j.errorCode && /limit/i.test(String(j.message || "")))) {
    const attente = +((String(j.message || "").match(/(\d+)\s*second/) || [])[1] || 60);
    await new Promise(t => setTimeout(t, (attente + 2) * 1000));
    return api(chemin);
  }
  if (j.errorCode) throw new Error(j.message);
  await new Promise(t => setTimeout(t, 6500));       // 10 appels par minute au maximum
  return j;
}

const saison = codeSaison();
const anneeApi = new Date().getUTCFullYear() - (new Date().getUTCMonth() < 6 ? 1 : 0);
const table = {};
let totalOk = 0, totalRate = 0;

for (const [code, div] of Object.entries(CORRESPONDANCE)) {
  /* ── signatures côté football-data.co.uk ── */
  let ms = [];
  try {
    const t = await fetch(`https://www.football-data.co.uk/mmz4281/${saison}/${div}.csv`,
      { signal: AbortSignal.timeout(30000) }).then(r => r.ok ? r.text() : null);
    if (t) ms = lireResultats(t);
  } catch { }
  if (!ms.length) { console.log(`${div.padEnd(4)} aucun résultat local, ignoré`); continue; }

  const sigNous = {};
  for (const m of ms) {
    (sigNous[m.h] ||= new Set()).add(`${iso(m.d)}|${m.hg}|${m.ag}`);
    (sigNous[m.a] ||= new Set()).add(`${iso(m.d)}|${m.ag}|${m.hg}`);
  }

  /* ── signatures côté API ── */
  let matchs;
  try { matchs = (await api(`/competitions/${code}/matches?season=${anneeApi}`)).matches; }
  catch (e) { console.log(`${div.padEnd(4)} API indisponible : ${e.message}`); continue; }

  const sigApi = {}, nomApi = {};
  for (const m of matchs) {
    if (m.status !== "FINISHED" || m.score.fullTime.home == null) continue;
    const d = m.utcDate.slice(0, 10), h = m.homeTeam.id, a = m.awayTeam.id;
    nomApi[h] = m.homeTeam.shortName || m.homeTeam.name;
    nomApi[a] = m.awayTeam.shortName || m.awayTeam.name;
    (sigApi[h] ||= new Set()).add(`${d}|${m.score.fullTime.home}|${m.score.fullTime.away}`);
    (sigApi[a] ||= new Set()).add(`${d}|${m.score.fullTime.away}|${m.score.fullTime.home}`);
  }

  /* ── appariement par recouvrement, du plus sûr au moins sûr ── */
  const paires = [];
  for (const id of Object.keys(sigApi))
    for (const nom of Object.keys(sigNous)) {
      let inter = 0;
      for (const x of sigApi[id]) if (sigNous[nom].has(x)) inter++;
      // une date peut différer d'un jour selon le fuseau : on tolère ce décalage
      if (!inter) {
        for (const x of sigApi[id]) {
          const [d, g, c] = x.split("|");
          const v = new Date(d + "T00:00:00Z");
          for (const dec of [-1, 1]) {
            const alt = new Date(v.getTime() + dec * 864e5).toISOString().slice(0, 10);
            if (sigNous[nom].has(`${alt}|${g}|${c}`)) { inter++; break; }
          }
        }
      }
      if (inter >= MIN_PREUVES) paires.push({ id, nom, inter });
    }
  paires.sort((a, b) => b.inter - a.inter);

  const prisId = new Set(), prisNom = new Set();
  table[div] = {};
  for (const p of paires) {
    if (prisId.has(p.id) || prisNom.has(p.nom)) continue;
    table[div][p.id] = p.nom;
    prisId.add(p.id); prisNom.add(p.nom);
  }
  const manquants = Object.keys(sigApi).filter(id => !prisId.has(id));
  totalOk += prisId.size; totalRate += manquants.length;
  console.log(`${div.padEnd(4)} ${String(prisId.size).padStart(2)} équipes associées`
    + (manquants.length ? `, ${manquants.length} en échec : ${manquants.map(i => nomApi[i]).join(", ")}` : ""));
}

/* ── fusion avec la table existante : on ne perd jamais une association acquise ── */
const chemin = join(DOSSIER, "equipes-api.json");
let ancien = {};
if (existsSync(chemin)) { try { ancien = JSON.parse(readFileSync(chemin, "utf8")); } catch { } }
for (const div of Object.keys(table)) table[div] = { ...(ancien[div] || {}), ...table[div] };
for (const div of Object.keys(ancien)) if (!table[div]) table[div] = ancien[div];

writeFileSync(chemin, JSON.stringify(table, null, 1), "utf8");
const total = Object.values(table).reduce((t, o) => t + Object.keys(o).length, 0);
console.log(`\n${totalOk} associations cette fois, ${totalRate} en échec.`);
console.log(`Table complète : ${total} équipes sur ${Object.keys(table).length} championnats.`);
console.log("Les équipes en échec le seront tant qu'elles n'auront pas joué 2 matchs ;");
console.log("relancer ce script plus tard complètera la table sans rien perdre.");
