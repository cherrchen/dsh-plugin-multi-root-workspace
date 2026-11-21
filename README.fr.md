<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

<img alt="GitHub License" src="https://img.shields.io/github/license/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="NPM Version" src="https://img.shields.io/npm/v/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">
<img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">

[中文](./README.md) | [English](./README.en.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | Français | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | [Português](./README.pt.md)

</div>

## Présentation du projet

Par défaut, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) considère le répertoire dans lequel un nouvel espace de travail est créé comme le répertoire principal de l'agent ; dans le mode lecture-écriture par défaut de l'espace de travail (`workspace-write`), la portée en lecture-écriture du bac à sable se limite elle aussi à ce seul répertoire. Ce plugin étend la portée de l'espace de travail de DSH à « une racine principale + plusieurs racines supplémentaires ».

Tous les projets ne sont pas des monorepos. Un projet de développement se compose souvent de plusieurs dépôts Git indépendants, et travailler sur plusieurs d'entre eux imposait jusqu'ici de changer de session à répétition. Les outils comparables savent déjà ajouter plusieurs dossiers à un même espace de travail ; ce plugin apporte la même capacité à DSH : enregistrez les autres dépôts comme racines supplémentaires, réglez chacune en lecture seule, en lecture-écriture ou sur les autorisations courantes de la session, et l'agent peut lire et écrire dans les limites de cette autorisation.

- **Outils natifs** : dans les espaces de travail locaux, l'agent continue d'utiliser les outils natifs `read` / `write` / `edit` / `bash` ; il dispose simplement de quelques répertoires accessibles en plus.
- **Des autorisations réellement appliquées** : chaque racine supplémentaire peut être en lecture seule, en lecture-écriture, ou suivre les autorisations de la session courante ; la restriction est appliquée par le bac à sable du système, et non par un rappel dans le prompt adressé au modèle. Les opérations de fichiers et les commandes bash de l'agent relèvent du même jeu d'autorisations ; les processus lancés par d'autres plugins sortent de cette garantie.
- **Parcourir les racines supplémentaires dans l'onglet Files** : l'en-tête de l'onglet Files permet de basculer entre la racine principale et n'importe quelle racine supplémentaire ; l'arborescence, l'ouverture de fichiers, l'ouverture dans une application externe, les menus contextuels, l'actualisation automatique et la recherche se comportent comme pour la racine principale, et le navigateur de l'aperçu de document se place lui aussi sur la racine qui contient le fichier. Sur un hôte plus ancien, certaines de ces actions peuvent être indisponibles, et la racine supplémentaire conserve l'affichage natif de l'hôte.
- **Skills des racines supplémentaires** : découverte automatique des `.dsh/skills` et `.agents/skills` dans les racines supplémentaires, appelables via `/alias:nom-du-skill` ; chaque racine dispose de son propre interrupteur, activé par défaut.
- **Auto Review (expérimental, désactivé par défaut)** : une fois activé dans le gestionnaire de plugins, Auto Review voit aussi l'arborescence, les niveaux d'accès et les fichiers d'instructions des racines supplémentaires, et les intègre à sa revue.
- **Suggestions Worktree (expérimental, désactivé par défaut)** : lorsque la racine principale est un Worktree Git, le plugin propose d'ajouter les autres Worktrees du même dépôt comme racines supplémentaires ; rien n'est enregistré avant votre confirmation, et rien n'est ajouté ni supprimé automatiquement.
- **Environnements distants SSH (expérimental, désactivé par défaut, non publié)** — Activez le mode SSH personnel dans la fiche du plugin pour utiliser `remote_copy` et `remote_bash` sur les répertoires distants enregistrés. Les connexions et les liaisons aux espaces de travail se gèrent séparément, et le Registry autorise chaque appel.
- **Sans enregistrement, comme non installé** : sans aucune racine supplémentaire, le comportement est identique à celui d'un plugin non installé ; une configuration erronée signale une erreur au lieu de dégrader silencieusement.

Version publiée actuelle : `v0.1.23`. Les changements visibles par l'utilisateur de chaque version figurent dans le [CHANGELOG](./CHANGELOG.en.md) ; l'avancement et l'état des publications figurent dans le [grand livre de progression de la feuille de route](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Démarrage rapide

Le plugin est publié sur [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace). Pour les profils en ligne de commande (`web`, `headless`, etc.), l'installation tient en deux commandes :

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # choisissez le --profile correspondant à votre lancement ; les valeurs possibles sont dans la doc DSH
```

**Utilisateurs de DSH Desktop** : saisissez `@dsh-electron/dsh-plugin-multi-root-workspace` dans la page **Plugins** pour l'installer ; si le démarrage signale une erreur, redémarrez DeepSeek Harness Desktop.

Les autres modes d'installation (tarball, GitHub, sources locales) sont décrits dans [Installation](#installation).

Après l'installation, ajoutez une racine supplémentaire dans une session :

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

## Prérequis

**Pour utiliser le plugin** : une version de DSH parmi celles du tableau ci-dessous (correspondance exacte, pas une plage de versions). `dsh plugin` se charge de l'installation ; aucune chaîne d'outils Node locale n'est nécessaire.

| Ligne DSH | Versions prises en charge |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5` |

Le plugin ne démarre pas — comme s'il n'était pas installé — lorsque la version de DSH n'est pas dans le tableau ou que les paquets `@deepseek-ai/dsh-*` ne sont pas tous sur la même version.

**Compiler depuis les sources / contribuer** : Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (à activer de préférence via corepack) ; la version DSH épinglée pour le développement est `0.2.2-rc.5` (Node ≥24.9).

**Plateformes** : macOS (Seatbelt), Linux (bwrap / Landlock), Windows (root-set ACL runner).

## Installation

L'installation se fait de deux manières : en ligne de commande (CLI), ou via le gestionnaire de plugins de l'interface graphique Web / Desktop. L'une ou l'autre suffit.

