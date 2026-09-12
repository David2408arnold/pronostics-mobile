/* Moteur de pronostic football — Poisson bivarié avec correction Dixon-Coles.
   Module partagé par le script de construction quotidienne et les tests.
   Portage du moteur validé dans pronostics.html. */

/* ─────────── lecture CSV ─────────── */
export function parseCSV(text) {
  text = text.replace(/^\ufeff/, "");
  const nl = text.indexOf("\n");
  const head = text.slice(0, nl > 0 ? nl : 200);
  const d = head.split(";").length > head.split(",").length ? ";" : ",";
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}
export function toObjects(rows) {
  const h = rows[0].map(x => x.trim());
  return rows.slice(1).map(r => { const o = {}; h.forEach((k, i) => o[k] = (r[i] || "").trim()); return o; });
}
export function pdate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += y > 70 ? 1900 : 2000; return Date.UTC(y, +m[2] - 1, +m[1]); }
  const m2 = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return Date.UTC(+m2[1], +m2[2] - 1, +m2[3]);
  const t = Date.parse(s); return isNaN(t) ? null : t;
}
export const num = v => { const x = parseFloat(String(v).replace(",", ".")); return isFinite(x) ? x : null; };
export function firstNum(o, keys) { for (const k of keys) { const v = num(o[k]); if (v && v > 1.01) return v; } return null; }

/* ─────────── résultats passés ─────────── */
export function lireResultats(text) {
  const out = [];
  for (const o of toObjects(parseCSV(text))) {
    const d = pdate(o.Date); if (!d) continue;
    const hg = num(o.FTHG ?? o.HG), ag = num(o.FTAG ?? o.AG);
    const h = (o.HomeTeam || o.Home || "").trim(), a = (o.AwayTeam || o.Away || "").trim();
    if (hg == null || ag == null || !h || !a) continue;
    out.push({
      d, div: (o.Div || "").trim(), h, a, hg, ag,
      // tirs et tirs cadres : matiere premiere d'un substitut de xG
      ht: num(o.HS), at: num(o.AS), htc: num(o.HST), atc: num(o.AST),
      oh: firstNum(o, ["AvgCH", "B365CH", "AvgH", "B365H"]),
      od: firstNum(o, ["AvgCD", "B365CD", "AvgD", "B365D"]),
      oa: firstNum(o, ["AvgCA", "B365CA", "AvgA", "B365A"])
    });
  }
  return out;
}

/* ─────────── matchs à venir ─────────── */

/* Bookmakers traditionnels présents dans fixtures.csv. Betfair Exchange (BFE) est
   volontairement exclu : ses cotes sont brutes de commission (2 à 5 %), les inclure
   fabriquerait des avantages qui n'existent pas.
   La colonne « Max » du fichier source n'est PAS utilisée : elle contient des valeurs
   incohérentes (maximum inférieur à un prix réellement affiché). On recalcule le
   meilleur prix à partir des colonnes individuelles, ce qui est vérifiable. */
const BOOKS_1X2 = [["B365H", "B365D", "B365A"], ["BFDH", "BFDD", "BFDA"], ["BVH", "BVD", "BVA"],
["BWH", "BWD", "BWA"], ["PPH", "PPD", "PPA"], ["SKBH", "SKBD", "SKBA"]];
/* Noms lisibles, dans l'ordre de BOOKS_1X2. Ce sont six opérateurs européens : ils servent
   de référence de prix, pas de recommandation — voir README. */
export const NOMS_BOOKS = ["Bet365", "Betfair Sportsbook", "BetVictor", "bwin", "Paddy Power", "Sky Bet"];
const BOOKS_OU = [["B365>2.5", "B365<2.5"]];
/* Écart maximal toléré entre un prix et la médiane des bookmakers. Au-delà de 8 %,
   sur un marché aussi liquide que le 1X2, il s'agit d'une cote périmée ou erronée. */
const ECART_MEDIANE = 1.08;

/** Meilleur prix par issue, résistant aux cotes aberrantes.

    Prendre le maximum brut est piégeux : une seule cellule périmée ou erronée suffit à
    fabriquer un avantage qui n'existe pas (constaté sur Paris FC – Lyon, où un bookmaker
    affichait 3.25 quand les six autres étaient entre 2.50 et 2.72). On retient donc le
    prix le plus élevé qui reste à portée de la médiane des bookmakers : au-delà, ce n'est
    pas une meilleure offre, c'est une donnée fausse.

    Retourne { max: [...], nb, rejets } */
