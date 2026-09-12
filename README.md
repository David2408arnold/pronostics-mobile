# Pronostics — application mobile

Application web installable (PWA) : probabilités de matchs de football, comparaison avec les
prix du marché, et journal de paris. Les données sont reconstruites automatiquement chaque matin.

## Installation sur Android

1. Ouvrir l'adresse du site dans **Chrome**.
2. Menu ⋮ → **Ajouter à l'écran d'accueil** (ou la bannière « Installer »).
3. L'icône apparaît comme celle d'une application native : plein écran, fonctionne hors connexion.

Sur iPhone : Safari → bouton Partager → **Sur l'écran d'accueil**.

## Ce que fait le système, chaque matin

Une tâche planifiée (GitHub Actions, 05:40 UTC) :

1. télécharge les résultats des 3 dernières saisons de 22 championnats européens ;
2. ré-estime la force d'attaque et de défense de chaque équipe (Poisson bivarié Dixon-Coles,
   pondération temporelle à demi-vie de 180 jours) ;
3. télécharge les rencontres à venir avec les cotes de 6 bookmakers ;
4. calcule pour chaque match les probabilités du modèle et celles du marché ;
5. règle les signaux passés sur les résultats réels et met à jour le bilan ;
6. publie `donnees/jour.json`, `donnees/forces.json`, `donnees/historique.json`.

Le téléphone ne fait que lire ces fichiers. Aucune clé API, aucun quota, aucun compte.

## Ce que les mesures disent

Trois résultats, tous reproductibles avec les scripts de `outils/` :

**1. Le modèle est moins bon que le marché.** `outils/calibrer.mjs` cherche le poids `w`
optimal dans `p = w · p_modèle + (1 − w) · p_marché`, en walk-forward strict sur 6 050 matchs
de 5 grands championnats.

| poids du modèle | 0 | 0,2 | 0,5 | 0,8 | 1 |
|---|---|---|---|---|---|
| log-loss | **0,96551** | 0,96784 | 0,97353 | 0,98189 | 0,98906 |

L'optimum est `w = 0`. Chaque point de poids donné au modèle dégrade la prédiction.
Le modèle est donc affiché comme lecture d'un match — buts attendus, score probable —
mais ne déclenche jamais un signal.

**2. Le retrait de marge proportionnel est biaisé.** `outils/comparer-marge.mjs` compare trois
méthodes sur 7 988 matchs. La méthode de la puissance (chercher `k` tel que `Σ (1/cote)^k = 1`)
gagne en log-loss et en calibration, en particulier sur les favoris :

| tranche | proportionnelle | puissance |
|---|---|---|
| 50–70 % | annoncé 58,6 % → réel 60,4 % (+1,8) | 58,6 % → 58,6 % (**0,0**) |
| 70–100 % | annoncé 76,6 % → réel 79,9 % (+3,2) | 77,5 % → 78,8 % (**+1,3**) |

La même mesure montre que sous 10 % de probabilité, toutes les méthodes surestiment d'environ
2 points. Ces issues sont donc exclues des signaux : c'est là que naissent les faux avantages.

**3. Les données brutes contiennent des cotes aberrantes.** La colonne `Max` de `fixtures.csv`
est inutilisable (elle affiche parfois un « maximum » inférieur à un prix réellement proposé),
et un bookmaker isolé peut afficher une cote périmée — observé sur Paris FC – Lyon : 3.25 quand
les six autres étaient entre 2.50 et 2.72. Prendre le maximum brut transforme chaque cellule
fausse en faux signal. Le meilleur prix est donc recalculé à partir des colonnes individuelles,
en écartant tout prix dépassant de plus de 8 % la médiane des bookmakers, et en excluant
Betfair Exchange dont les cotes sont brutes de commission.

**Conséquence : l'application affiche très peu de signaux, souvent aucun.** C'est le
comportement correct face à un marché efficace. Le jour de la mise en service, sur 141 matchs
exploitables, le meilleur écart disponible était de 1,6 % — sous le seuil.

## Les six bookmakers affichés

Bet365, Betfair Sportsbook, BetVictor, bwin, Paddy Power et Sky Bet. Ce sont des opérateurs
**européens**, retenus parce que football-data publie leurs cotes de façon fiable. Ils servent
de **référence de prix** : ils permettent de juger si la cote de ton propre opérateur est
correcte. Aucun d'eux ne propose le mobile money en Côte d'Ivoire, et la plupart n'acceptent
pas les comptes ivoiriens.

**Pour tous les autres — Betclic, 1xBet, Akabet, Sportcash, Premier Bet…** — aucune source
ne publie leurs cotes de façon exploitable. Le détail de chaque match contient donc un
**comparateur** : tu saisis les trois cotes affichées par ton opérateur, et l'application
calcule sa marge réelle sur ce match, la compare au meilleur prix des six books, et indique
l'issue la moins désavantageuse. Ça fonctionne avec n'importe quel bookmaker, puisque le
calcul ne dépend que des cotes.

Ordre de grandeur : 5–7 % de marge est correct, 7–12 % est cher, au-delà de 12 % aucun
pronostic ne rattrape le prix payé.

L'application ne classe pas les opérateurs par fiabilité de retrait : ce serait une
information que je n'ai pas les moyens de vérifier, qui change souvent, et se tromper dessus
coûte de l'argent réel. Pour choisir un opérateur, la seule méthode fiable reste :

1. vérifier son agrément auprès du régulateur local (LONACI) avant tout dépôt ;
2. faire valider son identité **avant** de déposer, pas au moment du retrait ;
3. tester un petit retrait par mobile money avant d'engager une somme réelle.

## Vérifier soi-même

```bash
node outils/construire.mjs                 # reconstruire les données du jour
node outils/calibrer.mjs <dossier_csv>     # poids optimal du modèle
node outils/comparer-marge.mjs <dossier>   # méthodes de retrait de marge
```

Les CSV historiques se téléchargent depuis <https://www.football-data.co.uk>.

## Organisation

```
index.html   style.css   app.js        interface
sw.js        manifest.webmanifest      installation et fonctionnement hors ligne
outils/modele.mjs                      moteur : CSV, Dixon-Coles, retrait de marge
outils/construire.mjs                  construction quotidienne
outils/calibrer.mjs                    mesure du poids du modèle
outils/comparer-marge.mjs              mesure des méthodes de retrait de marge
donnees/                               sorties, régénérées chaque matin
```

Le journal de paris et les réglages restent dans le stockage local du téléphone : ils ne sont
jamais envoyés ni publiés.

## Cadre légal

Betclic n'est pas agréé en Côte d'Ivoire ; le régulateur local est la LONACI. Vérifier la
situation applicable avant tout dépôt : un compte ouvert hors juridiction autorisée peut être
bloqué au moment du retrait, gains compris.