### Installer via la CLI

`dsh plugin` accepte quatre sources d'installation, illustrées ici avec le profil `web` ; les profils CLI comme `headless` fonctionnent de la même façon. **Utilisateurs de DSH Desktop** : le profil `desktop` se gère avec la CLI `dsh` intégrée à DeepSeek Harness Desktop — la procédure figure à la fin de cette section.

| Source | Commande | Remarques |
| --- | --- | --- |
| Registre npm (recommandé) | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | Artefacts précompilés, prêts à l'emploi |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | Compilation automatique depuis les sources à l'installation ; `allowBuilds` doit contenir la clé exacte de ce paquet — épinglez une version |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | Paquet hors ligne précompilé, adapté aux réseaux isolés ou à la livraison hors ligne |
| Depuis les sources | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | Lien pnpm `link:` vers un checkout local, adapté au développement ; aucun `allowBuilds` nécessaire |

#### Installer depuis npm (recommandé)

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

Il s'agit d'artefacts précompilés.

#### Installer depuis un tarball

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# ou téléchargez le tgz depuis les assets de la GitHub Release, par exemple :
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.23/dsh-electron-dsh-plugin-multi-root-workspace-0.1.23.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.23.tgz
```

Là encore, des artefacts précompilés, adaptés à une livraison en réseau isolé ou hors ligne.

#### Installer depuis GitHub

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

Une installation depuis GitHub récupère le code source et le compile automatiquement lors du `add`, sans compilation manuelle ; pnpm bloque le `prepare` du paquet lui-même et affiche une ligne contenant la clé exacte (source et commit inclus). Recopiez cette ligne telle quelle dans `allowBuilds`, puis relancez `add` :

```yaml
allowBuilds:
  # La clé et la valeur proviennent de l'exemple « Add the package to allowBuilds » affiché par pnpm ;
  # une clé réduite au nom du paquet, sans source ni commit, ne s'applique pas aux sources git.
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

Il est recommandé d'épingler une version (par exemple `#v0.1.23`), afin qu'un push ultérieur ne puisse pas modifier silencieusement ce qui s'exécute réellement :

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.23
```

#### Installer depuis les sources locales

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> Si `dsh` n'est pas dans le PATH (par exemple lorsque DSH tourne depuis un checkout des sources), remplacez `dsh` par `pnpm dsh` dans les commandes.

<details>
<summary>Exécution</summary>

Contrôles de développement :

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

Installer dans un runtime DSH et vérifier la composition :

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

Sortie attendue :

```text
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true
--
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true
--
# == @dsh-electron/dsh-plugin-multi-root-workspace
- id: multi-root-compat
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/compat'
- id: multi-root-fs
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
- id: multi-root-sandbox
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
- id: multi-root-providers
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/providers'
- id: multi-root-scope
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  config:
    toolAccess: {}
- id: multi-root-registry
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    maxAdditionalRoots: 16
- id: multi-root-instructions
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/instructions'
  config:
    maxBytes: 65536
- id: multi-root-lsp
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/lsp'
- id: multi-root-workspace-files
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/workspace-files'
- id: multi-root-command
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
- id: multi-root-client
  name: '@dsh-electron/dsh-plugin-multi-root-workspace'
```

Les deux lignes `fs-sandbox` et `sandbox` de l'amont sont désactivées et reprises par les services homonymes du plugin, et toutes les lignes `multi-root-*` du plugin sont montées. Après le démarrage, une action **Dossiers** (glyphe d'arborescence) apparaît en bas de la barre latérale ; à partir de DSH `0.2.1-alpha.3`, la même entrée s'affiche également à l'extrémité droite de la ligne d'espace de travail de la page de nouvelle session.

</details>

#### Installer avec la CLI intégrée à DeepSeek Harness Desktop

DeepSeek Harness Desktop peut installer une commande `dsh` globale depuis l'entrée **Manage dsh Command…** de son menu d'application ; le profil `desktop` de DeepSeek Harness Desktop se gère avec cette commande.

1. Quittez complètement Desktop, icône de la zone de notification comprise.
2. Installation neuve :
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.23
   ```
