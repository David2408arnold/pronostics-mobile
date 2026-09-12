/* Application mobile — pronostics du jour, écarts de prix et journal de paris.

   Les probabilités et les écarts sont précalculés chaque matin par outils/construire.mjs.
   Deux estimations coexistent, et leur statut n'est pas le même :

     • la probabilité de MARCHÉ (cotes moyennes, marge retirée par la méthode de la
       puissance) sert de référence ; c'est elle qui décide qu'un prix est intéressant ;
     • la probabilité du MODÈLE (Poisson bivarié Dixon-Coles) est affichée à titre
       d'information. Mesure faite sur 6 050 matchs : lui donner le moindre poids face au
       marché dégrade la prédiction. Elle ne déclenche donc jamais un signal.              */

const CLE = "pronos-mobile.v1";
const VERSION_APP = "v18";        // à garder aligné avec VERSION dans sw.js
const DEFAUT = { bank: 100000, cur: "FCFA", kf: 0.25, maxStake: 2, seuil: 2, perteMax: 50000, champs: [], operateur: "", margeOp: 8, avecDC: false };
let E = { set: { ...DEFAUT }, journal: [], marges: [] };
let JOUR = null, HISTO = null, SCORES = null;
let vue = "matchs", filtreJour = "tous", recherche = "";
let combine = [], tailleCombine = 4;
let FORCES = null;

/* ─────────── stockage ─────────── */
function charger() {
  try {
    const r = localStorage.getItem(CLE);
    if (r) {
      const o = JSON.parse(r);
      E.set = { ...DEFAUT, ...(o.set || {}) };
      E.journal = o.journal || [];
      E.marges = o.marges || [];
    }
  } catch { }
}
function sauver() { try { localStorage.setItem(CLE, JSON.stringify(E)); } catch { } }

/* ─────────── utilitaires ─────────── */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pc = (x, d = 0) => (100 * x).toFixed(d) + " %";
const arg = x => Math.round(x).toLocaleString("fr-FR") + " " + E.set.cur;
const f2 = x => Number(x).toFixed(2);
const sg = x => (x >= 0 ? "+" : "") + (100 * x).toFixed(1) + " %";
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const aujourdhui = () => new Date().toISOString().slice(0, 10);
function libJour(d) {
  if (d === aujourdhui()) return "Aujourd'hui";
  if (d === new Date(Date.now() + 864e5).toISOString().slice(0, 10)) return "Demain";
  const dt = new Date(d + "T12:00:00Z");
  return JOURS[dt.getUTCDay()] + " " + dt.getUTCDate();
}
/** Mise conseillée : Kelly fractionné sur la probabilité de marché, plafonné en % de bankroll. */
function mise(p, cote) {
  const k = cote > 1 ? Math.max(0, (p * cote - 1) / (cote - 1)) : 0;
  return Math.min(k * E.set.kf, E.set.maxStake / 100) * E.set.bank;
}
const margeDe = (p, cote) => p * cote - 1;
/** Comparaison souple : sans accents, sans casse, sans ponctuation.
    « munchen », « München » et « MUNCHEN » doivent tomber au même endroit. */
const norm = x => String(x || "").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/* ─────────── chargement des données ─────────── */
async function recuperer(reseauDabord) {
  const opt = reseauDabord ? { cache: "reload" } : {};
  const lire = async f => { try { const r = await fetch("donnees/" + f, opt); return r.ok ? await r.json() : null; } catch { return null; } };
  const [j, h, f, r] = await Promise.all([
    lire("jour.json"), lire("historique.json"), lire("forces.json"), lire("resultats.json")]);
  if (j) JOUR = j;
  if (h) HISTO = h;
  if (f) FORCES = f;
  if (r) SCORES = r;
  reglerAutomatiquement();
  majEntete(); rendre();
}
function majEntete() {
  if (JOUR) {
    const d = new Date(JOUR.genere), heures = Math.floor((Date.now() - d.getTime()) / 36e5);
    $("#maj").textContent = heures < 1 ? "à jour à l'instant"
      : heures < 24 ? `à jour il y a ${heures} h` : `à jour le ${d.toLocaleDateString("fr-FR")}`;
  } else $("#maj").textContent = "données indisponibles";
  const st = bilanJournal();
  $("#s-bank").textContent = arg(E.set.bank + st.gain);
  $("#s-res").innerHTML = st.n ? `<span class="${st.gain >= 0 ? "pos" : "neg"}">${st.gain >= 0 ? "+" : ""}${arg(st.gain)}</span>` : "bankroll";
}

/* ─────────── navigation ─────────── */
const ICONES = {
  matchs: '<path d="M3 6h18M3 12h18M3 18h12"/>',
  signaux: '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v5h-5"/>',
  combines: '<path d="M4 7h10M4 12h13M4 17h7"/><circle cx="19" cy="7" r="2"/><circle cx="20" cy="17" r="2"/>',
  scores: '<path d="M4 19V5m16 14V5"/><path d="M8 15l3-3 3 2 4-5"/><path d="M3 19h18"/>',
  journal: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  reglages: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'
};
const ONGLETS = [["matchs", "Matchs"], ["signaux", "Écarts"], ["combines", "Combinés"],
  ["scores", "Scores"], ["journal", "Journal"], ["reglages", "Réglages"]];
function batirNav() {
  $("#nav").innerHTML = ONGLETS.map(([id, lab]) =>
    `<button data-v="${id}" class="${id === vue ? "on" : ""}">
       <svg viewBox="0 0 24 24">${ICONES[id]}</svg><span>${lab}</span>
       ${id === "signaux" ? '<span class="pastille" id="pastille" hidden></span>' : ""}
     </button>`).join("");
  $("#nav").querySelectorAll("button").forEach(b => b.onclick = () => aller(b.dataset.v));
}
function aller(v) {
  vue = v;
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  document.querySelectorAll("section").forEach(s => s.classList.toggle("on", s.id === "v-" + v));
  $("#filtres").style.display = v === "matchs" ? "" : "none";
  $("#recherche-box").style.display = (v === "matchs" || v === "scores") ? "" : "none";
  $("#q").placeholder = v === "scores"
    ? "Rechercher une équipe dans l'historique" : "Rechercher une équipe ou un championnat";
  window.scrollTo(0, 0);
  rendre();
}

/* ─────────── sélection ─────────── */
function matchsVisibles() {
  if (!JOUR) return [];
  // une rencontre terminee n'a plus rien a faire dans la liste des matchs a venir
  let ms = JOUR.matchs.filter(m => m.d >= aujourdhui() && m.statut !== "FINISHED");
  if (E.set.champs.length) ms = ms.filter(m => E.set.champs.includes(m.div));
  const q = requete();
  if (q) {
    // une recherche porte sur toutes les journées : chercher une équipe et devoir
    // en plus deviner le bon jour n'aurait aucun sens
    const mots = q.split(" ").filter(Boolean);
    return ms.filter(m => {
      const champ = norm(m.h + " " + m.a + " " + m.nom);
      return mots.every(w => champ.includes(w));
    });
  }
  if (filtreJour !== "tous") ms = ms.filter(m => m.d === filtreJour);
  return ms;
}

/* Abréviations que tout le monde tape, mais qui n'apparaissent pas dans les noms officiels. */
const ABREVIATIONS = {
  psg: "paris sg", om: "marseille", ol: "lyon", asse: "st etienne", losc: "lille",
  ogcn: "nice", asm: "monaco", rcl: "lens", fcn: "nantes", srfc: "rennes",
  mu: "man united", manu: "man united", mufc: "man united", mcfc: "man city",
  lfc: "liverpool", cfc: "chelsea", afc: "arsenal", thfc: "tottenham", spurs: "tottenham",
  barca: "barcelona", fcb: "barcelona", atleti: "ath madrid", bayern: "bayern munich",
  bvb: "dortmund", juve: "juventus", milan: "milan", inter: "inter"
};
/** Recherche saisie, une fois les abréviations développées. */
function requete() {
  const q = norm(recherche);
  return ABREVIATIONS[q] || q;
}

/** Équipes du référentiel dont le nom correspond à la recherche, avec leur rang.
    Une équipe promue figure dans deux championnats : on ne garde que celui où elle
    a le plus de matchs pondérés, c'est-à-dire le plus récent. */
function equipesTrouvees() {
  const q = requete();
  if (!FORCES || q.length < 3) return [];
  const mots = q.split(" ").filter(Boolean), trouve = new Map();
  for (const [div, o] of Object.entries(FORCES))
    o.equipes.forEach((e, i) => {
      if (!mots.every(w => norm(e.nom).includes(w))) return;
      const ancien = trouve.get(e.nom);
      if (!ancien || e.poids > ancien.poids)
        trouve.set(e.nom, { ...e, div, champ: o.nom, rang: i + 1, total: o.equipes.length });
    });
  return [...trouve.values()].sort((a, b) => b.poids - a.poids).slice(0, 3);
}
function signauxVisibles() {
  const s = E.set.seuil / 100, out = [];
  for (const m of matchsVisibles()) {
    if (!m.fiable) continue;
    for (const x of m.signaux) if (x.marge >= s) out.push({ ...x, m });
  }
  return out.sort((a, b) => b.marge - a.marge);
}
function rendreFiltres() {
  if (!JOUR) return;
  if (recherche) { $("#filtres").style.display = "none"; return; }
  $("#filtres").style.display = vue === "matchs" ? "" : "none";
  const jours = [...new Set(JOUR.matchs.filter(m => m.d >= aujourdhui()).map(m => m.d))].sort();
  $("#filtres").innerHTML =
    `<button class="puce ${filtreJour === "tous" ? "on" : ""}" data-j="tous">Tous</button>` +
    jours.map(d => `<button class="puce ${filtreJour === d ? "on" : ""}" data-j="${d}">${libJour(d)}</button>`).join("");
  $("#filtres").querySelectorAll("button").forEach(b => b.onclick = () => { filtreJour = b.dataset.j; rendreFiltres(); rendreMatchs(); });
}