function meilleurPrix(o, books) {
  const n = books[0].length;
  const colonnes = Array.from({ length: n }, () => []);
  let nb = 0;
  for (const cols of books) {
    const cotes = cols.map(c => num(o[c]));
    if (cotes.some(x => !x || x <= 1.01)) continue;
    nb++;
    cotes.forEach((c, i) => colonnes[i].push(c));
  }
  const max = new Array(n).fill(null);
  let rejets = 0;
  for (let i = 0; i < n; i++) {
    const v = colonnes[i].slice().sort((a, b) => a - b);
    if (!v.length) continue;
    const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    const plafond = ECART_MEDIANE * med;
    // le plus haut prix crédible : on descend tant que la cote dépasse le plafond
    let j = v.length - 1;
    while (j >= 0 && v[j] > plafond) { j--; rejets++; }
    max[i] = j >= 0 ? v[j] : null;
  }
  return { max, nb, rejets };
}

export function lireFixtures(text) {
  const out = [];
  for (const o of toObjects(parseCSV(text))) {
    const d = pdate(o.Date); if (!d) continue;
    const h = (o.HomeTeam || "").trim(), a = (o.AwayTeam || "").trim();
    if (!h || !a) continue;
    const avg1 = [num(o.AvgH), num(o.AvgD), num(o.AvgA)];
    const avgO = [num(o["Avg>2.5"]), num(o["Avg<2.5"])];
    const p1 = meilleurPrix(o, BOOKS_1X2);
    const po = meilleurPrix(o, BOOKS_OU);
    out.push({
      d, heure: (o.Time || "").trim(), div: (o.Div || "").trim(), h, a,
      maxH: p1.max[0], maxD: p1.max[1], maxA: p1.max[2], nb1x2: p1.nb, rejets: p1.rejets,
      parBook: BOOKS_1X2.map(cols => cols.map(c => num(o[c]))),
      avgH: avg1[0], avgD: avg1[1], avgA: avg1[2],
      maxO: po.max[0], maxU: po.max[1], nbOu: po.nb,
      avgO: avgO[0], avgU: avgO[1]
    });
  }
  return out;
}

/* ─────────── loi de Poisson ─────────── */
const FACT = [1]; for (let i = 1; i <= 25; i++) FACT[i] = FACT[i - 1] * i;
export const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / FACT[k];