3. Déjà installé mais entrée de bundle manquante : faites `remove`, puis `add` (relancer `add` seul ne complète pas l'enregistrement) :
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.23
   ```
4. Ouvrez `$DSH_HOME/profiles/desktop/package.json` (généralement `~/.dsh/profiles/desktop/package.json` lorsque `DSH_HOME` n'est pas défini) et vérifiez que `dsh.profile.bundles` contient ce paquet.
5. Rouvrez Desktop (démarrage à froid).

Si `add` se termine avec le code 0 sans que le plugin entre dans `dsh.profile.bundles`, exécutez une fois `remove` + `add`. Les causes du conflit d'activation à chaud, le relevé de reproduction et l'enquête sur les écritures réelles sont documentés dans le [dépannage](./docs/troubleshooting/desktop-install-missing-bundle.md).

### Installer via le gestionnaire de plugins Web / Desktop

Web et Desktop installent tous deux depuis la page **Plugins** de la barre latérale : cliquez sur **Ajouter une extension**, saisissez `@dsh-electron/dsh-plugin-multi-root-workspace` dans le champ, puis installez. Une fois l'installation terminée, cliquez sur **Activer maintenant** — une simple installation n'active pas le plugin. Si la page **Plugins** n'offre pas d'entrée **Ajouter une extension**, utilisez la CLI ci-dessus.

Après l'installation ou l'activation, redémarrez l'application DeepSeek Harness : pour Desktop, quittez complètement l'application (icône de la zone de notification comprise) puis rouvrez-la ; pour Web, redémarrez le processus `dsh web`. Activer ce plugin à chaud dans une application en cours d'exécution peut signaler un double enregistrement de `fs` / `sandbox` ; après redémarrage, le chargement se fait normalement.

## Utilisation

### Commande

```text
/workspace-folders [list]                                                   # liste la racine principale et les racines supplémentaires (autorisations et état de chaque racine inclus)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # sans chemin, ouvre le sélecteur de répertoire du système ; une nouvelle racine est en inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # raccourci de /workspace-folders add
/workspace-folders access <order|path> inherit|read-only|read-write         # change le niveau d'accès (toute extension exige que la racine soit disponible à cet instant)
/workspace-folders skills <order|path> on|off                               # active ou désactive les Skills de cette racine sans changer les droits d'écriture
/workspace-folders alias-id <order|path> <kebab-case>                       # modifie l'espace de noms stable des Skills
/workspace-folders alias <order|path> [alias]                               # sans alias, efface l'alias existant
/workspace-folders remove <order|path>                                      # l'ordre correspond au numéro affiché par list
/workspace-folders reveal <order|path>                                      # affiche dans le gestionnaire de fichiers
/workspace-folders isolate-profiles [--apply]                               # inspecte (--apply écrit) la méthode d'import des dépendances des profils
/workspace-folders help                                                     # affiche l'aide de la commande
```

- Les chemins peuvent être entre guillemets et `~` est développé ; un doublon, un chemin imbriqué dans une racine existante, la racine principale elle-même, ainsi que les chemins protégés comme `$DSH_HOME` ou le répertoire de stockage du Registry sont refusés.
- `remove` / `access` / `alias` / `reveal` acceptent `order|path` ; `add` sans chemin ouvre le sélecteur de répertoire du système (lorsque l'hôte en fournit un) et peut aussi ne recevoir que l'option d'autorisation.
- `list` affiche l'autorisation et l'état de chaque racine. Lorsqu'un répertoire manque temporairement (`missing`) ou a été remplacé par un lien pointant ailleurs (`redirected`), la racine conserve son enregistrement mais reste sans autorisation ; une fois le répertoire rétabli, un `list` ou une actualisation de **Dossiers de l’espace de travail** rétablit l'autorisation automatiquement.
- `isolate-profiles` sert de précontrôle pour l'accès complet restreint sous Windows : par défaut, il inspecte seulement `packageImportMethod` de chaque profil sous `$DSH_HOME`, et `--apply` écrit la configuration `copy` ; il ne supprime pas `node_modules` et ne modifie pas les dépendances existantes.

### Niveaux d'accès

| Niveau d'accès | Session `workspace-write` | Session `read-only` | Session `danger-full-access` |
| --- | --- | --- | --- |
| `inherit` (valeur par défaut des nouvelles racines) | écriture autorisée | écriture refusée | sans restriction |
| `read-only` | écriture refusée | écriture refusée | écriture refusée (y compris en accès complet) |
| `read-write` | écriture autorisée | écriture autorisée | écriture autorisée |

- Une nouvelle racine est en `inherit` par défaut ; un changement d'autorisation ne contraint que les appels ultérieurs et les nouveaux processus, les processus déjà lancés et les terminaux persistants conservant les autorisations de leur démarrage.
- Une élévation `danger-full-access` ponctuelle, approuvée par l'utilisateur pour un appel donné, lève les refus liés aux racines en lecture seule et au plafond par outil pour cet appel uniquement ; `$DSH_HOME` et le repli dû à l'indisponibilité du Registry ne sont pas affectés.
- Une racine principale accepte au maximum 16 racines supplémentaires (`maxAdditionalRoots` peut être porté à 64). L'hôte peut plafonner durablement un outil pour toutes les racines supplémentaires via `toolAccess` sur la ligne `multi-root-scope` — par exemple `{ bash: 'read-only' }` empêche bash d'écrire dans une racine supplémentaire (il peut toujours écrire dans la racine principale).

### Skills des racines supplémentaires

- La découverte automatique couvre les `.dsh/skills` et `.agents/skills` de chaque répertoire supplémentaire ; les noms et les descriptions sont disponibles avant la première étape du modèle, et les corps sont chargés à la demande.
- La racine principale utilise `/skill-name` ; les racines supplémentaires utilisent `/alias-id:skill-name` (complétion dans le menu Slash). Le modèle les appelle via l'outil natif `skill`, si bien que des ID internes peuvent apparaître dans les journaux d'outils.
- Les nouvelles racines `inherit` / `read-write` ont les Skills activés par défaut, les racines `read-only` les ont désactivés ; la boîte de dialogue offre un interrupteur par racine et permet de modifier `aliasId` (changer l'alias affiché ne modifie pas `aliasId`). Activer les Skills sur une racine en lecture seule n'accorde aucun droit d'écriture.
- Dans la page **Plugins** de la barre latérale, ouvrez la page de détail de Multi-root Workspace ; l'option **Activer les Skills des racines supplémentaires** de la carte de réglages contrôle toutes les racines supplémentaires et est activée par défaut. La désactiver arrête les nouvelles découvertes et les nouveaux appels, tout en conservant le choix de chaque racine ; les Skills de la racine principale, les instructions, le LSP, la navigation de fichiers et les autorisations du bac à sable ne sont pas affectés.

### Suggestions de racines Worktree (expérimental, désactivé par défaut)

Lorsque la racine principale est la racine d'un Worktree Git, le plugin liste les autres Worktrees du même dépôt comme candidats dans une même carte de suggestion — y compris les Worktrees créés auparavant par un terminal, un IDE ou une forge ; si la session est elle-même un linked worktree en `workspace-write`, le checkout principal du dépôt apparaît lui aussi comme candidat. La découverte ne lit que les métadonnées Git et ne lance aucun sous-processus Git ; elle **n'ajoute ni ne retire jamais de racine d'elle-même**, et une session `danger-full-access` ne reçoit aucune suggestion. Dans la page **Plugins** de la barre latérale, ouvrez la page de détail de Multi-root Workspace et activez **Activer les suggestions de racines Worktree** dans la carte de réglages (désactivé par défaut) pour que le dispositif prenne effet.

La suggestion est une carte persistante : choisissez **Voir** ou **Me rappeler plus tard** (jusqu'à l'apparition d'un nouveau Worktree / dans 7 jours / dans 30 jours) ; le bouton de fermeture en haut à droite ne ferme que la notification en cours, qui réapparaît après un redémarrage. Une fois la carte fermée, rouvrez-la depuis **Suggestions Worktree**, à côté de **Réessayer** dans la boîte de dialogue **Dossiers de l’espace de travail**. La boîte de dialogue de confirmation affiche pour chaque ligne le chemin, la branche et l'autorisation (`inherit` par défaut, modifiable en lecture seule ou en lecture-écriture), avec des cases à cocher lorsqu'il y a plusieurs candidats ; la ligne du checkout principal précise en plus sa portée : l'arborescence source du checkout principal, les config/hooks/refs/objects partagés et les données d'administration de tous les Worktrees, ce qui peut affecter d'autres checkouts du même dépôt. L'enregistrement est au niveau de l'espace de travail : **les autres sessions en lecture-écriture obtiennent donc aussi l'autorisation choisie** ; la confirmation revalide chaque ligne, et tout changement survenu entre-temps invalide la ligne concernée. La boîte de dialogue propose également **Ne plus jamais me rappeler**.

Lorsqu'un Worktree est supprimé ou déplacé, la boîte de dialogue affiche un badge, mais **rien n'est jamais nettoyé automatiquement** ; le nettoyage n'est proposé que si le répertoire est confirmé absent et que l'identité de l'enregistrement correspond (en lot ou ligne par ligne), derrière une boîte de dialogue de confirmation superposée. Avant le nettoyage, un nouveau répertoire au même chemin peut hériter de l'ancienne autorisation ; la boîte de dialogue signale ce risque.

### Intégration Auto Review (expérimental, désactivé par défaut)

Pour disposer d'un contexte de revue multi-racines, activez la ligne Auto Review, désactivée par défaut, dans la liste des composants de la page de détail de Multi-root Workspace, sur la page **Plugins** de la barre latérale ; l'interrupteur **Auto Review multi-racines (expérimental)** de la même carte de réglages est équivalent et également désactivé par défaut. Une installation ordinaire n'active ni ne sélectionne Auto Review ; l'intégration n'est disponible que sur les versions exactes de DSH qui la fournissent.

### Environnements distants SSH (expérimental, désactivé par défaut, non publié)

Le ticket nº 32 ouvre pour l’instant le seul mode SSH personnel. Activez **Environnements distants SSH** dans les paramètres du plugin et confirmez l’avertissement. Le processus DSH local détient les identifiants SSH. D’autres processus du même compte système peuvent y accéder. Gérez les connexions depuis « SSH distant → Gérer » dans les paramètres ou « Gérer les hôtes SSH distants » dans les dossiers de l’espace de travail.

**Mode personnel.** Ouvrez « Gérer les environnements distants SSH » → « Ajouter une connexion ». Renseignez l’hôte et les identifiants, puis confirmez la clé de l’hôte pour enregistrer la connexion. À la deuxième étape, détectez Node et installez le helper, puis cochez « Autoriser l’exécution de commandes » et cliquez sur « Terminer » pour enregistrer. Revenez aux dossiers de l’espace de travail et ouvrez « Gérer les liaisons des racines distantes ». Choisissez une connexion, sélectionnez un répertoire et définissez ses autorisations, puis enregistrez-la via le menu « … » de sa ligne dans les répertoires distants. Une même connexion peut servir à plusieurs répertoires.

Les outils exigent un environnement d’exécution SSH compatible. Le Registry autorise chaque appel en fonction des répertoires enregistrés dans l’espace de travail actif. Désactiver SSH décharge les outils et ferme le plan de contrôle distant. Les étapes détaillées figurent dans le [guide des environnements distants SSH](./docs/guide/user/ssh-remote-environments.en.md) (en anglais).

### Points d'entrée de l'interface

- **Barre latérale et page de nouvelle session** : l'action **Dossiers** en bas de la barre latérale ouvre la boîte de dialogue **Dossiers de l’espace de travail** ; à partir de DSH `0.2.1-alpha.3`, la même entrée figure aussi à l'extrémité droite de la ligne d'espace de travail de la page de nouvelle session (sans flèche de menu déroulant ; en fenêtre étroite, icône seule). La boîte de dialogue permet d'ajouter et de retirer des racines, de modifier les alias et les autorisations, d'activer ou de désactiver les Skills racine par racine, de copier des chemins, d'afficher dans le gestionnaire de fichiers, ainsi que d'utiliser **Réessayer** pour actualiser la liste et l'entrée **Suggestions Worktree**.
- **Menu de la ligne d'espace de travail** : le menu `…` et le menu contextuel de la ligne d'espace de travail proposent tous deux **Manage workspace folders…** ; lorsque la session courante appartient à cet espace de travail, la boîte de dialogue s'ouvre directement, sinon elle ouvre d'abord (ou réutilise) la page vierge de cet espace de travail et ne s'ouvre qu'une fois celui-ci confirmé comme session courante.
- **Onglet Files** : le sélecteur de racine de l'en-tête bascule entre la racine principale et une racine supplémentaire ; une fois une racine supplémentaire sélectionnée, l'arborescence, l'ouverture de fichiers, l'ouverture dans l'application, les menus contextuels, l'actualisation automatique et la recherche dans l'espace de travail suivent cette racine, et le retour à la racine principale restaure la vue native.

### Côté modèle

La topologie des racines supplémentaires est injectée dans le prompt système et mise à jour lorsque les autorisations changent ; aucun nouvel outil n'est nécessaire. Les `AGENTS.md` / `CLAUDE.md` propres aux racines supplémentaires entrent eux aussi dans le contexte au fur et à mesure : celui de niveau supérieur de la racine avant la première étape de la session, celui d'un sous-répertoire après que cette session y a travaillé avec succès.

Pour des instructions plus complètes, fonction par fonction, voir le [guide utilisateur](./docs/guide/user/README.en.md).

## Structure du projet

```text
.
├── src/
│   ├── roots.ts                      règles pures : canonicalisation, validation des conflits, classification des enregistrements (available/missing/redirected/invalid)
│   ├── registry.ts                   registre des racines : persistance via dsh-storage-domain, cœur de stockage unique et façades Host, ordonnancement des admissions et des mutations à l'échelle du store
│   ├── registry-lease.ts             Registry Authority inter-processus : flock POSIX (le noyau le libère à la mort du processus)
│   ├── registry-lease-win32.ts       idem, implémentation par named semaphore Windows
│   ├── scope.ts                      ctx.multiRootScope : source d'autorisation unique, qui publie aussi l'instantané de topologie visible par le modèle
│   ├── fs.ts                         provider de système de fichiers multi-racines (fence en processus, sous-classe du LocalFileSystem amont)
│   ├── sandbox.ts                    provider de bac à sable noyau multi-racines (sous-classe du LocalSandboxProvider amont)
│   ├── dialects.ts                   reconnaissance des profils Seatbelt / bwrap / Landlock et assemblage des autorisations supplémentaires (échec explicite si un profil est inconnu)
│   ├── windows-*.ts                  runner ACL root-set Windows et exécution à jeton restreint
│   ├── containment.ts                détermination de contenance d'un chemin (chemin rapide lexical + repli sur les alias dev/ino)
│   ├── instructions.ts               découverte, livraison incrémentale, budget et rétractation des AGENTS.md / CLAUDE.md d'une racine supplémentaire (niveau supérieur + sous-répertoires touchés par la session, injectés via agent/pre-step)
│   ├── lsp.ts                        espace de travail LSP distinct, initialisé par racine supplémentaire
│   ├── workspace-files.ts            routage côté hôte et confinement de la navigation de fichiers des racines supplémentaires dans l'onglet Files
│   ├── compat.ts                     porte de démarrage multi-root-compat (liste blanche de versions et détection de mélange d'installations)
│   ├── compat/                       couche d'adaptation aux différences de version : dsh-version / sandbox-confine / agent-instructions / llm-message, etc. (peers optionnels chargés à la demande)
│   ├── command.ts                    commande /workspace-folders et moitié hôte du RPC du panneau
│   ├── worktrees.ts                  ligne de suggestions de racines Worktree : découverte/activation/watchers, file d'attente des prompts et attentes, confirmation et nettoyage explicite
│   ├── worktrees/                    instantanés contrôlés de métadonnées Git (config/HEAD/index/chaîne des ancêtres), inventaire, sidecar et revérification du propriétaire (sans lancer Git)
│   ├── worktrees-contract.ts         contrat strict des points de terminaison Worktree, validé des deux côtés (union discriminée, champ retry interdit)
│   ├── contract.ts                   protocole filaire du panneau (validation zod des deux côtés, inlinable dans le bundle navigateur)
│   └── client/                       moitié navigateur : action de la barre latérale, boîte de dialogue Dossiers, sélecteur de racine de l'onglet Files, dictionnaires pour les huit langues de DSH
├── tests/                            parité différentielle, matrice d'exécution réelle des dialectes, allers-retours de contrat, portes composants et locale, e2e du lease inter-processus, injection d'instructions
├── scripts/                          batteries de smoke (compose / behavior / journey), contrôles de documentation et de runner noyau, contrôle du contrat de compatibilité, procédure de montée de version
└── docs/                             exigences, architecture, décisions d'architecture (ADR), plans, flux de développement
```

## Contribution

Les Issues et les PR sont bienvenues :

1. Lisez d'abord [`AGENTS.md`](./AGENTS.md) (règles du dépôt) et le [flux de développement](./docs/development/plugin-development-workflow.md) (environnement, commandes, matrice de prise en charge des runtimes, procédure de montée de version).
2. Créez votre branche depuis `main` ; les messages de commit suivent les conventional commits (`feat` / `fix` / `perf` / `refactor` + scope) — voyez l'historique existant.
3. Tout ce qui suit doit passer en local avant une PR : `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (la CI suit le même ordre, build avant test).
4. Un changement de comportement met à jour le document correspondant sous `docs/` dans la même contribution ; les huit éditions du README à la racine restent synchronisées, l'édition chinoise faisant foi ; une décision d'ingénierie impliquant un compromis donne lieu à un nouvel ADR.
5. Contrainte stricte : **ne modifier aucun paquet du dépôt amont (deepseek-harness)** ; le plugin reste une extension out-of-tree.

Consultez le [guide de contribution](./CONTRIBUTING.md) pour les règles complètes.

## Limites connues

### Fonctionnalités du plugin

- Les fichiers d'instructions d'une racine supplémentaire arrivent au modèle au fur et à mesure : celui du niveau supérieur de la racine est injecté avant la première étape de la session, et celui d'un sous-répertoire l'est une fois que cette session y a travaillé **avec succès**. Un fichier imbriqué n'est réexaminé que lorsque son répertoire est examiné (la racine à chaque étape ; un sous-répertoire parce qu'il a déjà été livré ou qu'il a été touché à nouveau) ; l'état de livraison vit en mémoire du processus (une session reprise peut donc être informée une seconde fois) ; officiellement, ce sont les noms d'outils `read` / `write` / `edit` qui comptent, et lorsque le mode de compatibilité OPS est activé, les outils OPS alimentent eux aussi la livraison via des preuves live (après une reprise, l'historique OPS dépourvu de preuve live ne participe pas à la livraison). La chaîne d'instructions de la racine principale et celle du fichier user-global restent du ressort de l'amont ; ce plugin ne les injecte pas une seconde fois ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Plusieurs Hosts partagent un même service de Registry : un seul Host gère le stockage et chaque instance obtient une autorisation opération par opération ; une déconnexion arrête les nouvelles autorisations de racines supplémentaires, et après la sortie de l'autorité, la reprise se fait par le verrou noyau. Le partage est limité à une même machine, un même utilisateur et un même espace de noms de verrou ; sous Linux, la connexion partagée exige SO_PEERPIDFD, et sous Windows elle se limite à une même session de connexion. Les processus et PTY existants conservent leur instantané de démarrage ([architecture partagée](./docs/architecture/registry-authority-service.md)).
- La matrice de prise en charge est une liste blanche de versions exactes : lorsque la version de l'hôte n'est pas dans la liste, ou que les paquets cœur ne sont pas tous sur la même version, les six lignes `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` **ne démarrent pas** et la composition se réduit à « plugin non installé » ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- Le runner multi-racines Windows hérite des conditions amont d'application partielle, de répertoires appartenant à l'appelant et de séparation du temp privé ; les processus déjà lancés conservent l'ensemble de racines de leur démarrage, les processus suivants utilisent l'ensemble mis à jour ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Les chemins réseau et de périphérique ne peuvent pas devenir des racines supplémentaires sous Windows** : les chemins UNC (`\\server\share`), `\\?\`, `\\.\` et les lecteurs réseau mappés sont refusés dès l'enregistrement avec `unsupported-path` — le SID de capacité du jeton restreint ne peut pas être lié à un accès SMB ([amendement ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Le shell restreint sous Windows est pwsh, sans Git Bash** : MSYS ne peut pas démarrer sous un jeton restreint de faible intégrité (comportement identique avec le runner amont et avec celui du plugin — il s'agit d'une limitation amont) ; un processus enfant confiné du runner amont ne reçoit pas Ctrl+C, car il hérite de l'indicateur ignore-Ctrl+C, alors qu'avec le runner du plugin l'enfant le reçoit et le runner reproduit son code de sortie.
- Le niveau d'accès d'une racine supplémentaire est ternaire : les nouveaux enregistrements sont en `inherit` (ils suivent le mode de la session), `--read-only` refuse l'écriture dans tous les modes (y compris en accès complet ; la seule exception est une élévation ponctuelle approuvée par l'utilisateur pour un appel donné, voir [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)), et un `--read-write` fixé reste inscriptible même dans une session en lecture seule — c'est une question d'autorisation d'écriture, jamais de confinement de lecture ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). Un processus déjà lancé ou un terminal persistant conserve l'ensemble de refus avec lequel il a démarré — un terminal lancé avant qu'une racine ne passe en lecture seule reste sans restriction jusqu'au redémarrage ; les changements de plafond et d'accès ne contraignent que les appels ultérieurs et les nouveaux processus ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)) ; un hôte qui fournit un workingDirectory peut utiliser une racine supplémentaire comme répertoire d'exécution des outils suivants, l'origine de la session et l'identité de l'enregistrement restant inchangées ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **Sur un hôte Linux où l'amont a choisi Landlock, un accès complet restreint exige bwrap** : la liste d'autorisations de Landlock ne peut pas exprimer « tout est inscriptible sauf ces racines », cette combinaison choisit donc bubblewrap pour construire la frontière de refus d'écriture ; sur un hôte dépourvu de bwrap utilisable (non installé, ou espaces de noms utilisateur non privilégiés désactivés), une commande en accès complet portant une quelconque frontière de refus d'écriture (une racine en lecture seule ou le `$DSH_HOME` protégé) échoue fermée avant le lancement. Activez bwrap, ou évitez les racines explicitement en lecture seule en accès complet sur un tel hôte ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- L'arborescence des racines supplémentaires est portée par le **sélecteur de racine de l'onglet Files** : l'entrée d'en-tête liste la racine principale et toutes les racines supplémentaires, tout en affichant à côté le chemin complet de la racine sélectionnée ; lorsqu'une racine supplémentaire est sélectionnée, un clone octet pour octet de l'arbre Files de l'amont prend en charge la zone d'arborescence (répertoires chargés à la demande, lignes et icônes natives, actualisation automatique par watch, clic sur un fichier ouvrant le viewer de l'hôte, actualisation manuelle à l'emplacement d'origine de l'en-tête), tandis que le bouton « Ouvrir dans l'application » à droite de l'en-tête est lui aussi remplacé par un clone octet pour octet du contrôle amont, qui ouvre la racine sélectionnée et non la racine principale ; le retour à la racine principale restaure la vue native ; la boîte de dialogue redevient purement gestionnaire. Les lignes des racines supplémentaires offrent en outre les mêmes menus contextuels de ligne que la racine principale (lignes de fichier et de répertoire ; l'arborescence de navigation Folder de l'aperçu de fichier en bénéficie aussi) et une recherche dans l'espace de travail propre à la racine sélectionnée (bouton de recherche dans l'en-tête, barre de recherche, arborescence de résultats avec surlignage des correspondances, panneau contextuel de préférences et filtrage des entrées masquées) ; les deux n'apparaissent que là où l'hôte expose la structure correspondante — les menus contextuels de ligne exigent `useContextMenu` (depuis `0.2.2-alpha.3`) et la recherche exige `workspaceFiles.search` (depuis `0.2.2-rc.2`) ; sur les hôtes plus anciens, aucun menu de ligne n'est lié et aucune entrée de recherche n'est rendue, la vue restant inchangée. Cette reprise repose sur les crochets DOM `data-*` de l'amont et se dégrade silencieusement vers l'apparence native lorsqu'ils cessent de correspondre ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). Le LSP initialise un espace de travail distinct pour la racine supplémentaire qui contient le fichier ; l'hôte doit configurer le serveur de langage correspondant ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)). Limites connues : le raccourci natif des Files **Cmd+P** cible encore le champ de recherche natif que la reprise garde masqué ; il ne sert donc pas d'entrée de recherche pour les racines supplémentaires — ni la page Files ni la surface de recherche du navigateur d'aperçu n'y répondent ([ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md), [ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)) ; l'historique de recherche du navigateur d'aperçu est enregistré par `(pane, root)`, séparément du `(tab, root)` de la page Files, si bien qu'une requête de la page Files n'est pas reprise dans l'aperçu du même pane ; la ligne courante des résultats est seulement marquée, sans défilement automatique ; fermer un Folder ou changer de racine dans le même pane jette le brouillon de réglages non enregistré ([ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)).
- Lorsqu'un plugin tiers prend en charge tout l'onglet Files (enregistrement du kind `files` avec `priority: "extension"`), le sélecteur de racine et la navigation des racines supplémentaires sont indisponibles ; le plugin affiche une fois une notification transitoire officielle de niveau info et peut la réafficher lorsque la reprise prend fin, la gestion des racines restant possible depuis l'entrée **Dossiers de l’espace de travail** de la barre latérale et via `/workspace-folders` ([Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)).
- Les textes de sortie de la commande sont en anglais (côté hôte, aucune information de langue active n'est disponible) ; les textes du panneau suivent la langue de l'interface et existent dans les huit langues proposées par DSH.
- Le panneau Dossiers de l’espace de travail se compose d'une action en bas de la barre latérale et d'une boîte de dialogue, et non d'un panneau plein écran autonome : `sidebar.footer.action` est un emplacement offert par toutes les versions prises en charge, alors que `sidebar.panellist` / `main` ne le sont pas. À partir de DSH `0.2.1-alpha.3`, une entrée incrémentale s'ajoute dans l'emplacement `conversation.hero.options` de la page de nouvelle session : elle reprend la géométrie des sélecteurs d'espace de travail et de mode voisins, n'a pas de chevron, se réduit selon la place mesurée dans la ligne d'espace de travail et, lorsque la place restante est inférieure à 88 px, dégénère en un bouton d'icône de 28×28 (le conteneur amont des options est en `flex: none` ; le plugin ne modifie pas DSH, il mesure la place restante et se contraint lui-même ; si la sonde ne reconnaît pas la structure de la ligne, il retombe sur un repli à 560 px de largeur de fenêtre) ; lorsque l'emplacement est absent d'un runtime plus ancien, l'enregistrement ne se déclenche pas et l'entrée de la barre latérale n'est pas affectée ([ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)). L'arrondi du rail (état replié) de l'entrée de la barre latérale a sa propre limite, plus ancienne, `0.1.6-alpha.2` : 23 versions prises en charge dessinent le même carré arrondi de 12 px que l'hôte, tandis que les 2 plus anciennes (`0.1.5-rc.2`, `0.1.6-alpha.1`) voient l'hôte dessiner un cercle face au carré arrondi de 12 px du plugin — un écart d'arrondi documenté, sans effet sur l'encre ni la mise en page ; l'enveloppe `@media (hover: hover)` n'existe que sur les 6 versions à nouvelle géométrie et le plugin reste volontairement sans enveloppe, d'où une différence de retour au survol sur écran tactile avec ces versions ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)). La hauteur de l'entrée de la barre latérale suit l'occupant de la même rangée de réglages, via une dépendance structurelle CSS `:has()` au marqueur `data-signed-out` du launcher de compte (ce n'est pas un contrat d'emplacement) : les 7 versions les plus anciennes (jusqu'à `0.1.7-rc.2`) conservent la hauteur de 42 px du déclencheur de réglages ; à partir de `0.2.0-rc.1`, le bouton fait 32 px déconnecté et 44 px connecté, le rail restant à 36 px ; si le marqueur est renommé ou disparaît, le repli est de 42 px (sans risque de dimension erronée) et seule la hauteur est concernée ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)).

### Adaptation OPS

L'implémentation est disponible sous la forme d'un **mode de compatibilité OPS (expérimental, désactivé par défaut, limitations possibles)**. Dans `Settings → Plugins → Multi-root Workspace`, réglez `multi-root-ops-compatibility.enabled` ; la valeur par défaut est `false` et l'activation doit être explicite. Cette fonction ne peut être activée que sur les versions DSH `0.2.*` de la matrice de prise en charge exacte existante ; sous `0.1.*`, même avec `enabled: true` configuré à la main, elle reste désactivée, et l'ancienne interface Settings n'est pas prise en charge ([décision sur la portée des versions](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06)). Lors d'une activation depuis l'interface Settings, il faut lire la boîte de dialogue de risque officielle, cocher la case attestant que les limitations sont comprises, puis confirmer ; avant confirmation, le réglage reste désactivé, et une annulation, une fermeture de la boîte de dialogue ou la touche Échap n'enregistrent pas l'activation.

- **Activé** : active la protection d'exécution OPS, l'activité en temps réel et les enrichissements de Review. En accès complet (`danger-full-access`), les refus explicites RO/cap sont protégés par le confinement noyau sur les canaux macOS/Linux vérifiés ; sous Windows, en présence d'un refus, l'exécution OPS est refusée par prudence avant la préparation du Worker (lectures comprises), la préparation protégée et les écritures légitimes n'étant pas encore prises en charge dans cette combinaison. En WW/RO, dès qu'une racine supplémentaire non inscriptible ou qu'un plafond de lecture seule sur un outil existe, l'appel d'exécution OPS entier (lectures/page comprises) est refusé avant la préparation et l'exécution. Tous les modes refusent les appels d'exécution OPS lorsque l'autorité du Registry est indisponible, à l'exception de la découverte et de la publication pures. Un lancement de sous-processus sans domaine d'exécution ni profil valide issu de l'admission en cours est également refusé, afin d'empêcher qu'un nettoyage d'arrière-plan contourne les frontières ; cela peut aussi refuser des processus d'arrière-plan tiers, sans bloquer le terminal de l'utilisateur dans le panneau.
- **Désactivé** : OPS retrouve le comportement d'avant cette adaptation, sans ces garde-fous — **OPS peut écrire dans une racine supplémentaire explicitement en lecture seule**. Les fonctions multi-racines ordinaires, les barrières natives des outils et l'interrupteur propre à Auto Review ne sont pas affectés. Les instructions déjà livrées ne sont pas effacées rétroactivement, et les appels déjà entrés dans un domaine d'exécution protégé comme les processus déjà lancés conservent leur instantané d'origine ; les nouveaux appels démarrés après la désactivation ne réactivent plus cette adaptation.
- **Limites expérimentales** : seul l'index d'activité live de la phase A est fourni, sans pont d'événements durable. Lorsque l'option est activée, l'historique OPS dépourvu de preuve live après une reprise et les actions en attente dynamiques (replace/batch/result/bash/unknown) font échouer Review techniquement ; les diagnostics hors liste blanche comme `ops_status` relèvent eux aussi de cette règle conservatrice.

Lacunes connues en détail :

- **Contournement par dsh-ops de la restriction en lecture seule (F01, référence historique)** : dans les versions auditées en accès complet, l'outil OPS Native `ops_write_file` écrivait réellement dans une racine supplémentaire explicitement en lecture seule, alors que le contrôle fs natif était refusé au même moment. Avec le mode de compatibilité OPS activé, l'adaptation limitée de cette itération a été revérifiée en accès complet : le refus explicite RO/cap s'applique à OPS Native et au PTC réel (revérification de l'exécution du refus dans [audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)) ; les versions, le périmètre de test et les preuves d'origine figurent dans l'[audit de compatibilité](./docs/reviews/dsh-ops-compatibility-audit.md).
- **Écritures légitimes et instructions de sous-répertoire avec dsh-ops (F04/F05, référence historique)** : le précontrôle OPS refuse encore les racines supplémentaires en inherit ou en lecture-écriture fixe sous WW, ainsi que les racines en lecture-écriture fixe sous RO (F04 non résolu) ; l'absence de découverte des instructions de sous-répertoire lors d'une lecture OPS (F05) est revérifiée comme rétablie dans cette itération, avec l'index live du mode activé et un vrai AgentLoop (les instructions des sous-répertoires touchés avec succès par Native et par le PTC entrent dans la requête modèle suivante, voir [audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)) ; les chemins déjà vérifiés des instructions de niveau racine et des Skills ne sont pas affectés.
- **Dégradation des batch/result WW sous Linux avec bwrap (F07)** : avec le Registry partagé des versions auditées, tout `ops_batch` / `ops_result` (y compris `page`) qui atteint la branche de lancement avec un cache valide perd sa preuve d'appartenance d'argv, car OPS ajoute un bind après le confinement ; le chemin source refuse alors le lancement du Worker et signale `EXECUTOR_UNAVAILABLE`. Le conflit au niveau fonction est reproduit ; l'exécution de bout en bout sous Linux n'a pas été testée. Les cas ordinaires en RO, sous Landlock et sans cache sortent de cette conclusion. Une interface OPS déclarant le cache avant le confinement est nécessaire ; aucun contournement unilatéral côté MR n'a été validé, voir [audit F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突).
- **Autres limites de disponibilité OPS** : en WW partagé, une purge hors ordonnancement est refusée faute d'admission valide, si bien que des caches de résultats peuvent subsister avec un avertissement ; les appels PTC imbriqués et le Bash d'arrière-plan présentent eux aussi un risque de refus pour preuve mal attribuée ou expirée. La validation des frontières de refus conservatrices sur les trois plateformes est faite pour cette itération ; les capacités normales d'arrière-plan et de nettoyage ne sont pas rétablies et sont reportées sans échéance, voir [portée finale de l'ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05).

Les garde-fous P5 propres à ce dépôt ne modifient pas OPS : des écritures légitimes dans une racine supplémentaire peuvent encore être refusées à tort, et des caches de résultats d'arrière-plan peuvent subsister lorsque le nettoyage est refusé ; en mode legacy sans Registry partagé, le PTC en WW/RO peut lui aussi être refusé avant le démarrage de son processus de code. L'activité durable reste désactivée : DSH interdit explicitement aux plugins externes d'appeler `appendPluginRecord`, et des événements ordinaires ou une écriture directe dans les journaux ne remplacent pas cet appel. P6 a fait l'objet d'une acceptation technique dans le périmètre défini ; les capacités P5 restantes et l'acceptation de la compatibilité OPS complète sont **reportées sans échéance**, ne conditionnent pas cette livraison, et toute reprise future restera expérimentale. La liste des reports figure dans [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源), le périmètre d'acceptation dans le [plan terminé](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md).

Ces garde-fous expérimentaux conservateurs sont livrés avec `v0.1.15` ; ils ne revendiquent pas une compatibilité OPS complète et n'élargissent pas la matrice de prise en charge. La revérification historique de l'audit §16 est antérieure à l'ajout de cet interrupteur et correspond au chemin activé ; toute réexécution ultérieure doit passer `enabled: true` explicitement.

## Documentation

La documentation de long terme du projet se trouve dans [`docs/`](./docs/README.md) :

- [Journal des modifications (CHANGELOG)](./CHANGELOG.en.md)
- [Guide utilisateur](./docs/guide/README.en.md)
- [Exigences](./docs/requirements/multi-root-workspace.md)
- [Architecture cible](./docs/architecture/multi-root-workspace.md)
- [Recherche sur l'amont](./docs/reference/multi-root-workspace-research.md)
- [Décisions d'architecture (ADR)](./docs/decisions/README.md)
- [Plans](./docs/plans/README.md)
- [Flux de développement](./docs/development/plugin-development-workflow.md)
- [Dépannage](./docs/troubleshooting/README.md)

Les règles de dépôt applicables aux Coding Agents sont définies dans [`AGENTS.md`](./AGENTS.md).

## Licence

[MIT](./LICENSE)

Licences tierces : [THIRD_PARTY_LICENSE](./THIRD_PARTY_LICENSE)