/* ─────────── vue Matchs ─────────── */
function rendreMatchs() {
  if (!JOUR) { $("#liste-matchs").innerHTML = `<div class="vide">Données non chargées.<br>Vérifie ta connexion puis rafraîchis.</div>`; return; }
  const ms = matchsVisibles();
  if (!ms.length) {
    $("#liste-matchs").innerHTML = (recherche ? enteteRecherche(ms) : "") + (recherche
      ? `<div class="vide">Aucune rencontre à venir pour « ${esc(recherche)} ».<br>
         <span style="font-size:12px">Les matchs paraissent 3 à 4 jours à l'avance : une équipe qui ne joue
         pas cette semaine n'apparaît pas ici.</span></div>`
      : `<div class="vide">Aucun match à venir pour ce filtre.<br>
         <span style="font-size:12px">Les rencontres paraissent quelques jours à l'avance.</span></div>`);
    return;
  }
  const s = E.set.seuil / 100;
  let html = recherche ? enteteRecherche(ms)
    : `<div class="note info" style="margin-bottom:12px">Sous chaque cote : la probabilité estimée par le modèle.
       Touche un match pour le détail et la comparaison avec le marché.</div>`;
  let jourCourant = "";
  ms.forEach(m => {
    if (m.d !== jourCourant) { jourCourant = m.d; html += `<h2>${libJour(m.d)}</h2>`; }
    const nSig = m.fiable ? m.signaux.filter(x => x.marge >= s).length : 0;
    const cell = (lab, p, c) => `<div class="cote"><span class="l">${lab}</span>
        <b>${c ? f2(c) : "—"}</b><span class="v">${pc(p)}</span></div>`;
    html += `<div class="match" data-i="${JOUR.matchs.indexOf(m)}">
      <div class="mt"><b>${esc(m.nom)}</b><span>${esc(m.heure)}</span>
        ${!m.fiable ? '<span class="tag t-warn">peu de données</span>' : ""}
        ${m.statut && m.statut !== "FINISHED" ? `<span class="tag t-neg">en cours${m.score ? " " + esc(m.score) : ""}</span>` : ""}
        ${nSig ? `<span class="tag t-pos" style="margin-left:auto">${nSig} signa${nSig > 1 ? "ux" : "l"}</span>` : ""}</div>
      <div class="eq"><span>${esc(m.h)}</span><span class="vs">contre</span><span>${esc(m.a)}</span></div>
      <div class="barre"><i class="b1" style="width:${100 * m.pH}%"></i><i class="bn" style="width:${100 * m.pD}%"></i><i class="b2" style="width:${100 * m.pA}%"></i></div>
      ${m.score ? `<div style="font-size:11.5px;color:var(--tx3);margin:-2px 0 7px">
        Score pronostiqué <b style="color:var(--tx2)">${esc(m.score)}</b>
        · buts attendus ${m.lH.toFixed(1)}–${m.lA.toFixed(1)}</div>` : ""}
      ${E.set.avecDC ? conseilDC(m) : ""}
      <div class="cotes">${cell("1", m.pH, m.cH)}${cell("Nul", m.pD, m.cD)}${cell("2", m.pA, m.cA)}</div>
    </div>`;
  });
  $("#liste-matchs").innerHTML = html;
  $("#liste-matchs").querySelectorAll(".match").forEach(c => c.onclick = () => ouvrirMatch(+c.dataset.i));
}

/** Double chance : on couvre deux issues sur trois. Les cotes de ce marché ne figurent
    dans aucune source disponible, mais le prix équitable se déduit directement des
    probabilités de marché — c'est exactement ce qu'il faut pour juger l'offre d'un
    opérateur, qui charge en général une marge plus lourde sur ce marché. */
/* [code, clés des probabilités de marché, clés des probabilités du modèle].
   Le libellé lisible vient de nomSelection(), qui nomme les équipes. */
const DC = [
  ["1X", ["H", "D"], ["pH", "pD"]],
  ["12", ["H", "A"], ["pH", "pA"]],
  ["X2", ["D", "A"], ["pD", "pA"]]
];
function doubleChance(m) {
  if (!m.cons) return "";
  return `<h2>Double chance</h2>
    <p style="font-size:12px;color:var(--tx2);margin:0 0 8px">Deux issues couvertes sur trois : ça passe
      beaucoup plus souvent, mais la cote est bien plus basse. Aucune source ne publie les cotes de ce
      marché — compare le prix équitable ci-dessous à celui de ton opérateur.</p>
    ${DC.map(([code, kc, km]) => {
      const pm = m.cons[kc[0]] + m.cons[kc[1]];
      const pmod = m[km[0]] + m[km[1]];
      return `<div class="lg">
        <span><b>${esc(nomSelection(m, code))}</b> <span class="tag t-mut">${code}</span>
          <br><span style="font-size:11.5px;color:var(--tx3)">
          marché ${pc(pm, 1)} · modèle ${pc(pmod, 1)}</span></span>
        <span style="text-align:right"><b>${f2(1 / pm)}</b><br>
          <span style="font-size:11px;color:var(--tx3)">${pm > 0.9 ? "rarement proposé" : "prix équitable"}</span></span></div>`;
    }).join("")}
    <p style="font-size:11.5px;color:var(--tx3);margin:8px 0 0">
      Si ton opérateur propose moins que ces cotes, la différence est sa marge. Sur la double chance
      elle dépasse souvent 10 %, parce que le marché paraît rassurant.</p>`;
}

/** Meilleur bookmaker par issue, et prix jugés non crédibles.
    Retourne { best:[i,i,i], suspect:[[bool]] } */
function analyseBooks(m) {
  const best = [null, null, null], suspect = [];
  if (!m.parBook) return { best, suspect };
  for (let k = 0; k < 3; k++) {
    const vals = m.parBook.map(c => c[k]).filter(x => x);
    if (!vals.length) continue;
    const t = vals.slice().sort((a, b) => a - b);
    const med = t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
    const plafond = (JOUR.ecartMediane || 1.08) * med;
    let bi = null, bv = 0;
    m.parBook.forEach((c, i) => {
      (suspect[i] = suspect[i] || [])[k] = !!c[k] && c[k] > plafond;
      if (c[k] && c[k] <= plafond && c[k] > bv) { bv = c[k]; bi = i; }
    });
    best[k] = bi;
  }
  return { best, suspect };
}
function tableauBooks(m) {
  if (!m.parBook || !JOUR.books) return "";
  const { best, suspect } = analyseBooks(m);
  const lignes = JOUR.books.map((nom, i) => {
    const c = m.parBook[i];
    if (!c || !c.some(x => x)) return "";
    const cel = k => {
      if (!c[k]) return `<span class="mut">—</span>`;
      if (suspect[i] && suspect[i][k]) return `<span class="mut" title="écartée">${f2(c[k])}<sup>*</sup></span>`;
      return best[k] === i ? `<b class="pos">${f2(c[k])}</b>` : f2(c[k]);
    };
    return `<div class="lg"><span>${esc(nom)}</span>
      <b style="min-width:132px;display:inline-flex;justify-content:space-between;gap:12px">
        <span>${cel(0)}</span><span>${cel(1)}</span><span>${cel(2)}</span></b></div>`;
  }).join("");
  const aStar = suspect.some(l => l && l.some(Boolean));
  return `<h2>Prix par bookmaker</h2>
    <p style="font-size:12px;color:var(--tx2);margin:0 0 8px">Six opérateurs européens, pris comme
      <b>référence de prix</b>. Aucun ne propose le mobile money en Côte d'Ivoire : sers-t'en pour juger
      la cote de ton propre opérateur, pas comme une liste où parier.</p>
    <div class="lg" style="border-bottom:1px solid var(--bd)"><span class="mut" style="font-size:11.5px">Bookmaker</span>
      <b style="min-width:132px;display:inline-flex;justify-content:space-between;gap:12px;font-size:11.5px;color:var(--tx3)">
        <span>1</span><span>N</span><span>2</span></b></div>
    ${lignes}
    ${aStar ? `<p style="font-size:11.5px;color:var(--tx3);margin:8px 0 0">
      * cote s'écartant de plus de 8 % de la médiane : écartée du calcul, probablement périmée.</p>` : ""}`;
}

/** Comparateur : l'utilisateur saisit les cotes de SON opérateur (Betclic, 1xBet, Akabet,
    Sportcash… peu importe, aucun n'est dans les données) et voit ce que cet opérateur
    lui prend réellement sur ce match. */
function comparateur(m) {
  if (!m.cons) return "";
  return `<h2>Comparer avec ton opérateur</h2>
    <p style="font-size:12px;color:var(--tx2);margin:0 0 9px">Saisis les trois cotes affichées par ton
      bookmaker. Ça marche avec n'importe lequel — le calcul ne dépend que des cotes.</p>
    <input id="cmp-nom" placeholder="Nom de l'opérateur" value="${esc(E.set.operateur || "")}"
           style="margin-bottom:8px" autocomplete="off">
    <div class="ligne">
      <div style="flex:1"><label>1</label><input type="number" inputmode="decimal" step="0.01" class="cmp" id="cmp0"></div>
      <div style="flex:1"><label>Nul</label><input type="number" inputmode="decimal" step="0.01" class="cmp" id="cmp1"></div>
      <div style="flex:1"><label>2</label><input type="number" inputmode="decimal" step="0.01" class="cmp" id="cmp2"></div>
    </div>
    <div id="cmp-out" style="margin-top:10px"></div>`;
}
function brancherComparateur(m) {
  if (!m.cons || !$("#cmp0")) return;
  const nom = $("#cmp-nom");
  nom.addEventListener("change", () => { E.set.operateur = nom.value.trim(); sauver(); });
  let minuteurMarge = null;
  /* On enregistre la marge constatée, une entrée par opérateur et par match, après
     une courte pause : sinon chaque frappe au clavier créerait une ligne. */
  const memoriser = (nom, marge) => {
    if (!nom || !isFinite(marge) || marge < 0 || marge > 1) return;
    const cle = `${nom.toLowerCase()}|${m.div}|${m.h}|${m.a}`;
    E.marges = (E.marges || []).filter(x => x.cle !== cle);
    E.marges.push({ cle, nom: nom.trim(), marge, d: aujourdhui(), div: m.div });
    if (E.marges.length > 300) E.marges = E.marges.slice(-300);
    sauver();
  };

  const calcule = () => {
    const o = [0, 1, 2].map(i => +$("#cmp" + i).value);
    const boite = $("#cmp-out");
    const valides = o.filter(x => x > 1).length;
    if (valides < 3) {
      boite.innerHTML = `<p class="mut" style="font-size:12px;margin:0">Renseigne les trois cotes pour obtenir la marge.</p>`;
      return;
    }
    const somme = o.reduce((a, c) => a + 1 / c, 0);
    const margeOp = somme - 1;                       // ce que l'opérateur prélève
    const refBest = [m.cH, m.cD, m.cA];
    const margeRef = refBest.every(x => x) ? refBest.reduce((a, c) => a + 1 / c, 0) - 1 : null;
    const p = [m.cons.H, m.cons.D, m.cons.A];
    const labels = ["1", "Nul", "2"];
    const ecarts = o.map((c, i) => margeDe(p[i], c));
    const meilleur = ecarts.indexOf(Math.max(...ecarts));
    // une seule échelle pilote l'étiquette ET la conclusion, pour qu'elles ne se contredisent pas
    const bande = margeOp <= 0.07 ? 0 : margeOp <= 0.12 ? 1 : 2;
    const etiquette = [["t-pos", "correct"], ["t-warn", "cher"], ["t-neg", "très cher"]][bande];
    const coutPour100 = (100 * margeOp / (1 + margeOp)).toFixed(0);
    const conclusion = [
      `Marge comparable aux grands opérateurs européens.`,
      `Sur 100 ${E.set.cur} misés chez cet opérateur, il t'en coûte environ ${coutPour100} en moyenne, avant même de pronostiquer.`,
      `Marge très élevée : sur 100 ${E.set.cur} misés, il t'en coûte environ ${coutPour100} en moyenne. À ce niveau, aucun pronostic ne rattrape le prix payé.`
    ][bande];
    clearTimeout(minuteurMarge);
    minuteurMarge = setTimeout(() => memoriser(nom.value, margeOp), 1500);

    boite.innerHTML = `
      <div class="fiche">
        <div class="ft"><span class="fn">${esc(nom.value.trim() || "Ton opérateur")}</span>
          <span class="tag ${etiquette[0]}">${etiquette[1]}</span></div>
        <div class="grid g2" style="margin-bottom:10px">
          <div class="stat"><i>Sa marge sur ce match</i><b class="${margeOp > 0.12 ? "neg" : ""}">${(100 * margeOp).toFixed(1)} %</b></div>
          <div class="stat"><i>Meilleur prix des 6 books</i><b>${margeRef == null ? "—" : (100 * margeRef).toFixed(1) + " %"}</b></div>
        </div>
        ${labels.map((l, i) => `<div class="lg"><span>${l} à ${f2(o[i])}
            <br><span style="font-size:11.5px;color:var(--tx3)">prix équitable ${f2(1 / p[i])}</span></span>
          <span class="tag ${ecarts[i] >= 0 ? "t-pos" : ecarts[i] > -0.05 ? "t-mut" : "t-neg"}">${sg(ecarts[i])}</span></div>`).join("")}
        <p style="font-size:12px;color:var(--tx2);margin:10px 0 0">
          ${conclusion}
          Son prix le moins désavantageux sur ce match est <b>${labels[meilleur]}</b>.
        </p>
        <p style="font-size:11.5px;color:var(--tx3);margin:8px 0 0">
          La colonne de droite compare à la marge obtenue en prenant la meilleure des six cotes
          européennes, pas à celle d'un seul bookmaker — c'est volontairement le point de comparaison
          le plus exigeant.</p>
      </div>`;
  };
  [0, 1, 2].forEach(i => $("#cmp" + i).addEventListener("input", calcule));
  calcule();
}