/* ─────────── estimation des forces ─────────── */
export function ajuster(ms, opts = {}) {
  const { demiVie = 180, regul = 2.5, iters = 200, estimerRho = true } = opts;
  if (!ms.length) return null;
  const ref = opts.ref || Math.max(...ms.map(m => m.d));
  const HL = demiVie * 864e5;
  const teams = [...new Set(ms.flatMap(m => [m.h, m.a]))].sort();
  const ix = {}; teams.forEach((t, i) => ix[t] = i);
  const n = teams.length;
  const W = ms.map(m => Math.pow(0.5, (ref - m.d) / HL));
  const H = ms.map(m => ix[m.h]), A = ms.map(m => ix[m.a]);
  let att = new Array(n).fill(1), def = new Array(n).fill(1);
  const tw = W.reduce((s, x) => s + x, 0);
  let c = W.reduce((s, w, i) => s + w * (ms[i].hg + ms[i].ag), 0) / (2 * tw) || 1.35;
  let g = 1.3;
  const gs = new Array(n).fill(0), gc = new Array(n).fill(0), wn = new Array(n).fill(0);
  for (let i = 0; i < ms.length; i++) {
    const w = W[i], h = H[i], a = A[i];
    gs[h] += w * ms[i].hg; gc[h] += w * ms[i].ag; gs[a] += w * ms[i].ag; gc[a] += w * ms[i].hg;
    wn[h] += w; wn[a] += w;
  }
  const sh = regul * c;
  for (let it = 0; it < iters; it++) {
    let nh = 0, dh = 0;
    for (let i = 0; i < ms.length; i++) { nh += W[i] * ms[i].hg; dh += W[i] * c * att[H[i]] * def[A[i]]; }
    g = Math.max(0.8, Math.min(2.2, dh > 0 ? nh / dh : g));
    const dA = new Array(n).fill(0), dD = new Array(n).fill(0);
    for (let i = 0; i < ms.length; i++) {
      const w = W[i], h = H[i], a = A[i];
      dA[h] += w * c * g * def[a]; dA[a] += w * c * def[h];
      dD[a] += w * c * g * att[h]; dD[h] += w * c * att[a];
    }
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const na = (gs[i] + sh) / (dA[i] + sh || 1), nd = (gc[i] + sh) / (dD[i] + sh || 1);
      mx = Math.max(mx, Math.abs(na - att[i]), Math.abs(nd - def[i]));
      att[i] = Math.max(0.15, Math.min(4, na)); def[i] = Math.max(0.15, Math.min(4, nd));
    }
    let la = 0, ld = 0; for (let i = 0; i < n; i++) { la += Math.log(att[i]); ld += Math.log(def[i]); }
    const ma = Math.exp(la / n), md = Math.exp(ld / n);
    for (let i = 0; i < n; i++) { att[i] /= ma; def[i] /= md; }
    c *= ma * md;
    if (mx < 1e-7) break;
  }
  const ll = r => {
    let s = 0;
    for (let i = 0; i < ms.length; i++) {
      const l = c * g * att[H[i]] * def[A[i]], m = c * att[A[i]] * def[H[i]], x = ms[i].hg, y = ms[i].ag;
      let t = 1;
      if (x === 0 && y === 0) t = 1 - l * m * r; else if (x === 0 && y === 1) t = 1 + l * r;
      else if (x === 1 && y === 0) t = 1 + m * r; else if (x === 1 && y === 1) t = 1 - r;
      if (t <= 1e-6) return -1e12;
      s += W[i] * (Math.log(t) + Math.log(Math.max(pois(Math.min(x, 20), l), 1e-300)) + Math.log(Math.max(pois(Math.min(y, 20), m), 1e-300)));
    }
    return s;
  };
  /* rho suppose des buts entiers : sur une reponse continue comme les xG, on ne
     l'estime pas ici et on reprend celui du modele ajuste sur les buts reels. */
  let best = 0;
  if (estimerRho) {
    let bv = ll(0);
    for (let r = -0.24; r <= 0.14; r += 0.02) { const v = ll(r); if (v > bv) { bv = v; best = r; } }
    for (let r = best - 0.02; r <= best + 0.02; r += 0.004) { const v = ll(r); if (v > bv) { bv = v; best = r; } }
  }
  return { teams, ix, att, def, c, g, rho: best, n: ms.length, ref, wn };
}

/** Ajustement retenu : moyenne des buts et des tirs cadrés convertis au taux du
    championnat. Un but est un événement rare donc bruité ; les tirs cadrés corrigent
    une partie de ce bruit sans emporter le modèle, car pris seuls ils font moins bien.
    Mesuré en walk-forward sur 6 018 matchs (outils/tester-xg.mjs) :
      buts seuls 0,98888 · tirs cadrés seuls 0,99549 · mélange 0,98745.
    Le mélange gagne ou égalise sur les cinq championnats testés.
    rho reste estimé sur les buts réels : il suppose des scores entiers. */
export function ajusterMixte(ms, opts = {}) {
  const surButs = ajuster(ms, opts);
  if (!surButs) return null;
  let buts = 0, tirs = 0;
  for (const m of ms) {
    if (m.htc == null || m.atc == null) continue;
    buts += m.hg + m.ag; tirs += m.htc + m.atc;
  }
  if (tirs <= 0) return surButs;                  // pas de tirs disponibles : on garde les buts
  const taux = buts / tirs;
  const melange = ms.map(m => (m.htc == null || m.atc == null) ? m : {
    ...m,
    hg: (m.hg + m.htc * taux) / 2,
    ag: (m.ag + m.atc * taux) / 2
  });
  const M = ajuster(melange, { ...opts, estimerRho: false });
  if (!M) return surButs;
  return { ...M, rho: surButs.rho, conversion: taux };
}

