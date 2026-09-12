/* Application mobile — pronostics du jour, écarts de prix et journal de paris.

   Les probabilités et les écarts sont précalculés chaque matin par outils/construire.mjs.
   Deux estimations coexistent, et leur statut n'est pas le même :

     • la probabilité de MARCHÉ (cotes moyennes, marge retirée par la méthode de la
       puissance) sert de référence ; c'est elle qui décide qu'un prix est intéressant ;
     • la probabilité du MODÈLE (Poisson bivarié Dixon-Coles) est affichée à titre
       d'information. Mesure faite sur 6 050 matchs : lui donner le moindre poids face au
       marché dégrade la prédiction. Elle ne déclenche donc jamais un signal.              */

const CLE = "pronos-mobile.v1";
const DEFAUT = { bank: 100000, cur: "FCFA", kf: 0.25, maxStake: 2, seuil: 2, perteMax: 50000, champs: [] };
let E = { set: { ...DEFAUT }, journal: [] };
let JOUR = null, HISTO = null;
let vue = "matchs", filtreJour = "tous";

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

/* ─────────── chargement des données ─────────── */
async function recuperer(reseauDabord) {
  const opt = reseauDabord ? { cache: "reload" } : {};
  const lire = async f => { try { const r = await fetch("donnees/" + f, opt); return r.ok ? await r.json() : null; } catch { return null; } };
  const [j, h] = await Promise.all([lire("jour.json"), lire("historique.json")]);
  if (j) JOUR = j;
  if (h) HISTO = h;
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
  journal: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  reglages: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'
};
const ONGLETS = [["matchs", "Matchs"], ["signaux", "Écarts"], ["journal", "Journal"], ["reglages", "Réglages"]];
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
  window.scrollTo(0, 0);
  rendre();
}

/* ─────────── sélection ─────────── */
function matchsVisibles() {
  if (!JOUR) return [];
  let ms = JOUR.matchs.filter(m => m.d >= aujourdhui());
  if (E.set.champs.length) ms = ms.filter(m => E.set.champs.includes(m.div));
  if (filtreJour !== "tous") ms = ms.filter(m => m.d === filtreJour);
  return ms;
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
  if (!ms.length) { $("#liste-matchs").innerHTML = `<div class="vide">Aucun match à venir pour ce filtre.<br><span style="font-size:12px">Les rencontres paraissent quelques jours à l'avance.</span></div>`; return; }
  const s = E.set.seuil / 100;
  let html = `<div class="note info" style="margin-bottom:12px">Sous chaque cote : la probabilité estimée par le modèle.
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
      <div class="cotes">${cell("1", m.pH, m.cH)}${cell("Nul", m.pD, m.cD)}${cell("2", m.pA, m.cA)}</div>
    </div>`;
  });
  $("#liste-matchs").innerHTML = html;
  $("#liste-matchs").querySelectorAll(".match").forEach(c => c.onclick = () => ouvrirMatch(+c.dataset.i));
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
    <div style="font-size:17px;font-weight:650;margin-bottom:14px">Enregistrer un pari</div>
    <div class="grid" style="gap:11px">
      <div><label>Événement</label><input id="f-ev" value="${esc(v.ev)}" placeholder="PSG - Marseille"></div>
      <div><label>Sélection</label><input id="f-sel" value="${esc(v.sel)}" placeholder="1"></div>
      <div class="ligne">
        <div style="flex:1"><label>Cote</label><input type="number" inputmode="decimal" step="0.01" id="f-cote" value="${v.cote}"></div>
        <div style="flex:1"><label>Mise</label><input type="number" inputmode="numeric" id="f-mise" value="${v.m}"></div>
      </div>
      <div><label>Date</label><input type="date" id="f-date" value="${v.d}"></div>
    </div>
    <button class="btn" style="margin-top:14px" id="f-ok">Enregistrer</button>
    <button class="btn gh" style="margin-top:9px" id="f-non">Annuler</button>`;
  $("#voile").classList.add("on"); $("#feuille").classList.add("on");
  $("#f-non").onclick = fermer;
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
      sel: $("#f-sel").value.trim(), cote, mise: m, p: v.p, res: "attente"
    });
    sauver(); fermer(); aller("journal");
  };
}

/* ─────────── réglages ─────────── */
const CHAMPS_R = [["r-bank", "bank"], ["r-cur", "cur"], ["r-kf", "kf"], ["r-max", "maxStake"], ["r-seuil", "seuil"], ["r-perte", "perteMax"]];
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
  else if (vue === "journal") rendreJournal();
  else if (vue === "reglages") rendreReglages();
  const p = $("#pastille");
  if (p && vue !== "signaux") { const n = signauxVisibles().length; p.hidden = !n; p.textContent = n; }
}

/* ─────────── démarrage ─────────── */
charger(); batirNav(); aller("matchs"); majEntete(); recuperer(false);

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