/** En-tête affiché pendant une recherche : fiche de l'équipe trouvée puis nombre de résultats. */
function enteteRecherche(ms) {
  const eqs = equipesTrouvees();
  let h = "";
  if (eqs.length && eqs.length <= 3) {
    h += eqs.map(e => `<div class="fiche">
      <div class="ft"><span class="fn">${esc(e.nom)}</span>
        <span class="fc">${esc(e.champ)} · ${e.rang}<sup>${e.rang === 1 ? "er" : "e"}</sup> sur ${e.total}</span></div>
      <div class="grid g3">
        <div class="stat"><i>Attaque</i><b>${e.att.toFixed(2)}</b></div>
        <div class="stat"><i>Défense</i><b>${e.def.toFixed(2)}</b></div>
        <div class="stat"><i>Indice</i><b>${e.indice.toFixed(2)}</b></div>
      </div>
      <div style="font-size:11.5px;color:var(--tx3);margin-top:8px">
        Attaque au-dessus de 1 = marque plus que la moyenne du championnat.
        Défense au-dessus de 1 = encaisse plus, donc défense plus faible.
        ${e.poids < 5 ? `<span class="tag t-warn" style="margin-left:4px">seulement ${e.poids.toFixed(0)} matchs pondérés</span>` : ""}
      </div></div>`).join("");
  }
  h += `<div class="note info" style="margin-bottom:12px">
    ${ms.length ? `${ms.length} rencontre${ms.length > 1 ? "s" : ""} à venir` : "Aucune rencontre à venir"}
    pour « ${esc(recherche)} ». Le filtre par jour est ignoré pendant une recherche.</div>`;
  return h;
}

/* ─────────── détail d'un match ─────────── */
function ouvrirMatch(i) {
  const m = JOUR.matchs[i], s = E.set.seuil / 100;
  const lignes = [
    ["Victoire " + m.h, m.cons && m.cons.H, m.pH, m.cH],
    ["Match nul", m.cons && m.cons.D, m.pD, m.cD],
    ["Victoire " + m.a, m.cons && m.cons.A, m.pA, m.cA],
    ["Plus de 2,5 buts", m.consOU && m.consOU.O, m.pO, m.cO],
    ["Moins de 2,5 buts", m.consOU && m.consOU.U, 1 - m.pO, m.cU]
  ];
  const retenus = m.fiable ? m.signaux.filter(x => x.marge >= s) : [];
  $("#feuille-c").innerHTML = `
    <div style="margin-bottom:4px;font-size:11.5px;color:var(--tx3)">${esc(m.nom)} · ${libJour(m.d)} ${esc(m.heure)}</div>
    <div style="font-size:19px;font-weight:650;letter-spacing:-.02em;margin-bottom:14px">${esc(m.h)} – ${esc(m.a)}</div>
    ${!m.fiable ? `<div class="note">Une des deux équipes compte moins de 5 matchs pondérés : le modèle la connaît mal.
      Ce match est exclu du calcul des écarts.</div>` : ""}
    <h2 style="margin-top:0">Pronostic du modèle</h2>
    <div class="grid g3" style="margin-bottom:6px">
      <div class="stat"><i>Buts attendus</i><b style="font-size:15px">${f2(m.lH)} – ${f2(m.lA)}</b></div>
      <div class="stat"><i>Score probable</i><b style="font-size:15px">${m.score || "—"}</b></div>
      <div class="stat"><i>Deux marquent</i><b style="font-size:15px">${pc(m.pBtts)}</b></div>
    </div>
    <h2>Prix et estimations</h2>
    <p style="font-size:12px;color:var(--tx2);margin:0 0 8px">« Marché » = consensus des bookmakers, marge retirée.
      C'est la meilleure estimation disponible ; l'écart se mesure par rapport à elle.
      ${m.cotesVues ? `<br><span style="color:var(--tx3)">Cotes relevées ${ageCotes(m.cotesVues)} — vérifie le prix réel chez ton opérateur avant de miser.</span>` : ""}</p>
    ${lignes.map(([lab, pm, pmod, c]) => {
      if (!c) return `<div class="lg"><span>${esc(lab)}</span><b class="mut">prix indisponible</b></div>`;
      const e = pm ? margeDe(pm, c) : null;
      const ok = e != null && e >= s && m.fiable;
      return `<div class="lg">
        <span>${esc(lab)}<br><span style="font-size:11.5px;color:var(--tx3)">
          marché ${pm ? pc(pm, 1) : "—"} · modèle ${pc(pmod, 1)}</span></span>
        <span style="text-align:right"><b>${f2(c)}</b><br>
          ${e == null ? '<span class="tag t-mut">—</span>' : `<span class="tag ${ok ? "t-pos" : "t-mut"}">${sg(e)}</span>`}</span></div>`;
    }).join("")}
    ${doubleChance(m)}
    ${tableauBooks(m)}
    ${comparateur(m)}
    ${m.cons ? `<h2>Où le modèle diverge du marché</h2>
      <p style="font-size:12px;color:var(--tx2);margin:0 0 8px">Écart en points de pourcentage. Un gros écart ne signale pas
        une occasion : la mesure montre que dans ce face-à-face, c'est le modèle qui se trompe.</p>
      ${[["1", m.pH, m.cons.H], ["Nul", m.pD, m.cons.D], ["2", m.pA, m.cons.A]].map(([lab, pmod, pm]) =>
        `<div class="lg"><span>${lab}</span><b>${pc(pmod, 1)} <span class="mut">contre</span> ${pc(pm, 1)}
          <span class="tag ${Math.abs(pmod - pm) > 0.06 ? "t-warn" : "t-mut"}">${pmod - pm >= 0 ? "+" : ""}${(100 * (pmod - pm)).toFixed(1)} pt</span></b></div>`).join("")}` : ""}
    ${retenus.length ? `<h2>Mise conseillée</h2>
      ${retenus.map(x => `<div class="lg"><span><b>${esc(x.sel)}</b> à ${f2(x.cote)}<br>
        <span style="font-size:11.5px;color:var(--tx3)">écart ${sg(x.marge)}</span></span>
        <b>${arg(mise(x.p, x.cote))}</b></div>`).join("")}
      <button class="btn" style="margin-top:14px" id="b-parier">Ajouter au journal</button>` : ""}
    <button class="btn gh" style="margin-top:10px" id="b-fermer">Fermer</button>`;
  $("#voile").classList.add("on"); $("#feuille").classList.add("on");
  $("#b-fermer").onclick = fermer;
  brancherComparateur(m);
  const bp = $("#b-parier");
  if (bp) bp.onclick = () => {
    const x = retenus[0];
    fermer();
    formulairePari({ ev: `${m.h} - ${m.a}`, sel: nomSelection(m, x.sel), cote: x.cote,
      m: Math.round(mise(x.p, x.cote)), p: x.p, d: m.d, ref: `${m.d}|${m.h}|${m.a}`, code: x.sel });
  };
}
function fermer() { $("#voile").classList.remove("on"); $("#feuille").classList.remove("on"); }

/* ─────────── vue Écarts ─────────── */
function rendreSignaux() {
  const sigs = signauxVisibles();
  const p = $("#pastille");
  if (p) { p.hidden = !sigs.length; p.textContent = sigs.length; }

  let b = "";
  if (HISTO && HISTO.bilan && HISTO.bilan.regles >= 1) {
    const B = HISTO.bilan, r = B.rendement, ic = B.ic95;
    const verdict = !ic ? ["t-mut", "échantillon trop petit"]
      : ic[0] > 0 ? ["t-pos", "avantage mesurable"]
        : ic[1] < 0 ? ["t-neg", "perte significative"] : ["t-warn", "indistinguable du hasard"];
    b = `<div class="bloc"><h2 style="margin-top:0">Performance réelle des signaux</h2>
      <p style="font-size:12.5px;color:var(--tx2);margin:0 0 11px">Tous les signaux produits depuis le
        ${B.depuis ? new Date(B.depuis).toLocaleDateString("fr-FR") : "—"}, réglés automatiquement sur les
        résultats, à mise constante d'une unité. Aucun tri après coup.</p>
      <div class="grid g3">
        <div class="stat"><i>Réglés</i><b>${B.regles}</b></div>
        <div class="stat"><i>Réussite</i><b>${pc(B.gagnes / B.regles)}</b></div>
        <div class="stat"><i>Rendement</i><b class="${r >= 0 ? "pos" : "neg"}">${r == null ? "—" : sg(r)}</b></div>
      </div>
      <div style="margin-top:10px"><span class="tag ${verdict[0]}">${verdict[1]}</span>
        ${ic ? `<span class="mut" style="font-size:11.5px;margin-left:6px">intervalle 95 % : ${(100 * ic[0]).toFixed(1)} % à ${(100 * ic[1]).toFixed(1)} %</span>` : ""}</div></div>`;
  } else if (HISTO && HISTO.bilan && HISTO.bilan.proposes) {
    b = `<div class="note info">${HISTO.bilan.proposes} signaux enregistrés, aucun encore réglé.
      Le rendement réel apparaîtra ici dès que les résultats tomberont.</div>`;
  }
  $("#bilan").innerHTML = b;

  if (sigs.length) {
    $("#liste-signaux").innerHTML = sigs.map((x, i) => `
      <div class="sig">
        <div class="st"><span class="sm">${esc(x.sel)}</span><span class="tag t-pos">${sg(x.marge)}</span></div>
        <div class="sd">${esc(x.m.h)} – ${esc(x.m.a)} · ${esc(x.m.nom)} · ${libJour(x.m.d)} ${esc(x.m.heure)}</div>
        <div class="sl"><span>marché <b>${pc(x.p, 1)}</b></span><span>cote <b>${f2(x.cote)}</b></span>
          <span>équitable <b>${f2(1 / x.p)}</b></span><span>mise <b>${arg(mise(x.p, x.cote))}</b></span></div>
        <button class="btn gh pt" style="margin-top:10px" data-sig="${i}">Ajouter au journal</button>
      </div>`).join("");
    $("#liste-signaux").querySelectorAll("button[data-sig]").forEach(btn => btn.onclick = () => {
      const x = sigs[+btn.dataset.sig];
      formulairePari({ ev: `${x.m.h} - ${x.m.a}`, sel: nomSelection(x.m, x.sel), cote: x.cote,
        m: Math.round(mise(x.p, x.cote)), p: x.p, d: x.m.d, ref: `${x.m.d}|${x.m.h}|${x.m.a}`, code: x.sel });
    });
  } else {
    const cl = (JOUR && JOUR.classement || []).filter(c => c.d >= aujourdhui()).slice(0, 10);
    $("#liste-signaux").innerHTML = `
      <div class="note">Aucun prix ne dépasse ${E.set.seuil} % d'écart aujourd'hui. C'est le résultat normal :
        une fois la marge retirée et les cotes aberrantes écartées, les bookmakers sont presque toujours d'accord entre eux.</div>
      ${cl.length ? `<h2>Les écarts les plus proches du seuil</h2>
        <p style="font-size:12.5px;color:var(--tx2);margin:0 0 10px">À titre indicatif : sous le seuil, l'écart ne couvre
          pas l'incertitude d'estimation. Ne mise pas dessus.</p>
        ${cl.map(c => `<div class="lg"><span><b>${esc(c.sel)}</b> · ${esc(c.h)} – ${esc(c.a)}<br>
          <span style="font-size:11.5px;color:var(--tx3)">${esc(c.nom)} · ${libJour(c.d)} · marché ${pc(c.p, 1)}</span></span>
          <span style="text-align:right"><b>${f2(c.cote)}</b><br><span class="tag t-mut">${sg(c.marge)}</span></span></div>`).join("")}` : ""}`;
  }
}