export function lambdas(M, home, away) {
  const i = M.ix[home], j = M.ix[away];
  if (i == null || j == null) return null;
  return [M.c * M.g * M.att[i] * M.def[j], M.c * M.att[j] * M.def[i]];
}
export function grille(l, m, rho, maxG = 10) {
  const P = []; let tot = 0;
  for (let x = 0; x <= maxG; x++) {
    P[x] = [];
    for (let y = 0; y <= maxG; y++) {
      let t = 1;
      if (x === 0 && y === 0) t = 1 - l * m * rho; else if (x === 0 && y === 1) t = 1 + l * rho;
      else if (x === 1 && y === 0) t = 1 + m * rho; else if (x === 1 && y === 1) t = 1 - rho;
      const v = Math.max(0, t * pois(x, l) * pois(y, m));
      P[x][y] = v; tot += v;
    }
  }
  for (let x = 0; x <= maxG; x++) for (let y = 0; y <= maxG; y++) P[x][y] /= tot;
  return P;
}
export function marches(P) {
  const G = P.length - 1; let H = 0, D = 0, A = 0, btts = 0, o25 = 0, o15 = 0, o35 = 0;
  const scores = [];
  for (let x = 0; x <= G; x++) for (let y = 0; y <= G; y++) {
    const p = P[x][y];
    if (x > y) H += p; else if (x === y) D += p; else A += p;
    if (x > 0 && y > 0) btts += p;
    if (x + y > 1.5) o15 += p;
    if (x + y > 2.5) o25 += p;
    if (x + y > 3.5) o35 += p;
    if (p > 0.004) scores.push([x + "-" + y, p]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return { H, D, A, btts, o15, o25, o35, scores: scores.slice(0, 5) };
}

/* ─────────── cotes ─────────── */
/** Retire la marge du bookmaker par la méthode de la puissance : on cherche k tel que
    Σ (1/cote)^k = 1. Contrairement au retrait proportionnel, cette méthode comprime
    davantage les petites probabilités, ce qui corrige le biais favori / outsider.
    Mesuré sur 7 988 matchs (outils/comparer-marge.mjs) : meilleure log-loss et meilleure
    calibration que le proportionnel et que la méthode de Shin. */
export function sansMarge(cotes) {
  const r = cotes.map(o => 1 / o);
  let lo = 0.5, hi = 3;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (r.reduce((a, x) => a + Math.pow(x, k), 0) > 1) lo = k; else hi = k;
  }
  const p = r.map(x => Math.pow(x, (lo + hi) / 2));
  const s = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / s);
}

/** Retrait proportionnel, conservé pour comparaison. */
export function sansMargeProportionnelle(cotes) {
  const raw = cotes.map(o => 1 / o), s = raw.reduce((a, b) => a + b, 0);
  return raw.map(r => r / s);
}
/** Marge du parieur : espérance de gain par unité misée. */
export const marge = (p, cote) => p * cote - 1;
/** Fraction de Kelly complète (à multiplier ensuite par la fraction choisie). */
export const kelly = (p, cote) => cote > 1 ? Math.max(0, (p * cote - 1) / (cote - 1)) : 0;

/* ─────────── appariement des noms ─────────── */
const STOP = /\b(fc|cf|ac|as|sc|cd|ud|sv|vfl|vfb|tsg|bsc|rc|rcd|afc|ssc|us|ss|sk|ca|calcio|club|de|the|and|of)\b/g;
export function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(STOP, " ").replace(/\s+/g, " ").trim();
}
/** Apparie un nom d'équipe à la liste connue du modèle (les fichiers résultats et
    fixtures de football-data utilisent la même nomenclature : l'appariement exact
    couvre l'immense majorité des cas, le flou ne sert que de filet de sécurité). */
export function apparier(nom, equipes) {
  if (equipes.includes(nom)) return nom;
  const a = norm(nom);
  let best = null, bs = 0;
  for (const t of equipes) {
    const b = norm(t);
    if (b === a) return t;
    const ta = new Set(a.split(" ").filter(Boolean)), tb = new Set(b.split(" ").filter(Boolean));
    let inter = 0;
    for (const x of ta) for (const y of tb) {
      if (x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y))) { inter++; break; }
    }
    const sc = inter / Math.max(1, Math.min(ta.size, tb.size)) * (1 - Math.abs(ta.size - tb.size) * 0.08);
    if (sc > bs) { bs = sc; best = t; }
  }
  return bs >= 0.6 ? best : null;
}

export const CHAMPIONNATS = {
  F1: "Ligue 1", F2: "Ligue 2", E0: "Premier League", E1: "Championship", E2: "League One",
  E3: "League Two", EC: "National", SP1: "LaLiga", SP2: "LaLiga 2", I1: "Serie A", I2: "Serie B",
  D1: "Bundesliga", D2: "Bundesliga 2", N1: "Eredivisie", B1: "Jupiler Pro League",
  P1: "Liga Portugal", T1: "Süper Lig", G1: "Super League Grèce",
  SC0: "Scottish Premiership", SC1: "Scottish Champ.", SC2: "Scottish League One", SC3: "Scottish League Two"
};
