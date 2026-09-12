/* Application mobile — pronostics du jour, écarts de prix et journal de paris.

   Les probabilités et les écarts sont précalculés chaque matin par outils/construire.mjs.
   Deux estimations coexistent, et leur statut n'est pas le même :

     • la probabilité de MARCHÉ (cotes moyennes, marge retirée par la méthode de la
       puissance) sert de référence ; c'est elle qui décide qu'un prix est intéressant ;
     • la probabilité du MODÈLE (Poisson bivarié Dixon-Coles) est affichée à titre
       d'information. Mesure faite sur 6 050 matchs : lui donner le moindre poids face au
       marché dégrade la prédiction. Elle ne déclenche donc jamais un signal.              */

const CLE = "pronos-mobile.v1";
const DEFAUT = { bank: 100000, cur: "FCFA", kf: 0.25, maxStake: 2, seuil: 2, perteMax: 50000, champs: [], operateur: "", margeOp: 8 };
let E = { set: { ...DEFAUT }, journal: [] };
let JOUR = null, HISTO = null, SCORES = null;
let vue = "matchs", filtreJour = "tous", recherche = "";
let combine = [], tailleCombine = 4;
let FORCES = null;

/* ─────────── stockage ─────────── */
function charger() {
  try {
    const r = localStorage.getItem(CLE);
    if (r) { const o = JSON.parse(r); E.set = { ...DEFAUT, ...(o.set || {}) }; E.journal = o.journal || []; }
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
  $("#recherche-box").style.display = v === "matchs" ? "" : "none";
  window.scrollTo(0, 0);
  rendre();
}

/* ─────────── sélection ─────────── */
function matchsVisibles() {
  if (!JOUR) return [];
  let ms = JOUR.matchs.filter(m => m.d >= aujourdhui());
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
        ${nSig ? `<span class="tag t-pos" style="margin-left:auto">${nSig} signa${nSig > 1 ? "ux" : "l"}</span>` : ""}</div>
      <div class="eq"><span>${esc(m.h)}</span><span class="vs">contre</span><span>${esc(m.a)}</span></div>
      <div class="barre"><i class="b1" style="width:${100 * m.pH}%"></i><i class="bn" style="width:${100 * m.pD}%"></i><i class="b2" style="width:${100 * m.pA}%"></i></div>
      ${m.score ? `<div style="font-size:11.5px;color:var(--tx3);margin:-2px 0 7px">
        Score pronostiqué <b style="color:var(--tx2)">${esc(m.score)}</b>
        · buts attendus ${m.lH.toFixed(1)}–${m.lA.toFixed(1)}</div>` : ""}
      <div class="cotes">${cell("1", m.pH, m.cH)}${cell("Nul", m.pD, m.cD)}${cell("2", m.pA, m.cA)}</div>
    </div>`;
  });
  $("#liste-matchs").innerHTML = html;
  $("#liste-matchs").querySelectorAll(".match").forEach(c => c.onclick = () => ouvrirMatch(+c.dataset.i));
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
      C'est la meilleure estimation disponible ; l'écart se mesure par rapport à elle.</p>
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
    formulairePari({ ev: `${m.h} - ${m.a}`, sel: x.sel, cote: x.cote, m: Math.round(mise(x.p, x.cote)), p: x.p, d: m.d });
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
      formulairePari({ ev: `${x.m.h} - ${x.m.a}`, sel: x.sel, cote: x.cote, m: Math.round(mise(x.p, x.cote)), p: x.p, d: x.m.d });
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
    pModele *= (l.sel === "1" ? m.pH : l.sel === "N" ? m.pD : m.pA);
  }
  const mOp = Math.max(0, E.set.margeOp / 100);
  const parSelection = 1 / (1 + mOp);          // ce qui reste après la marge, par sélection

  /* Un combiné se place chez UN SEUL opérateur : additionner les meilleurs prix de
     six bookmakers différents donnerait une cote que personne ne propose. On calcule
     donc la cote totale bookmaker par bookmaker, et on retient le meilleur. */
  let book = null;
  if (JOUR.books) {
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
    espOp: pMarche * cote * Math.pow(parSelection, combine.length),
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
        <div class="lg"><span>À jouer en moyenne</span><b>${c.uneFoisSur.toFixed(0)} fois pour en gagner 1</b></div>
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
          Un combiné se place chez un seul opérateur : la cote affichée est celle du meilleur
          bookmaker unique, pas un assemblage des meilleurs prix de plusieurs sites.</p>
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
      d: combine.map(l => JOUR.matchs[l.i].d).sort().pop()
    });

    $("#c-legs").innerHTML = `<h2>Les ${c.n} sélections</h2>` + combine.map((l, k) => {
      const m = JOUR.matchs[l.i];
      const nom = l.sel === "1" ? m.h : l.sel === "2" ? m.a : "Match nul";
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
    return `<div style="margin-bottom:11px">
      <div style="font-size:13.5px;font-weight:600">${esc(m.h)} – ${esc(m.a)}</div>
      <div style="font-size:11.5px;color:var(--tx3);margin-bottom:5px">${esc(m.nom)} · ${libJour(m.d)}</div>
      <div class="pa">${opts.map(([sel, p, co]) =>
        `<button class="puce" data-add="${i}|${sel}|${p}|${co}">${sel} · ${f2(co)}</button>`).join("")}</div></div>`;
  }).join("") : '<p class="mut" style="font-size:12.5px;margin:0">Aucun match trouvé.</p>';
  boite.querySelectorAll("[data-add]").forEach(b => b.onclick = () => {
    const [i, sel, p, co] = b.dataset.add.split("|");
    if (combine.length >= 12) return alert("Douze sélections, c'est déjà bien au-delà du raisonnable.");
    combine.push({ i: +i, sel, p: +p, cote: +co });
    champ.value = "";
    rendreCombines();
  });
}

/* ─────────── scores : pronostic contre réalité ─────────── */
/* Chaque pronostic est archivé AVANT le match, puis confronté au score réel le lendemain.
   La comparaison avec le marché est affichée à côté : c'est elle qui donne l'échelle. */

function rendreScores() {
  if (!SCORES || !SCORES.matchs || !SCORES.matchs.length) {
    $("#s-bilan").innerHTML = `<div class="vide">Aucun résultat encore confronté.<br>
      <span style="font-size:12px">Les pronostics du jour seront comparés aux scores dès demain matin.</span></div>`;
    $("#s-liste").innerHTML = "";
    return;
  }
  const B = SCORES.bilan;
  const tauxModele = B.n ? B.okIssue / B.n : 0;
  const tauxMarche = B.nMarche ? B.okMarche / B.nMarche : null;
  $("#s-bilan").innerHTML = `
    <div class="bloc">
      <h2 style="margin-top:0">Ce que vaut le pronostic</h2>
      <div class="grid g2" style="margin-bottom:10px">
        <div class="stat"><i>Issue correcte</i><b>${pc(tauxModele, 1)}</b></div>
        <div class="stat"><i>Le marché, lui</i><b class="${tauxMarche > tauxModele ? "neg" : "pos"}">${tauxMarche == null ? "—" : pc(tauxMarche, 1)}</b></div>
        <div class="stat"><i>Score exact</i><b>${pc(B.exact / B.n, 1)}</b></div>
        <div class="stat"><i>Matchs jugés</i><b>${B.n}</b></div>
      </div>
      <div class="lg"><span>Erreur moyenne sur le nombre de buts</span><b>${B.erreurButs} but${B.erreurButs > 1 ? "s" : ""}</b></div>
      <div class="lg"><span>Erreur moyenne sur l'écart au score</span><b>${B.erreurEcart} but${B.erreurEcart > 1 ? "s" : ""}</b></div>
      <p style="font-size:12px;color:var(--tx2);margin:11px 0 0">
        ${tauxMarche != null && tauxMarche > tauxModele
          ? `Le marché désigne le bon vainqueur ${((tauxMarche - tauxModele) * 100).toFixed(1)} points plus souvent que le modèle. C'est la mesure, pas une opinion.`
          : `Le modèle fait jeu égal avec le marché sur cet échantillon — encore trop court pour en conclure quoi que ce soit.`}
        Un score exact tombe environ une fois sur ${Math.round(B.n / Math.max(1, B.exact))}.
      </p>
      ${SCORES.matchs.some(x => x.reconstruit) ? `<p style="font-size:11.5px;color:var(--tx3);margin:9px 0 0">
        Les journées antérieures à l'installation sont marquées « reconstruit » : le modèle y a été
        réajusté sur les seuls matchs antérieurs à chaque rencontre, mais ces pronostics n'ont pas
        été publiés à l'avance.</p>` : ""}
    </div>`;

  const parJour = {};
  for (const m of SCORES.matchs) (parJour[m.d] ||= []).push(m);
  const jours = Object.keys(parJour).sort().reverse().slice(0, 10);
  $("#s-liste").innerHTML = jours.map(j => {
    const ms = parJour[j].filter(m => !E.set.champs.length || E.set.champs.includes(m.div));
    if (!ms.length) return "";
    const bons = ms.filter(m => m.okIssue).length;
    return `<h2>${libJourPasse(j)} <span style="text-transform:none;letter-spacing:0;color:var(--tx3);font-weight:400">
        · ${bons}/${ms.length} issues trouvées</span></h2>` +
      ms.map(m => `<div class="sc ${m.exact ? "net" : m.okIssue ? "ok" : "ko"}">
        <div class="sh"><span class="sn">${esc(m.h)} – ${esc(m.a)}</span>
          <span class="sco">${esc(m.reel)}</span></div>
        <div class="sd">
          <span>prévu <b style="color:var(--tx2)">${esc(m.prevu)}</b></span>
          <span>attendu ${m.lH.toFixed(1)}–${m.lA.toFixed(1)}</span>
          <span class="tag ${m.exact ? "t-acc" : m.okIssue ? "t-pos" : "t-mut"}">
            ${m.exact ? "score exact" : m.okIssue ? "issue trouvée" : "raté"}</span>
          ${m.reconstruit ? '<span class="tag t-mut">reconstruit</span>' : ""}
          ${!m.fiable ? '<span class="tag t-warn">peu de données</span>' : ""}
        </div></div>`).join("");
  }).join("") || `<div class="vide">Aucun match pour les championnats sélectionnés.</div>`;
}
function libJourPasse(d) {
  if (d === aujourdhui()) return "Aujourd'hui";
  if (d === new Date(Date.now() - 864e5).toISOString().slice(0, 10)) return "Hier";
  const dt = new Date(d + "T12:00:00Z");
  return JOURS[dt.getUTCDay()] + " " + dt.getUTCDate() + "/" + String(dt.getUTCMonth() + 1).padStart(2, "0");
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
  return { n: clos.length, attente: E.journal.length - clos.length, mises, gain, gagnes, rend: mises ? gain / mises : 0 };
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
      <div class="pd">${esc(p.ev)} · ${p.date ? new Date(p.date).toLocaleDateString("fr-FR") : ""} · cote ${f2(p.cote)} · mise ${arg(p.mise)}</div>
      <div class="pa">${Object.keys(RES).map(k => `<button class="puce ${(p.res || "attente") === k ? "on" : ""}" data-r="${p.id}|${k}">${RES[k]}</button>`).join("")}
        <button class="puce" data-sup="${p.id}" style="margin-left:auto;color:var(--neg)">Supprimer</button></div></div>`;
  }).join("") : `<div class="vide">Aucun pari enregistré.</div>`;

  $("#liste-paris").querySelectorAll("button[data-r]").forEach(btn => btn.onclick = () => {
    const [id, r] = btn.dataset.r.split("|");
    const p = E.journal.find(x => x.id == id);
    if (p) { p.res = r; sauver(); rendreJournal(); majEntete(); }
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
          `<button class="puce" data-mk="${i}">${esc(lab)} · ${f2(c)}</button>`).join("")}</div>
        <button class="btn gh pt" style="margin-top:10px" id="p-autre">Changer de match</button>
      </div>`;
    $("#p-choisi").querySelectorAll("[data-mk]").forEach(b => b.onclick = () => {
      const [lab, c, pm] = marches[+b.dataset.mk];
      proba = pm || null;
      indexMarche = ["1", "N", "2"].indexOf(lab);
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
      sel: $("#f-sel").value.trim(), cote, mise: m, p: proba || v.p, res: "attente"
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
    `<button class="puce ${E.set.champs.includes(code) ? "on" : ""}" data-c="${code}">${esc(o.nom)}</button>`).join("")
    || `<span class="mut" style="font-size:13px">Championnats non chargés.</span>`;
  $("#r-champs").querySelectorAll("button").forEach(b => b.onclick = () => {
    const c = b.dataset.c;
    E.set.champs = E.set.champs.includes(c) ? E.set.champs.filter(x => x !== c) : [...E.set.champs, c];
    sauver(); rendreReglages();
  });
  $("#r-infos").innerHTML = JOUR ? `
    ${Object.keys(JOUR.championnats).length} championnats · ${JOUR.matchs.length} rencontres à venir<br>
    Dernière construction : ${new Date(JOUR.genere).toLocaleString("fr-FR")}<br>
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
  minuteur = setTimeout(() => { recherche = champQ.value.trim(); rendreFiltres(); rendreMatchs(); }, 160);
});
champQ.addEventListener("search", () => { if (!champQ.value) { recherche = ""; boutonQ.hidden = true; rendreFiltres(); rendreMatchs(); } });
boutonQ.onclick = () => { champQ.value = ""; recherche = ""; boutonQ.hidden = true; champQ.blur(); rendreFiltres(); rendreMatchs(); };

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

if ("serviceWorker" in navigator)
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => { }));