/* ─────────── combinés ─────────── */
/* Un combiné multiplie les cotes, mais il multiplie aussi la marge du bookmaker.
   Avec une marge m par sélection, l'espérance d'un combiné de n sélections est
   multipliée par (1 − m)ⁿ : c'est le seul chiffre qui compte vraiment, et
   l'application l'affiche au lieu de le laisser dans l'ombre. */

const TAILLES = [2, 3, 4, 5, 8, 10];

/** Double chance conseillée : celle qui écarte l'issue la moins probable selon le marché. */
function conseilDC(m) {
  if (!m.cons) return "";
  const p = [m.cons.H, m.cons.D, m.cons.A];
  const moins = p.indexOf(Math.min(...p));
  const code = ["X2", "12", "1X"][moins];         // on retire respectivement 1, N puis 2
  const proba = 1 - p[moins];
  if (proba > 0.92) return "";                    // trop probable : aucun prix decent n'existe
  return `<div style="font-size:11.5px;margin:0 0 7px;padding:6px 9px;border-radius:7px;
      background:var(--acc-w);color:var(--acc)">
    Double chance · <b>${esc(nomSelection(m, code))}</b> — ${pc(proba, 0)},
    prix équitable ${f2(1 / proba)}</div>`;
}

/** Libellé lisible d'une sélection, y compris les doubles chances. */
function nomSelection(m, sel) {
  if (sel === "1") return m.h;
  if (sel === "2") return m.a;
  if (sel === "N") return "Match nul";
  if (sel === "1X") return `${m.h} ou nul`;
  if (sel === "12") return `${m.h} ou ${m.a}`;
  if (sel === "X2") return `Nul ou ${m.a}`;
  return sel;                                  // +2,5 buts / -2,5 buts passent tels quels
}

/** Issue la plus probable d'un match selon le marché, avec son meilleur prix. */
function favori(m) {
  if (!m.cons) return null;
  const opts = [["1", m.cons.H, m.cH], ["N", m.cons.D, m.cD], ["2", m.cons.A, m.cA]]
    .filter(([, p, c]) => p && c);
  if (!opts.length) return null;
  const best = opts.reduce((a, b) => b[1] > a[1] ? b : a);
  return { sel: best[0], p: best[1], cote: best[2] };
}

function proposerCombine() {
  if (!JOUR) return;
  const candidats = [];
  for (const m of matchsVisibles()) {
    if (!m.fiable) continue;
    const f = favori(m);
    if (f && f.p >= 0.4) candidats.push({ i: JOUR.matchs.indexOf(m), sel: f.sel, p: f.p, cote: f.cote });
  }
  candidats.sort((a, b) => b.p - a.p);
  combine = candidats.slice(0, tailleCombine);
  rendreCombines();
}

function calculCombine() {
  if (!combine.length) return null;
  let cote = 1, pMarche = 1, pModele = 1;
  for (const l of combine) {
    const m = JOUR.matchs[l.i];
    cote *= l.cote;
    pMarche *= l.p;
    const dc = DC.find(x => x[0] === l.sel);
    pModele *= dc ? (m[dc[2][0]] + m[dc[2][1]])
      : (l.sel === "1" ? m.pH : l.sel === "N" ? m.pD : m.pA);
  }
  const mOp = Math.max(0, E.set.margeOp / 100);
  const parSelection = 1 / (1 + mOp);          // ce qui reste après la marge, par sélection
  /* Le prix d'une double chance est déjà estimé marge comprise : lui réappliquer le
     coefficient la compterait deux fois. On ne l'applique qu'aux prix réellement relevés. */
  const apresMarge = combine.reduce((t, l) => t * (l.estime ? 1 : parSelection), 1);

  /* Un combiné se place chez UN SEUL opérateur : additionner les meilleurs prix de
     six bookmakers différents donnerait une cote que personne ne propose. On calcule
     donc la cote totale bookmaker par bookmaker, et on retient le meilleur. */
  let book = null;
  if (JOUR.books && !combine.some(l => l.estime)) {
    const IX = { "1": 0, "N": 1, "2": 2 };
    JOUR.books.forEach((nom, b) => {
      let produit = 1;
      for (const l of combine) {
        const pb = JOUR.matchs[l.i].parBook;
        const prix = pb && pb[b] ? pb[b][IX[l.sel]] : null;
        if (!prix) { produit = null; break; }
        produit *= prix;
      }
      if (produit && (!book || produit > book.cote)) book = { nom, cote: produit };
    });
  }

  return {
    cote, pMarche, pModele, n: combine.length,
    book,                                        // meilleur bookmaker unique, si connu
    espBook: book ? pMarche * book.cote : null,
    espOp: pMarche * cote * apresMarge,
    uneFoisSur: 1 / pMarche
  };
}

function rendreCombines() {
  if (!JOUR) { $("#c-resume").innerHTML = '<div class="vide">Données non chargées.</div>'; return; }
  $("#c-tailles").innerHTML = TAILLES.map(t =>
    `<button class="puce ${t === tailleCombine ? "on" : ""}" data-t="${t}">${t} sélections</button>`).join("");
  $("#c-tailles").querySelectorAll("button").forEach(b => b.onclick = () => {
    tailleCombine = +b.dataset.t; proposerCombine();
  });

  const c = calculCombine();
  if (!c) {
    $("#c-resume").innerHTML = `<div class="note info">Choisis une taille puis « Proposer les favoris »,
      ou ajoute tes propres sélections plus bas.</div>`;
    $("#c-legs").innerHTML = "";
  } else {
    const perteOp = 1 - c.espOp;
    const grave = c.espOp < 0.5;
    $("#c-resume").innerHTML = `
      <div class="bloc">
        <div class="grid g2" style="margin-bottom:10px">
          <div class="stat"><i>Cote totale</i><b>${(c.book ? c.book.cote : c.cote).toFixed(2)}</b></div>
          <div class="stat"><i>Chances que ça passe</i><b>${pc(c.pMarche, 1)}</b></div>
        </div>
        <div class="lg"><span>À jouer en moyenne</span><b>${c.uneFoisSur < 5 ? c.uneFoisSur.toFixed(1) : c.uneFoisSur.toFixed(0)} fois pour en gagner 1</b></div>
        ${c.book ? `<div class="lg"><span>Meilleur bookmaker unique<br>
          <span style="font-size:11.5px;color:var(--tx3)">${esc(c.book.nom)} · cote ${c.book.cote.toFixed(2)}</span></span>
          <b class="${c.espBook >= 1 ? "pos" : "neg"}">${(100 * c.espBook).toFixed(0)} rendus pour 100 misés</b></div>` : ""}
        <div class="lg"><span>Chez un opérateur à ${E.set.margeOp} %</span>
          <b class="${c.espOp >= 1 ? "pos" : "neg"}">${(100 * c.espOp).toFixed(0)} rendus pour 100 misés</b></div>
        <div class="note ${grave ? "bad" : ""}" style="margin:12px 0 0">
          <b>La marge se multiplie à chaque sélection.</b> ${E.set.margeOp} % sur un pari simple
          devient ${(100 * perteOp).toFixed(0)} % de perte attendue sur ce combiné de ${c.n}.
          ${grave
            ? "À ce niveau tu perds plus de la moitié de ta mise en espérance : c'est une loterie, plus un pari."
            : "Un combiné n'améliore jamais l'espérance : il agrandit le lot et raréfie les gains."}
        </div>
        <p style="font-size:11.5px;color:var(--tx3);margin:8px 0 0">
          ${combine.some(l => l.estime)
            ? `Ce combiné contient au moins une double chance, dont la cote n'est publiée nulle part :
               elle est estimée à partir du prix équitable et de la marge que tu as renseignée (~).
               La comparaison entre bookmakers est donc désactivée.`
            : `Un combiné se place chez un seul opérateur : la cote affichée est celle du meilleur
               bookmaker unique, pas un assemblage des meilleurs prix de plusieurs sites.`}</p>
        <div class="grid g2" style="margin-top:12px">
          <div class="stat"><i>Proba selon le modèle</i><b>${pc(c.pModele, 1)}</b></div>
          <div class="stat"><i>Gain pour 1 000 ${E.set.cur}</i><b>${Math.round(1000 * (c.book ? c.book.cote : c.cote)).toLocaleString("fr-FR")}</b></div>
        </div>
        <button class="btn" style="margin-top:12px" id="c-journal">Enregistrer ce combiné</button>
      </div>`;
    $("#c-journal").onclick = () => formulairePari({
      ev: `Combiné ${c.n} sélections`,
      sel: combine.map(l => `${JOUR.matchs[l.i].h}-${JOUR.matchs[l.i].a} : ${l.sel}`).join(" / "),
      cote: (c.book ? c.book.cote : c.cote).toFixed(2), m: "", p: c.pMarche,
      d: combine.map(l => JOUR.matchs[l.i].d).sort().pop(),
      legs: combine.map(l => {
        const mm = JOUR.matchs[l.i];
        return { ref: `${mm.d}|${mm.h}|${mm.a}`, code: l.sel };
      })
    });

    $("#c-legs").innerHTML = `<h2>Les ${c.n} sélections</h2>` + combine.map((l, k) => {
      const m = JOUR.matchs[l.i];
      const nom = nomSelection(m, l.sel);
      return `<div class="pari">
        <div class="pt"><span class="pn">${esc(nom)}</span><b>${f2(l.cote)}</b></div>
        <div class="pd">${esc(m.h)} – ${esc(m.a)} · ${esc(m.nom)} · ${libJour(m.d)} ${esc(m.heure)} · marché ${pc(l.p, 1)}</div>
        <div class="pa"><button class="puce" data-rm="${k}" style="color:var(--neg)">Retirer</button></div>
      </div>`;
    }).join("");
    $("#c-legs").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
      combine.splice(+b.dataset.rm, 1); rendreCombines();
    });
  }
  listerAjout();
}

function listerAjout() {
  const champ = $("#c-q"), boite = $("#c-res");
  if (!champ || !JOUR) return;
  const brut = norm(champ.value), q = ABREVIATIONS[brut] || brut;
  if (q.length < 2) {
    boite.innerHTML = '<p class="mut" style="font-size:12.5px;margin:0">Tape au moins deux lettres.</p>';
    return;
  }
  const mots = q.split(" ").filter(Boolean);
  const dedans = new Set(combine.map(l => l.i));
  const trouves = JOUR.matchs
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => m.d >= aujourdhui() && !dedans.has(i))
    .filter(({ m }) => mots.every(w => norm(m.h + " " + m.a + " " + m.nom).includes(w)))
    .slice(0, 6);
  boite.innerHTML = trouves.length ? trouves.map(({ m, i }) => {
    const opts = [["1", m.cons && m.cons.H, m.cH], ["N", m.cons && m.cons.D, m.cD], ["2", m.cons && m.cons.A, m.cA]]
      .filter(([, p, c]) => p && c);
    // double chance : prix estimé à partir du prix équitable et de la marge de l'opérateur
    // au-dela de 90 % la double chance ne se joue pas : le prix tombe si bas qu'aucun
    // operateur ne le propose, et le pari n'a plus de sens
    const dc = m.cons ? DC.map(([code, kc]) => {
      const p = m.cons[kc[0]] + m.cons[kc[1]];
      const prix = Math.max(1.01, (1 / p) / (1 + E.set.margeOp / 100));
      return [code, p, prix, true];
    }).filter(([, p]) => p <= 0.90) : [];
    return `<div style="margin-bottom:11px">
      <div style="font-size:13.5px;font-weight:600">${esc(m.h)} – ${esc(m.a)}</div>
      <div style="font-size:11.5px;color:var(--tx3);margin-bottom:5px">${esc(m.nom)} · ${libJour(m.d)}</div>
      <div class="pa">${[...opts, ...dc].map(([sel, p, co, est]) =>
        `<button class="puce" data-add="${i}|${sel}|${p}|${co}|${est ? 1 : 0}">${esc(nomSelection(m, sel))} · ${f2(co)}${est ? " ~" : ""}</button>`).join("")}</div></div>`;
  }).join("") : '<p class="mut" style="font-size:12.5px;margin:0">Aucun match trouvé.</p>';
  boite.querySelectorAll("[data-add]").forEach(b => b.onclick = () => {
    const [i, sel, p, co, est] = b.dataset.add.split("|");
    if (combine.length >= 12) return alert("Douze sélections, c'est déjà bien au-delà du raisonnable.");
    combine.push({ i: +i, sel, p: +p, cote: +co, estime: est === "1" });
    champ.value = "";
    rendreCombines();
  });
}

/* ─────────── scores : pronostic contre réalité ─────────── */
/* Chaque pronostic est archivé AVANT le match, puis confronté au score réel le lendemain.
   La comparaison avec le marché est affichée à côté : c'est elle qui donne l'échelle. */

/** Bilan recalculé sur n'importe quel sous-ensemble : permet d'afficher les statistiques
    d'une seule équipe quand une recherche est active. */
function bilanScores(ms) {
  const n = ms.length;
  if (!n) return null;
  const IX = { "1": 0, "N": 1, "2": 2 };
  const avecMarche = ms.filter(x => x.okMarche !== null);
  const avecProbas = ms.filter(x => x.pm);
  // double chance : on écarte l'issue la moins probable, et on regarde si le résultat tombe dans les deux restantes
  const dc = (liste, cle) => {
    const g = liste.filter(x => x[cle]);
    if (!g.length) return null;
    const ok = g.filter(x => {
      const moins = x[cle].indexOf(Math.min(...x[cle]));
      return IX[x.issueReelle] !== moins;
    }).length;
    return { n: g.length, taux: ok / g.length };
  };
  return {
    n,
    okIssue: ms.filter(x => x.okIssue).length,
    exact: ms.filter(x => x.exact).length,
    okMarche: avecMarche.filter(x => x.okMarche).length,
    nMarche: avecMarche.length,
    dcModele: dc(avecProbas, "pm"),
    dcMarche: dc(avecProbas, "pq"),
    erreurButs: ms.reduce((t, x) => t + Math.abs((x.lH + x.lA) - x.butsReels), 0) / n,
    erreurEcart: ms.reduce((t, x) => {
      const [ph, pa] = x.prevu.split("-").map(Number), [rh, ra] = x.reel.split("-").map(Number);
      return t + Math.abs((ph - pa) - (rh - ra));
    }, 0) / n
  };
}

function rendreScores() {
  if (!SCORES || !SCORES.matchs || !SCORES.matchs.length) {
    $("#s-bilan").innerHTML = `<div class="vide">Aucun résultat encore confronté.<br>
      <span style="font-size:12px">Les pronostics du jour seront comparés aux scores dès demain matin.</span></div>`;
    $("#s-liste").innerHTML = "";
    return;
  }
  const q = requete();
  const mots = q.split(" ").filter(Boolean);
  const tous = SCORES.matchs.filter(x => x.fiable)
    .filter(x => !E.set.champs.length || E.set.champs.includes(x.div))
    .filter(x => !q || mots.every(w => norm(x.h + " " + x.a + " " + x.nom).includes(w)));
  const B = bilanScores(tous);
  if (!B) {
    $("#s-bilan").innerHTML = `<div class="vide">Aucun match jugé pour « ${esc(recherche)} ».<br>
      <span style="font-size:12px">Seules les rencontres déjà jouées apparaissent ici.</span></div>`;
    $("#s-liste").innerHTML = "";
    return;
  }
  const tauxModele = B.okIssue / B.n;
  const tauxMarche = B.nMarche ? B.okMarche / B.nMarche : null;
  $("#s-bilan").innerHTML = `
    ${q ? `<div class="note info">Statistiques limitées à « ${esc(recherche)} » : ${B.n} match${B.n > 1 ? "s" : ""} jugé${B.n > 1 ? "s" : ""}.
      ${B.n < 20 ? "Échantillon trop petit pour en tirer une conclusion." : ""}</div>` : ""}
    <div class="bloc">
      <h2 style="margin-top:0">Ce que vaut le pronostic</h2>
      <div class="grid g2" style="margin-bottom:10px">
        <div class="stat"><i>Issue correcte</i><b>${pc(tauxModele, 1)}</b></div>
        <div class="stat"><i>Le marché, lui</i><b class="${tauxMarche > tauxModele ? "neg" : "pos"}">${tauxMarche == null ? "—" : pc(tauxMarche, 1)}</b></div>
        <div class="stat"><i>Score exact</i><b>${pc(B.exact / B.n, 1)}</b></div>
        <div class="stat"><i>Matchs jugés</i><b>${B.n}</b></div>
      </div>
      ${B.dcModele ? `<div class="lg"><span>En double chance<br>
        <span style="font-size:11.5px;color:var(--tx3)">on écarte l'issue la moins probable</span></span>
        <b>${pc(B.dcModele.taux, 1)}${B.dcMarche ? ` <span class="mut">contre</span> ${pc(B.dcMarche.taux, 1)}` : ""}</b></div>` : ""}
      <div class="lg"><span>Erreur moyenne sur le nombre de buts</span><b>${B.erreurButs.toFixed(2)} but${B.erreurButs > 1 ? "s" : ""}</b></div>
      <div class="lg"><span>Erreur moyenne sur l'écart au score</span><b>${B.erreurEcart.toFixed(2)} but${B.erreurEcart > 1 ? "s" : ""}</b></div>
      ${blocDivergence(tous)}
      ${blocFiabilite(tous)}
      <p style="font-size:12px;color:var(--tx2);margin:11px 0 0">
        Un score exact tombe environ une fois sur ${Math.round(B.n / Math.max(1, B.exact))}.
      </p>
      <div class="note info" style="margin-top:11px">
        <b>Le score le plus probable et l'issue pronostiquée diffèrent souvent</b> — dans deux
        tiers des matchs. 1-1 est fréquemment le score isolé le plus probable (environ 11 %),
        alors que la victoire à domicile reste l'issue la plus probable une fois additionnés
        tous les scores qui la composent : 1-0, 2-0, 2-1, 3-1… Les cartes ci-dessous affichent
        donc l'issue pronostiquée en premier, puisque c'est elle qui est jugée, et le score le
        plus probable en dessous à titre indicatif.
      </div>
      ${SCORES.matchs.some(x => x.reconstruit) ? `<p style="font-size:11.5px;color:var(--tx3);margin:9px 0 0">
        Les journées antérieures à l'installation sont marquées « reconstruit » : le modèle y a été
        réajusté sur les seuls matchs antérieurs à chaque rencontre, mais ces pronostics n'ont pas
        été publiés à l'avance.</p>` : ""}
    </div>`;

  const parJour = {};
  for (const m of tous) (parJour[m.d] ||= []).push(m);
  const jours = Object.keys(parJour).sort().reverse().slice(0, q ? 30 : 10);
  $("#s-liste").innerHTML = jours.map(j => {
    const ms = parJour[j];
    if (!ms.length) return "";
    const bons = ms.filter(m => m.okIssue).length;
    return `<h2>${libJourPasse(j)} <span style="text-transform:none;letter-spacing:0;color:var(--tx3);font-weight:400">
        · ${bons}/${ms.length} issues trouvées</span></h2>` +
      ms.map(m => `<div class="sc ${m.exact ? "net" : m.okIssue ? "ok" : "ko"}">
        <div class="sh"><span class="sn">${esc(m.h)} – ${esc(m.a)}</span>
          <span class="sco">${esc(m.reel)}</span></div>
        <div class="sd">
          <span>pronostic <b style="color:var(--tx2)">${esc(nomIssue(m, m.issuePrevue))}</b></span>
          <span class="tag ${m.okIssue ? "t-pos" : "t-mut"}">${m.okIssue ? "issue trouvée" : "raté"}</span>
          ${m.exact ? '<span class="tag t-acc">score exact</span>' : ""}
          ${m.reconstruit ? '<span class="tag t-mut">reconstruit</span>' : ""}
          ${!m.fiable ? '<span class="tag t-warn">peu de données</span>' : ""}
        </div>
        <div class="sd" style="margin-top:2px">
          <span>score le plus probable ${esc(m.prevu)}${issueDuScore(m.prevu) !== m.issuePrevue
            ? ' <span title="un score de 1-1 peut être le plus probable alors que la victoire à domicile reste l\'issue la plus probable">·</span>' : ""}</span>
          <span>buts attendus ${m.lH.toFixed(1)}–${m.lA.toFixed(1)}</span>
        </div></div>`).join("");
  }).join("") || `<div class="vide">Aucun match pour les championnats sélectionnés.</div>`;
}
/** Modèle et marché désignent le même favori la plupart du temps. Comparer leurs
    taux bruts mélange donc des matchs sur lesquels ils sont d'accord. Le seul
    comparatif qui a du sens porte sur les rencontres où ils divergent — c'est le
    principe du test de McNemar, sur paires discordantes. */
function blocDivergence(source) {
  const ms = (source || []).filter(x => x.okMarche !== null);
  if (ms.length < 30) return "";
  const divergents = ms.filter(x => x.issuePrevue !== x.issueMarche);
  const modeleSeul = divergents.filter(x => x.okIssue).length;
  const marcheSeul = divergents.filter(x => x.okMarche).length;
  const paires = modeleSeul + marcheSeul;
  if (!paires) return "";
  const chi = Math.pow(Math.abs(modeleSeul - marcheSeul) - 1, 2) / paires;
  const p = Math.exp(-chi / 2);                     // approximation suffisante ici
  const significatif = p < 0.05;
  const gagnant = marcheSeul > modeleSeul ? "marché" : "modèle";
  return `
    <h2 style="margin-top:16px">Là où ils ne sont pas d'accord</h2>
    <p style="font-size:12px;color:var(--tx2);margin:0 0 9px">
      Sur ${ms.length} matchs, modèle et marché désignent le même favori
      ${ms.length - divergents.length} fois (${pc((ms.length - divergents.length) / ms.length, 0)}).
      Comparer les taux bruts mélange donc surtout des matchs identiques. Le vrai comparatif
      porte sur les ${divergents.length} rencontres où ils divergent :</p>
    <div class="lg"><span>Le marché avait raison</span><b class="pos">${marcheSeul} fois</b></div>
    <div class="lg"><span>Le modèle avait raison</span><b class="${modeleSeul >= marcheSeul ? "pos" : "neg"}">${modeleSeul} fois</b></div>
    <div class="lg"><span>Ni l'un ni l'autre</span><b class="mut">${divergents.length - modeleSeul - marcheSeul} fois</b></div>
    <div class="note ${significatif ? "" : "info"}" style="margin-top:10px">
      ${significatif
        ? `<b>Écart significatif</b> en faveur du ${gagnant} (test de McNemar, p ≈ ${p.toFixed(3)}).`
        : `<b>Pas encore concluant.</b> L'avantage apparent du ${gagnant} pourrait venir du hasard
           sur un échantillon de cette taille (test de McNemar, p ≈ ${p.toFixed(3)} ; il faudrait
           p sous 0,05). La mesure décisive est ailleurs : sur 6 050 matchs, le modèle prédit
           moins bien que le marché de façon nette — voir l'onglet Réglages.`}
    </div>`;
}

/** « Les pronostics deviennent-ils plus fiables ? » — le modèle n'apprend pas au fil du
    temps : il est ré-estimé de zéro chaque matin. Ce qui change, c'est la quantité
    d'historique disponible sur chaque équipe. On mesure donc la précision en fonction
    de ce volume, ce qui est la vraie relation causale. */
function blocFiabilite(source) {
  const ms = (source || []).filter(x => x.poids != null);
  if (ms.length < 60) return "";
  const bandes = [[0, 3, "moins de 3"], [3, 8, "3 à 8"], [8, 999, "plus de 8"]];
  const lignes = bandes.map(([lo, hi, lib]) => {
    const g = ms.filter(x => x.poids >= lo && x.poids < hi);
    if (g.length < 20) return null;
    const ok = g.filter(x => x.okIssue).length;
    const err = g.reduce((t, x) => t + Math.abs((x.lH + x.lA) - x.butsReels), 0) / g.length;
    return { lib, n: g.length, taux: ok / g.length, err };
  }).filter(Boolean);
  if (lignes.length < 2) return "";
  const faible = lignes[0], fort = lignes[lignes.length - 1];
  return `
    <h2 style="margin-top:16px">Est-ce que ça devient plus fiable ?</h2>
    <p style="font-size:12px;color:var(--tx2);margin:0 0 9px">
      Le modèle n'apprend pas avec le temps : il est recalculé de zéro chaque matin. Ce qui change,
      c'est la quantité de matchs déjà joués par les deux équipes. Précision selon cet historique :</p>
    ${lignes.map(l => `<div class="lg">
      <span>${l.lib} matchs pondérés<br><span style="font-size:11.5px;color:var(--tx3)">${l.n} rencontres · erreur ${l.err.toFixed(2)} but</span></span>
      <b class="${l.taux >= 0.5 ? "pos" : "neg"}">${pc(l.taux, 1)}</b></div>`).join("")}
    <p style="font-size:12px;color:var(--tx2);margin:10px 0 0">
      ${fort.taux > faible.taux
        ? `Oui, mécaniquement : ${(100 * (fort.taux - faible.taux)).toFixed(1)} points d'écart entre les
           équipes peu connues et celles bien documentées. En début de saison beaucoup de matchs
           tombent dans la première catégorie ; à mesure que les journées passent, ils deviennent
           minoritaires et la précision moyenne monte. Elle plafonne ensuite.`
        : `Pas sur cet échantillon : l'historique disponible ne change pas nettement la précision.`}
    </p>`;
}

/** Ce que chaque opérateur prélève, mesuré sur les comparaisons déjà faites. */
function syntheseOperateurs() {
  const par = {};
  for (const x of E.marges || []) {
    const k = x.nom.toLowerCase();
    (par[k] ||= { nom: x.nom, marges: [] }).marges.push(x.marge);
  }
  return Object.values(par)
    .map(o => ({
      nom: o.nom, n: o.marges.length,
      moy: o.marges.reduce((a, b) => a + b, 0) / o.marges.length
    }))
    .sort((a, b) => a.moy - b.moy);
}
function rendreOperateurs() {
  const boite = $("#r-operateurs");
  if (!boite) return;
  const ops = syntheseOperateurs();
  if (!ops.length) {
    boite.innerHTML = `<p class="mut" style="font-size:12.5px;margin:0">Aucune mesure pour l'instant.
      Ouvre un match, descends jusqu'à « Comparer avec ton opérateur », saisis ses trois cotes :
      la marge constatée sera mémorisée ici.</p>`;
    return;
  }
  const b = bilanJournal();
  boite.innerHTML = ops.map((o, i) => {
    const cout = b.mises > 0 ? b.mises * (1 - 1 / (1 + o.moy)) : null;
    const etq = o.moy <= 0.07 ? ["t-pos", "correct"] : o.moy <= 0.12 ? ["t-warn", "cher"] : ["t-neg", "très cher"];
    return `<div class="lg">
      <span><b>${esc(o.nom)}</b> <span class="tag ${etq[0]}">${etq[1]}</span>
        <br><span style="font-size:11.5px;color:var(--tx3)">${o.n} match${o.n > 1 ? "s" : ""} mesuré${o.n > 1 ? "s" : ""}
        ${i === 0 && ops.length > 1 ? "· le moins cher" : ""}</span></span>
      <span style="text-align:right"><b>${(100 * o.moy).toFixed(1)} %</b>
        ${cout != null ? `<br><span style="font-size:11px;color:var(--tx3)">${arg(cout)} sur tes mises</span>` : ""}</span>
    </div>`;
  }).join("")
    + (ops.length > 1 ? `<p style="font-size:12px;color:var(--tx2);margin:10px 0 0">
        Écart entre le moins cher et le plus cher : <b>${((ops[ops.length - 1].moy - ops[0].moy) * 100).toFixed(1)} points</b>.
        Sur 100 000 ${E.set.cur} misés dans l'année, cela représente environ
        ${arg(100000 * (1 / (1 + ops[0].moy) - 1 / (1 + ops[ops.length - 1].moy)))} de différence,
        sans changer un seul pronostic.</p>` : "")
    + `<button class="btn gh pt" style="margin-top:11px" id="r-adopter">Utiliser ${(100 * ops[0].moy).toFixed(1)} % dans les calculs</button>`;
  const bt = $("#r-adopter");
  if (bt) bt.onclick = () => {
    E.set.margeOp = Math.round(1000 * ops[0].moy) / 10;
    sauver(); rendreReglages(); rendreJournal();
  };
}

/** Âge des cotes, en clair. Une cote de la veille a pu bouger sensiblement. */
function ageCotes(quand) {
  const h = (Date.now() - Date.parse(quand)) / 36e5;
  if (!isFinite(h)) return "";
  if (h < 2) return "à l'instant";
  if (h < 24) return `il y a ${Math.round(h)} h`;
  const j = Math.round(h / 24);
  return `il y a ${j} jour${j > 1 ? "s" : ""}`;
}

/** Nom lisible d'une issue 1 / N / 2 pour une ligne d'historique. */
function nomIssue(m, code) {
  return code === "1" ? m.h : code === "2" ? m.a : "Match nul";
}
const issueDuScore = sc => {
  const [a, b] = String(sc).split("-").map(Number);
  return a > b ? "1" : a === b ? "N" : "2";
};

function libJourPasse(d) {
  if (d === aujourdhui()) return "Aujourd'hui";
  if (d === new Date(Date.now() - 864e5).toISOString().slice(0, 10)) return "Hier";
  const dt = new Date(d + "T12:00:00Z");
  return JOURS[dt.getUTCDay()] + " " + dt.getUTCDate() + "/" + String(dt.getUTCMonth() + 1).padStart(2, "0");
}

/* ─────────── règlement automatique ─────────── */
/* L'application connaît les scores : demander à l'utilisateur de pointer chaque pari
   à la main était une corvée et une source d'erreur. Un pari enregistré depuis un
   match identifié porte une référence, et se règle seul dès le résultat connu.
   Le CLV se calcule dans la foulée : les cotes de clôture sont déjà archivées. */

/** Vrai si la sélection gagne, faux si elle perd, null si on ne sait pas trancher. */
function selectionGagnante(code, hg, ag) {
  switch (code) {
    case "1": return hg > ag;
    case "N": return hg === ag;
    case "2": return hg < ag;
    case "1X": return hg >= ag;
    case "12": return hg !== ag;
    case "X2": return hg <= ag;
    case "+2,5 buts": return hg + ag > 2.5;
    case "-2,5 buts": return hg + ag < 2.5;
    default: return null;
  }
}
/** Probabilité de clôture du marché pour cette sélection, si elle est connue. */
function probaCloture(pq, code) {
  if (!pq) return null;
  const [h, n, a] = pq;
  switch (code) {
    case "1": return h; case "N": return n; case "2": return a;
    case "1X": return h + n; case "12": return h + a; case "X2": return n + a;
    default: return null;              // pas de cotes de clôture archivées sur les buts
  }
}
/** Index des résultats connus, à partir des deux sources déjà chargées. */
function indexResultats() {
  const ix = new Map();
  const poser = (d, h, a, reel, pq) => {
    if (!reel) return;
    const [x, y] = reel.split("-").map(Number);
    if (!isFinite(x) || !isFinite(y)) return;
    ix.set(`${d}|${h}|${a}`, { hg: x, ag: y, pq: pq || null });
  };
  for (const m of (SCORES && SCORES.matchs) || []) poser(m.d, m.h, m.a, m.reel, m.pq);
  for (const m of (JOUR && JOUR.matchs) || [])
    if (m.statut === "FINISHED" && m.score)
      poser(m.d, m.h, m.a, m.score, m.cons ? [m.cons.H, m.cons.D, m.cons.A] : null);
  return ix;
}
/** Cherche un résultat en tolérant un jour d'écart : les sources ne datent pas
    toujours une rencontre nocturne le même jour. */
function chercherResultat(ix, ref) {
  if (!ref) return null;
  const [d, h, a] = ref.split("|");
  for (const dec of [0, -1, 1]) {
    const j = new Date(Date.parse(d + "T00:00:00Z") + dec * 864e5).toISOString().slice(0, 10);
    const r = ix.get(`${j}|${h}|${a}`);
    if (r) return r;
  }
  return null;
}

function reglerAutomatiquement() {
  if (!SCORES && !JOUR) return 0;
  const ix = indexResultats();
  let regles = 0;
  for (const p of E.journal) {
    if (p.res && p.res !== "attente") continue;
    if (p.manuel) continue;                       // l'utilisateur a repris la main
    const jambes = p.legs && p.legs.length ? p.legs : (p.ref ? [{ ref: p.ref, code: p.code }] : []);
    if (!jambes.length) continue;
    let gagne = true, complet = true, clvTotal = 1, clvConnu = true;
    for (const j of jambes) {
      const r = chercherResultat(ix, j.ref);
      if (!r) { complet = false; break; }
      const issue = selectionGagnante(j.code, r.hg, r.ag);
      if (issue === null) { complet = false; break; }
      if (!issue) gagne = false;
      const pc = probaCloture(r.pq, j.code);
      if (pc) clvTotal *= pc; else clvConnu = false;
    }
    if (!complet) continue;
    p.res = gagne ? "gagne" : "perdu";
    p.auto = true;
    if (clvConnu && clvTotal > 0) p.clv = p.cote * clvTotal - 1;
    regles++;
  }
  if (regles) sauver();
  return regles;
}

/* ─────────── journal ─────────── */
function bilanJournal() {
  const clos = E.journal.filter(p => p.res && p.res !== "attente");
  let mises = 0, gain = 0, gagnes = 0;
  for (const p of clos) {
    mises += p.mise;
    if (p.res === "gagne") { gain += p.mise * (p.cote - 1); gagnes++; }
    else if (p.res === "perdu") gain -= p.mise;
  }
  const avecClv = clos.filter(p => typeof p.clv === "number");
  const clv = avecClv.length ? avecClv.reduce((t, p) => t + p.clv, 0) / avecClv.length : null;
  return { n: clos.length, attente: E.journal.length - clos.length, mises, gain, gagnes,
    rend: mises ? gain / mises : 0, clv, nClv: avecClv.length };
}
function perteDuMois() {
  const ym = new Date().toISOString().slice(0, 7);
  let g = 0;
  for (const p of E.journal) {
    if (!p.date || !p.date.startsWith(ym)) continue;
    if (p.res === "gagne") g += p.mise * (p.cote - 1);
    else if (p.res === "perdu") g -= p.mise;
  }
  return -g;
}
function rendreJournal() {
  const b = bilanJournal();
  $("#j-stats").innerHTML = `
    <div class="stat"><i>Paris réglés</i><b>${b.n}${b.attente ? ` <span class="mut" style="font-size:11px">+${b.attente}</span>` : ""}</b></div>
    <div class="stat"><i>Résultat</i><b class="${b.gain >= 0 ? "pos" : "neg"}" style="font-size:15px">${b.gain >= 0 ? "+" : ""}${arg(b.gain)}</b></div>
    <div class="stat"><i>Rendement</i><b class="${b.rend >= 0 ? "pos" : "neg"}">${b.n ? (100 * b.rend).toFixed(1) + " %" : "—"}</b></div>`;
  if (b.nClv) {
    $("#j-stats").insertAdjacentHTML("beforeend", `
      <div class="stat" style="grid-column:span 3"><i>CLV moyen sur ${b.nClv} pari${b.nClv > 1 ? "s" : ""}</i>
        <b class="${b.clv >= 0 ? "pos" : "neg"}">${sg(b.clv)}</b>
        <span style="font-size:11px;color:var(--tx3);display:block;margin-top:3px">
          Écart entre la cote que tu as prise et le prix de clôture du marché. Positif de façon
          répétée, c'est le seul signe fiable d'un avantage réel — bien avant le rendement.</span></div>`);
  }
  // Ce que la marge explique, et ce qui releve de la chance : la seule decomposition
  // qui dise ou part reellement l'argent.
  if (b.mises > 0) {
    const ops = syntheseOperateurs();
    const mesuree = ops.length ? ops[0].moy : null;
    const marge = mesuree != null ? mesuree : Math.max(0, E.set.margeOp / 100);
    const coutMarge = b.mises * (1 - 1 / (1 + marge));
    const chance = b.gain + coutMarge;
    $("#j-stats").insertAdjacentHTML("afterend", `
      <div class="bloc" style="margin-top:11px">
        <h2 style="margin-top:0">D'où vient ton résultat</h2>
        <div class="lg"><span>Total misé</span><b>${arg(b.mises)}</b></div>
        <div class="lg"><span>Coût de la marge de ton opérateur<br>
          <span style="font-size:11.5px;color:var(--tx3)">${(100 * marge).toFixed(1)} % par pari
            ${mesuree != null ? `· mesurée sur ${ops[0].n} match${ops[0].n > 1 ? "s" : ""} chez ${esc(ops[0].nom)}` : "· réglage manuel"}</span></span>
          <b class="neg">−${arg(coutMarge)}</b></div>
        <div class="lg"><span>Part de la chance<br>
          <span style="font-size:11.5px;color:var(--tx3)">écart entre ton résultat et cette attente</span></span>
          <b class="${chance >= 0 ? "pos" : "neg"}">${chance >= 0 ? "+" : "−"}${arg(Math.abs(chance))}</b></div>
        <div class="lg"><span><b>Résultat net</b></span>
          <b class="${b.gain >= 0 ? "pos" : "neg"}">${b.gain >= 0 ? "+" : "−"}${arg(Math.abs(b.gain))}</b></div>
        <p style="font-size:12px;color:var(--tx2);margin:10px 0 0">
          La première ligne est certaine et se répète à chaque pari. La seconde s'annule à la longue.
          Pour perdre moins il n'y a donc qu'un levier durable : baisser la marge que tu paies, en
          comparant les cotes de ton opérateur au prix équitable.</p>
      </div>`);
  }
  const pm = perteDuMois();
  $("#j-alerte").innerHTML = pm >= E.set.perteMax
    ? `<div class="note bad"><b>Limite mensuelle atteinte.</b> ${arg(pm)} perdus ce mois-ci sur un plafond de ${arg(E.set.perteMax)}. Nouveaux paris bloqués.</div>`
    : pm > 0.7 * E.set.perteMax ? `<div class="note">${arg(pm)} perdus ce mois-ci, soit ${pc(pm / E.set.perteMax)} du plafond.</div>` : "";

  const RES = { attente: "En attente", gagne: "Gagné", perdu: "Perdu", annule: "Annulé" };
  const tri = [...E.journal].sort((x, y) => (y.date || "").localeCompare(x.date || "") || y.id - x.id);
  $("#liste-paris").innerHTML = tri.length ? tri.map(p => {
    const g = p.res === "gagne" ? p.mise * (p.cote - 1) : p.res === "perdu" ? -p.mise : 0;
    const att = !p.res || p.res === "attente";
    return `<div class="pari">
      <div class="pt"><span class="pn">${esc(p.sel)}</span>
        <b class="${att ? "mut" : g >= 0 ? "pos" : "neg"}">${att ? "en attente" : (g >= 0 ? "+" : "") + arg(g)}</b></div>
      <div class="pd">${esc(p.ev)} · ${p.date ? new Date(p.date).toLocaleDateString("fr-FR") : ""} · cote ${f2(p.cote)} · mise ${arg(p.mise)}
        ${p.auto ? '<span class="tag t-acc">réglé automatiquement</span>' : ""}
        ${typeof p.clv === "number" ? `<span class="tag ${p.clv >= 0 ? "t-pos" : "t-mut"}">CLV ${sg(p.clv)}</span>` : ""}</div>
      <div class="pa">${Object.keys(RES).map(k => `<button class="puce ${(p.res || "attente") === k ? "on" : ""}" data-r="${p.id}|${k}">${RES[k]}</button>`).join("")}
        <button class="puce" data-sup="${p.id}" style="margin-left:auto;color:var(--neg)">Supprimer</button></div></div>`;
  }).join("") : `<div class="vide">Aucun pari enregistré.</div>`;

  $("#liste-paris").querySelectorAll("button[data-r]").forEach(btn => btn.onclick = () => {
    const [id, r] = btn.dataset.r.split("|");
    const p = E.journal.find(x => x.id == id);
    if (p) { p.res = r; p.manuel = true; p.auto = false; sauver(); rendreJournal(); majEntete(); }
  });
  $("#liste-paris").querySelectorAll("button[data-sup]").forEach(btn => btn.onclick = () => {
    if (!confirm("Supprimer ce pari ?")) return;
    E.journal = E.journal.filter(x => x.id != btn.dataset.sup); sauver(); rendreJournal(); majEntete();
  });
}
function formulairePari(pre) {
  const v = pre || { ev: "", sel: "", cote: "", m: "", p: null, d: aujourdhui() };
  $("#feuille-c").innerHTML = `
    <div style="font-size:17px;font-weight:650;margin-bottom:12px">Enregistrer un pari</div>
    ${pre ? "" : `
      <div class="recherche" style="padding:0 0 10px">
        <input id="p-q" type="search" inputmode="search" autocomplete="off"
               placeholder="Rechercher le match (équipe ou championnat)">
      </div>
      <div id="p-res"></div>`}
    <div id="p-choisi"></div>
    <div class="grid" style="gap:11px">
      <div><label>Événement</label><input id="f-ev" value="${esc(v.ev)}" placeholder="PSG - Marseille"></div>
      <div><label>Sélection</label><input id="f-sel" value="${esc(v.sel)}" placeholder="1"></div>
      <div class="ligne">
        <div style="flex:1"><label>Cote obtenue</label><input type="number" inputmode="decimal" step="0.01" id="f-cote" value="${v.cote}"></div>
        <div style="flex:1"><label>Mise</label><input type="number" inputmode="numeric" id="f-mise" value="${v.m}"></div>
      </div>
      <div id="p-repere"></div>
      <div><label>Date</label><input type="date" id="f-date" value="${v.d}"></div>
    </div>
    <button class="btn" style="margin-top:14px" id="f-ok">Enregistrer</button>
    <button class="btn gh" style="margin-top:9px" id="f-non">Annuler</button>`;
  $("#voile").classList.add("on"); $("#feuille").classList.add("on");
  $("#f-non").onclick = fermer;

  /* ── sélecteur de match ── */
  let choisi = null, proba = null, indexMarche = null;
  let refChoisi = null, codeChoisi = null;
  const champ = $("#p-q");
  if (champ) {
    let minuteur = null;
    champ.addEventListener("input", () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(listerMatchs, 160);
    });
    listerMatchs();
  }
  function listerMatchs() {
    const brut = norm(champ.value), q = ABREVIATIONS[brut] || brut;
    const boite = $("#p-res");
    if (!JOUR || q.length < 2) {
      boite.innerHTML = `<p class="mut" style="font-size:12.5px;margin:0 0 12px">
        Tape au moins deux lettres, ou remplis les champs à la main pour un événement absent de la liste.</p>`;
      return;
    }
    const mots = q.split(" ").filter(Boolean);
    const trouves = JOUR.matchs.filter(m => m.d >= aujourdhui())
      .filter(m => mots.every(w => norm(m.h + " " + m.a + " " + m.nom).includes(w))).slice(0, 8);
    boite.innerHTML = trouves.length
      ? trouves.map((m, i) => `<div class="lg" style="cursor:pointer" data-pm="${JOUR.matchs.indexOf(m)}">
          <span><b>${esc(m.h)} – ${esc(m.a)}</b><br>
            <span style="font-size:11.5px;color:var(--tx3)">${esc(m.nom)} · ${libJour(m.d)} ${esc(m.heure)}</span></span>
          <span class="tag t-acc">choisir</span></div>`).join("")
      : `<p class="mut" style="font-size:12.5px;margin:0 0 12px">Aucun match trouvé. Remplis les champs à la main.</p>`;
    boite.querySelectorAll("[data-pm]").forEach(l => l.onclick = () => choisirMatch(JOUR.matchs[+l.dataset.pm]));
  }
  function choisirMatch(m) {
    choisi = m;
    $("#p-res").innerHTML = "";
    if (champ) champ.value = "";
    $("#f-ev").value = `${m.h} - ${m.a}`;
    $("#f-date").value = m.d;
    const marches = [
      ["1", m.cH, m.cons && m.cons.H], ["N", m.cD, m.cons && m.cons.D], ["2", m.cA, m.cons && m.cons.A],
      ["+2,5 buts", m.cO, m.consOU && m.consOU.O], ["-2,5 buts", m.cU, m.consOU && m.consOU.U]
    ].filter(([, c]) => c);
    $("#p-choisi").innerHTML = `
      <div class="fiche" style="margin-bottom:12px">
        <div class="ft"><span class="fn">${esc(m.h)} – ${esc(m.a)}</span>
          <span class="fc">${esc(m.nom)} · ${libJour(m.d)}</span></div>
        <p style="font-size:12px;color:var(--tx2);margin:0 0 9px">Choisis ta sélection, puis remplace la cote
          par celle réellement proposée par ton opérateur.</p>
        <div class="pa">${marches.map(([lab, c], i) =>
          `<button class="puce" data-mk="${i}">${esc(nomSelection(m, lab))} · ${f2(c)}</button>`).join("")}</div>
        <button class="btn gh pt" style="margin-top:10px" id="p-autre">Changer de match</button>
      </div>`;
    $("#p-choisi").querySelectorAll("[data-mk]").forEach(b => b.onclick = () => {
      const [lab, c, pm] = marches[+b.dataset.mk];
      proba = pm || null;
      indexMarche = ["1", "N", "2"].indexOf(lab);
      refChoisi = `${choisi.d}|${choisi.h}|${choisi.a}`;
      codeChoisi = lab;
      $("#f-sel").value = lab;
      $("#f-cote").value = f2(c);
      $("#p-choisi").querySelectorAll("[data-mk]").forEach(x => x.classList.toggle("on", x === b));
      majRepere();
    });
    majRepere();
  }
  function majRepere() {
    const boite = $("#p-repere");
    if (!proba) { boite.innerHTML = ""; return; }
    let reference = "";
    if (choisi && choisi.parBook && JOUR.books && indexMarche != null && indexMarche < 3) {
      const { best } = analyseBooks(choisi);
      const i = best[indexMarche];
      if (i != null) reference = `Meilleur prix relevé : <b>${f2(choisi.parBook[i][indexMarche])}</b> chez ${esc(JOUR.books[i])}. `;
    }
    const cote = +$("#f-cote").value;
    const e = cote > 1 ? margeDe(proba, cote) : null;
    boite.innerHTML = `<div style="font-size:12px;color:var(--tx2);margin-top:-4px">
      ${reference}Prix équitable <b>${f2(1 / proba)}</b> (probabilité de marché ${pc(proba, 1)}).
      ${e == null ? "" : e >= 0
        ? `<span class="tag t-pos">${sg(e)}</span> à ta cote actuelle.`
        : `<span class="tag t-neg">${sg(e)}</span> — à cette cote, tu paies plus que ça ne vaut.`}</div>`;
  }
  const btnAutre = () => { const b = $("#p-autre"); if (b) b.onclick = () => { choisi = null; proba = null; indexMarche = null; $("#p-choisi").innerHTML = ""; $("#p-repere").innerHTML = ""; listerMatchs(); }; };
  new MutationObserver(btnAutre).observe($("#p-choisi"), { childList: true });
  $("#f-cote").addEventListener("input", majRepere);

  /* ── enregistrement ── */
  $("#f-ok").onclick = () => {
    const cote = +$("#f-cote").value, m = +$("#f-mise").value;
    if (!(cote > 1)) return alert("Cote invalide.");
    if (!(m > 0)) return alert("Mise invalide.");
    if (!$("#f-ev").value.trim()) return alert("Indique l'événement.");
    if (perteDuMois() >= E.set.perteMax) return alert("Limite de perte mensuelle atteinte (" + arg(E.set.perteMax) + "). Pari refusé.");
    const plafond = E.set.bank * E.set.maxStake / 100;
    if (m > plafond && !confirm(`Mise de ${arg(m)} au-dessus de ton plafond de ${arg(plafond)}. Enregistrer quand même ?`)) return;
    E.journal.push({
      id: Date.now(), date: $("#f-date").value, ev: $("#f-ev").value.trim(),
      sel: $("#f-sel").value.trim(), cote, mise: m, p: proba || v.p, res: "attente",
      ref: refChoisi || v.ref || null, code: codeChoisi || v.code || null,
      legs: v.legs || null
    });
    sauver(); fermer(); aller("journal");
  };
}

/* ─────────── réglages ─────────── */
const CHAMPS_R = [["r-bank", "bank"], ["r-cur", "cur"], ["r-kf", "kf"], ["r-max", "maxStake"],
  ["r-seuil", "seuil"], ["r-perte", "perteMax"], ["r-margeop", "margeOp"]];
function rendreReglages() {
  CHAMPS_R.forEach(([id, k]) => $("#" + id).value = E.set[k]);
  const dispo = JOUR ? Object.entries(JOUR.championnats) : [];
  $("#r-champs").innerHTML = dispo.map(([code, o]) =>
    `<button class="puce ${E.set.champs.includes(code) ? "on" : ""}" data-c="${code}"
       title="${o.api ? "résultats du jour" : "résultats en retard de " + o.retardJours + " jours"}">
       ${esc(o.nom)}${o.api ? "" : ` <span style="opacity:.65">· ${o.retardJours} j</span>`}</button>`).join("")
    || `<span class="mut" style="font-size:13px">Championnats non chargés.</span>`;
  const enRetard = dispo.filter(([, o]) => !o.api && o.retardJours >= 3).length;
  if (enRetard) $("#r-champs").insertAdjacentHTML("afterend",
    `<p class="mut" style="font-size:12px;margin:10px 0 0">${enRetard} championnats dépendent de fichiers
     publiés deux fois par semaine : leurs résultats arrivent avec plusieurs jours de retard, et les
     pronostics y reposent sur des données moins fraîches. Les autres sont mis à jour dans la journée.</p>`);
  $("#r-champs").querySelectorAll("button").forEach(b => b.onclick = () => {
    const c = b.dataset.c;
    E.set.champs = E.set.champs.includes(c) ? E.set.champs.filter(x => x !== c) : [...E.set.champs, c];
    sauver(); rendreReglages();
  });
  $("#r-dc").innerHTML = [[false, "Sans double chance"], [true, "Avec double chance"]]
    .map(([v, lib]) => `<button class="puce ${E.set.avecDC === v ? "on" : ""}" data-dc="${v}">${lib}</button>`).join("");
  $("#r-dc").querySelectorAll("button").forEach(b => b.onclick = () => {
    E.set.avecDC = b.dataset.dc === "true"; sauver(); rendreReglages();
  });
  rendreOperateurs();
  $("#r-infos").innerHTML = JOUR ? `
    ${Object.keys(JOUR.championnats).length} championnats · ${JOUR.matchs.length} rencontres à venir<br>
    Dernière construction : ${new Date(JOUR.genere).toLocaleString("fr-FR")}<br>
    Version de l'application : <b>${VERSION_APP}</b><br>
    Seuil serveur ${(100 * JOUR.seuil).toFixed(0)} % · issues sous ${(100 * (JOUR.probaMin || 0.1)).toFixed(0)} % écartées · demi-vie ${JOUR.demiVie} jours<br>
    ${HISTO && HISTO.bilan ? `${HISTO.bilan.proposes} signaux suivis, ${HISTO.bilan.regles} réglés` : "suivi des signaux non chargé"}`
    : "Aucune donnée chargée.";
}

/* ─────────── rendu global ─────────── */
function rendre() {
  if (vue === "matchs") { rendreFiltres(); rendreMatchs(); }
  else if (vue === "signaux") rendreSignaux();
  else if (vue === "combines") rendreCombines();
  else if (vue === "scores") rendreScores();
  else if (vue === "journal") rendreJournal();
  else if (vue === "reglages") rendreReglages();
  const p = $("#pastille");
  if (p && vue !== "signaux") { const n = signauxVisibles().length; p.hidden = !n; p.textContent = n; }
}

/* ─────────── démarrage ─────────── */
charger(); batirNav(); aller("matchs"); majEntete(); recuperer(false);

const champQ = $("#q"), boutonQ = $("#q-clear");
let minuteur = null;
champQ.addEventListener("input", () => {
  boutonQ.hidden = !champQ.value;
  clearTimeout(minuteur);
  minuteur = setTimeout(() => { recherche = champQ.value.trim(); rendre(); }, 160);
});
champQ.addEventListener("search", () => { if (!champQ.value) { recherche = ""; boutonQ.hidden = true; rendre(); } });
boutonQ.onclick = () => { champQ.value = ""; recherche = ""; boutonQ.hidden = true; champQ.blur(); rendre(); };

$("#c-proposer").onclick = proposerCombine;
$("#c-vider").onclick = () => { combine = []; rendreCombines(); };
let minuteurC = null;
$("#c-q").addEventListener("input", () => { clearTimeout(minuteurC); minuteurC = setTimeout(listerAjout, 160); });

$("#voile").onclick = fermer;
$("#b-ajout").onclick = () => formulairePari(null);
$("#b-refresh").onclick = async () => { $("#maj").textContent = "mise à jour…"; await recuperer(true); };
$("#b-save").onclick = () => {
  CHAMPS_R.forEach(([id, k]) => {
    const v = $("#" + id).value;
    E.set[k] = k === "cur" ? (v.trim() || "€") : (+v || DEFAUT[k]);
  });
  E.set.kf = Math.min(1, Math.max(0.05, E.set.kf));
  sauver(); majEntete(); rendreReglages();
  $("#b-save").textContent = "Enregistré";
  setTimeout(() => $("#b-save").textContent = "Enregistrer", 1800);
};
$("#b-export").onclick = () => {
  const l = [["date", "evenement", "selection", "cote", "mise", "resultat", "gain"]];
  for (const p of E.journal)
    l.push([p.date, p.ev, p.sel, p.cote, p.mise, p.res,
      p.res === "gagne" ? p.mise * (p.cote - 1) : p.res === "perdu" ? -p.mise : ""]);
  const csv = "\ufeff" + l.map(r => r.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "journal_paris.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$("#b-reset").onclick = () => {
  if (!confirm("Effacer le journal et tous les réglages de ce téléphone ?")) return;
  localStorage.removeItem(CLE); E = { set: { ...DEFAUT }, journal: [] }; sauver(); majEntete(); rendre();
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) recuperer(true); });

/* Mise à jour automatique. Sans cela, un téléphone peut afficher pendant des jours
   une version périmée servie par son cache, sans aucun signe visible. */
if ("serviceWorker" in navigator) {
  let rechargeFaite = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (rechargeFaite) return;                 // une seule fois, sinon boucle de rechargement
    rechargeFaite = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      reg.update();                            // vérifie à chaque ouverture
      setInterval(() => reg.update(), 36e5);   // et une fois par heure si l'appli reste ouverte
    } catch { }
  });
}
