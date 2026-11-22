<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

<img alt="GitHub License" src="https://img.shields.io/github/license/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="NPM Version" src="https://img.shields.io/npm/v/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">
<img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">

[中文](./README.md) | [English](./README.en.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md) | Deutsch | [Русский](./README.ru.md) | [Português](./README.pt.md)

</div>

## Was und warum

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) behandelt standardmäßig das Verzeichnis, in dem ein neuer Arbeitsbereich angelegt wird, als Hauptverzeichnis des Agenten; im standardmäßigen Lese-Schreib-Modus des Arbeitsbereichs (`workspace-write`) umfasst der Lese- und Schreibbereich der Sandbox nur dieses eine Verzeichnis. Dieses Plugin erweitert den Arbeitsbereich von DSH auf „eine primäre Wurzel + mehrere zusätzliche Wurzeln“.

Nicht jedes Projekt ist ein Monorepo. Ein Entwicklungsprojekt besteht häufig aus mehreren unabhängigen Git-Repositories, und für Arbeiten über sie hinweg musste man bisher laufend zwischen Sitzungen wechseln. Vergleichbare Werkzeuge unterstützen längst das Hinzufügen mehrerer Ordner zu einem Arbeitsbereich; dieses Plugin bringt dieselbe Fähigkeit zu DSH: Registrieren Sie die anderen Repositories als zusätzliche Wurzeln und legen Sie je nach Bedarf schreibgeschützt, Lesen und Schreiben oder die aktuellen Berechtigungen der Sitzung fest – danach kann der Agent innerhalb dieser Freigabe lesen und schreiben.

- **Native Werkzeuge**: In lokalen Arbeitsbereichen verwendet der Agent weiterhin die nativen `read` / `write` / `edit` / `bash`; er erhält lediglich einige zusätzliche Verzeichnisse, in denen er arbeiten kann.
- **Berechtigungen greifen tatsächlich**: Jede zusätzliche Wurzel lässt sich als schreibgeschützt, als Lesen und Schreiben oder als „folgt den Berechtigungen der aktuellen Sitzung“ festlegen; die Beschränkung wird von der System-Sandbox tatsächlich durchgesetzt und nicht dem Modell per Prompt nahegelegt. Dateioperationen und bash-Befehle des Agenten unterliegen derselben Freigabe; Prozesse, die andere Plugins selbst starten, fallen nicht unter diese Zusage.
- **Zusätzliche Wurzeln im Files-Tab durchsuchen**: Oben im Files-Tab lässt sich zwischen der primären Wurzel und jeder zusätzlichen Wurzel wechseln; Verzeichnisbaum, Öffnen von Dateien, Öffnen in einer externen Anwendung, Kontextmenüs, automatische Aktualisierung und Suche verhalten sich wie bei der primären Wurzel, und die Verzeichnisnavigation der Dateivorschau springt ebenfalls zu der Wurzel, in der die Datei liegt. Bei älteren Host-Versionen sind einige dieser Oberflächenaktionen möglicherweise nicht verfügbar; die zusätzliche Wurzel wird dann weiterhin so angezeigt, wie der Host es vorsieht.
- **Skills in zusätzlichen Wurzeln**: `.dsh/skills` und `.agents/skills` in zusätzlichen Wurzeln werden automatisch erkannt und lassen sich als `/Alias:Skill-Name` aufrufen; jede Wurzel lässt sich einzeln ein- und ausschalten, standardmäßig ist sie eingeschaltet.
- **Auto Review (experimentell, standardmäßig deaktiviert)**: Nach dem manuellen Einschalten im Plugin-Manager sieht die automatische Überprüfung auch die Verzeichnisstruktur, die Zugriffsebene und die Instruktionsdateien der zusätzlichen Wurzeln und bezieht diese Wurzeln in die Überprüfung ein.
- **Worktree-Vorschläge (experimentell, standardmäßig deaktiviert)**: Ist die primäre Wurzel eine Git-Worktree-Wurzel, schlägt das Plugin vor, weitere Worktrees desselben Repositories als zusätzliche Wurzeln hinzuzufügen; registriert wird erst nach Ihrer Bestätigung, und es wird nichts automatisch hinzugefügt oder entfernt.
- **SSH-Remote-Umgebungen (experimentell, standardmäßig deaktiviert)** – Aktiviere persönliches SSH auf der Plugin-Detailseite, um `remote_copy` und `remote_bash` für registrierte Remote-Verzeichnisse zu verwenden. Verbindungen und Arbeitsbereichsbindungen werden getrennt verwaltet. Die Registry prüft jeden Aufruf.
- **Ohne Registrierung wie nicht installiert**: Ohne zusätzliche Wurzel verhält sich das Plugin genau wie ein nicht installiertes Plugin; eine fehlerhafte Konfiguration meldet einen Fehler, statt stillschweigend herabzustufen.

Die neueste Veröffentlichung ist die Beta-Vorabversion `v0.1.24-beta.1`; das npm-Tag `latest` zeigt weiterhin auf die stabile Version `v0.1.23`, daher wird die Beta mit explizitem `@beta` installiert. Die benutzersichtbaren Änderungen der einzelnen Versionen stehen im [CHANGELOG](./CHANGELOG.en.md); Fortschritt und Release-Status in der [Fortschrittsübersicht der Roadmap](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Schnellstart

Das Plugin ist auf [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace) veröffentlicht. Für CLI-Profile (`web`, `headless` usw.) genügen zwei Befehle:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # --profile entsprechend Ihrer Startart wählen; die möglichen Werte stehen in der DSH-Dokumentation
```

**DSH-Desktop-Nutzer**: Geben Sie auf der Plugin-Verwaltungsseite `@dsh-electron/dsh-plugin-multi-root-workspace` ein, um das Plugin zu installieren; meldet der Start einen Fehler, starten Sie DeepSeek Harness Desktop neu.

Weitere Installationswege – Tarball, GitHub, lokaler Quellcode – finden Sie unter [Installation](#installation).

Nach der Installation fügen Sie in einer Sitzung eine zusätzliche Wurzel hinzu:

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

## Voraussetzungen

**Plugin verwenden**: eine DSH-Version aus der folgenden Tabelle (exakte Übereinstimmung, kein Bereich). `dsh plugin` übernimmt die Installation; eine lokale Node-Toolchain ist nicht erforderlich.

| DSH-Linie | Unterstützte Versionen |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5` |

Steht die DSH-Version nicht in der Tabelle oder stimmen die Versionen der `@deepseek-ai/dsh-*`-Pakete nicht überein, startet das Plugin nicht und verhält sich wie nicht installiert.

**Aus dem Quellcode bauen / mitwirken**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (Aktivierung über corepack empfohlen); die für die Entwicklung gepinnte DSH-Version ist `0.2.2-rc.5` (Node ≥24.9).

**Plattformen**: macOS (Seatbelt), Linux (bwrap / Landlock), Windows (root-set-ACL-Runner).

## Installation

Die Installation erfolgt auf zwei Wegen: über die Kommandozeile (CLI) oder über die Plugin-Verwaltung in der Web- bzw. Desktop-Oberfläche. Einer davon genügt.

### Installation über die CLI

`dsh plugin` unterstützt vier Installationsquellen; die Beispiele verwenden das Profil `web`, für `headless` und andere CLI-Profile gilt dasselbe. **DSH-Desktop-Nutzer**: Das Profil `desktop` muss über die in DeepSeek Harness Desktop enthaltene `dsh`-CLI verwaltet werden; die Schritte stehen am Ende dieses Abschnitts.

| Quelle | Befehl | Hinweis |
| --- | --- | --- |
| npm-Registry (empfohlen) | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | Vorgefertigte Artefakte, sofort einsatzbereit |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | Wird bei der Installation automatisch aus dem Quellcode gebaut; `allowBuilds` muss den exakten Schlüssel dieses Pakets enthalten – Version pinnen empfohlen |
| Tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | Vorgefertigtes Offline-Paket, geeignet für interne Netze und Offline-Betrieb |
| Aus dem Quellcode | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | `link:` von pnpm auf einen lokalen Checkout, geeignet für Entwicklung und Debugging; kein `allowBuilds` nötig |

#### Installation von npm (empfohlen)

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

Derzeit ist `latest` die stabile Version `v0.1.23`; um die Beta-Vorabversion (hier `v0.1.24-beta.1`) zu installieren, gib `@beta` ausdrücklich an:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace@beta
```

#### Installation aus einem Tarball

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# oder aus den Assets des GitHub-Releases herunterladen, zum Beispiel:
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.24-beta.1/dsh-electron-dsh-plugin-multi-root-workspace-0.1.24-beta.1.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.24-beta.1.tgz
```

Ebenfalls vorgefertigte Artefakte, geeignet für die Auslieferung in internen Netzen oder Offline-Umgebungen.

#### Installation von GitHub

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

Eine GitHub-Quelle liefert Quellcode; `add` baut ihn automatisch, ein manuelles Kompilieren ist nicht nötig. pnpm blockiert das `prepare`-Skript dieses Pakets und gibt eine Zeile mit dem exakten Schlüssel aus (einschließlich Quelle und Commit). Übernehmen Sie diese Zeile unverändert in `allowBuilds` und führen Sie `add` erneut aus:

```yaml
allowBuilds:
  # Schlüssel und Wert stammen aus dem Beispiel „Add the package to allowBuilds“ der pnpm-Fehlermeldung;
  # ein Schlüssel mit bloßem Paketnamen ohne Quelle und Commit wirkt bei git-Quellen nicht.
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

Empfohlen ist das Pinnen einer Version (z. B. `#v0.1.24-beta.1`), damit spätere Pushes nicht stillschweigend ändern, was tatsächlich läuft:

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.24-beta.1
```

#### Installation aus einem lokalen Checkout

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> Wenn `dsh` nicht im PATH liegt (etwa weil Sie DSH aus einem Quellcode-Checkout starten), ersetzen Sie `dsh` im Befehl durch `pnpm dsh`.

<details>
<summary>Ausführung</summary>

Prüfläufe für die Entwicklung:

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

In eine DSH-Laufzeit installieren und die Komposition prüfen:

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

Erwartete Ausgabe:

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

Die beiden Upstream-Zeilen `fs-sandbox` und `sandbox` sind deaktiviert und werden von den gleichnamigen Diensten des Plugins übernommen; alle `multi-root-*`-Zeilen des Plugins sind eingehängt. Nach dem Start erscheint unten in der Seitenleiste die Aktion **Ordner** (Workspace-Tree-Symbol); DSH `0.2.1-alpha.3` und neuere Laufzeiten zeigen denselben Einstieg zusätzlich am rechten Rand der Arbeitsbereichszeile auf der Seite für neue Sitzungen.

</details>

#### Installation über die in DeepSeek Harness Desktop enthaltene CLI

DeepSeek Harness Desktop kann im Anwendungsmenü unter „dsh-Befehl verwalten…“ einen globalen `dsh`-Befehl installieren; das Profil `desktop` von DeepSeek Harness Desktop verwalten Sie mit diesem Befehl.

1. Beenden Sie Desktop vollständig, einschließlich des Tray-Symbols.
2. Neuinstallation:
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24-beta.1
   ```
3. Bereits installiert, aber der Bundle-Eintrag fehlt: erst `remove`, dann `add` (ein erneutes `add` allein trägt den Eintrag nicht nach):
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24-beta.1
   ```
4. Öffnen Sie `$DSH_HOME/profiles/desktop/package.json` (ohne gesetztes `DSH_HOME` normalerweise `~/.dsh/profiles/desktop/package.json`) und prüfen Sie, ob `dsh.profile.bundles` dieses Paket enthält.
5. Starten Sie Desktop erneut (Kaltstart).

Endet `add` mit Exit-Code 0, ohne dass das Plugin in `dsh.profile.bundles` erscheint, führen Sie einmal `remove` + `add` aus. Ursache des Konflikts beim Aktivieren im laufenden Betrieb, Reproduktion und die Untersuchung der tatsächlich schreibenden Stelle stehen in der [Fehlerbehebung](./docs/troubleshooting/desktop-install-missing-bundle.md).

### Installation über die Plugin-Verwaltung in der Web-/Desktop-GUI

Web und Desktop installieren beide über die Seite „Plugins“ in der Seitenleiste: „Plugin hinzufügen“ wählen, `@dsh-electron/dsh-plugin-multi-root-workspace` in das Eingabefeld eintragen und installieren. Wählen Sie danach „Jetzt aktivieren“ – die Installation allein aktiviert das Plugin nicht. Fehlt auf der Plugin-Seite der Einstieg „Plugin hinzufügen“, verwenden Sie die CLI oben.

Nach der Installation oder Aktivierung muss die DeepSeek Harness-App neu gestartet werden: Desktop vollständig beenden (einschließlich Tray-Symbol) und erneut öffnen, bei Web den Prozess `dsh web` neu starten. Das Aktivieren dieses Plugins in einer laufenden App kann eine doppelte Registrierung von `fs` / `sandbox` melden; nach einem Neustart lädt es sauber.

## Verwendung

### Befehl

```text
/workspace-folders [list]                                                   # listet die primäre Wurzel und die zusätzlichen Wurzeln auf (mit Berechtigung und Status je Wurzel)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # ohne Pfad öffnet sich die Verzeichnisauswahl; neue Einträge sind standardmäßig inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # Kurzbefehl für /workspace-folders add
/workspace-folders access <order|path> inherit|read-only|read-write         # wechselt die Zugriffsebene (eine Erweiterung setzt voraus, dass die Wurzel gerade verfügbar ist)
/workspace-folders skills <order|path> on|off                               # schaltet die Skills dieser Wurzel einzeln ein oder aus, ohne die Schreibberechtigung zu ändern
/workspace-folders alias-id <order|path> <kebab-case>                        # bearbeitet den stabilen Skill-Namensraum
/workspace-folders alias <order|path> [alias]                               # ohne Alias wird ein vorhandener Alias gelöscht
/workspace-folders remove <order|path>                                      # die Nummer entspricht der Ausgabe von list
/workspace-folders reveal <order|path>                                      # im Dateimanager anzeigen
/workspace-folders isolate-profiles [--apply]                               # prüft (mit --apply: schreibt) die Importart der Abhängigkeiten der Profile
/workspace-folders help                                                     # zeigt die Befehlshilfe an
```

- Pfade dürfen in Anführungszeichen stehen, `~` wird expandiert; Duplikate, innerhalb einer vorhandenen Wurzel verschachtelte Pfade, die primäre Wurzel selbst sowie geschützte Pfade wie `$DSH_HOME` und das Speicherverzeichnis der Registry werden abgelehnt.
- `remove` / `access` / `alias` / `reveal` akzeptieren `Nummer|Pfad`; `add` ohne Pfad öffnet die Verzeichnisauswahl (sofern der Host sie anbietet) und kann auch nur mit dem Berechtigungsargument aufgerufen werden.
- `list` zeigt Berechtigung und Status jeder Wurzel. Ist ein Verzeichnis vorübergehend nicht vorhanden (`missing`) oder durch eine Verknüpfung an eine andere Stelle ersetzt (`redirected`), bleibt die Wurzel registriert, wird aber vorerst nicht freigegeben; sobald das Verzeichnis wieder vorhanden ist, genügt ein `list` oder eine Aktualisierung von **Arbeitsbereichsordner**, um sie automatisch wiederherzustellen.
- `isolate-profiles` dient der Vorabprüfung für eingeschränkten Full-access unter Windows: Standardmäßig wird nur `packageImportMethod` der Profile unter `$DSH_HOME` geprüft, `--apply` schreibt die Einstellung `copy`; es löscht keine `node_modules` und ändert keine vorhandenen Abhängigkeiten.

### Zugriffsebenen

| Zugriffsebene | Sitzung mit `workspace-write` | Sitzung mit `read-only` | Sitzung mit `danger-full-access` |
| --- | --- | --- | --- |
| `inherit` (Standard für neue Einträge) | schreibbar | Schreiben verweigert | unbeschränkt |
| `read-only` | Schreiben verweigert | Schreiben verweigert | Schreiben verweigert (auch bei Full-access) |
| `read-write` | schreibbar | schreibbar | schreibbar |

- Neue Einträge sind standardmäßig `inherit`; eine Änderung der Berechtigung wirkt nur auf spätere Aufrufe und neue Prozesse. Bereits gestartete Prozesse und persistente Terminals behalten die Berechtigung, mit der sie gestartet wurden.
- Eine vom Benutzer für einen einzelnen Aufruf genehmigte einmalige `danger-full-access`-Eskalation hebt für diesen Aufruf die Ablehnungen durch schreibgeschützte Wurzeln und die Obergrenze pro Werkzeug auf; die Absicherung für `$DSH_HOME` und die Herabstufung bei fehlender Registry-Berechtigung bleiben davon unberührt.
- Jede primäre Wurzel nimmt höchstens 16 zusätzliche Wurzeln auf (`maxAdditionalRoots` lässt sich bis 64 erhöhen). Ein Host kann ein Werkzeug über `toolAccess` der Zeile `multi-root-scope` dauerhaft begrenzen, etwa `{ bash: 'read-only' }`, sodass bash in keine zusätzliche Wurzel schreiben kann (in die primäre Wurzel darf es weiterhin schreiben).

### Skills in zusätzlichen Wurzeln

- `.dsh/skills` und `.agents/skills` in zusätzlichen Verzeichnissen werden automatisch erkannt; Namen und Beschreibungen sind ab dem ersten Modellschritt verfügbar, der Inhalt wird bei Bedarf geladen.
- Die primäre Wurzel verwendet `/skill-name`, zusätzliche Wurzeln verwenden `/alias-id:skill-name` (das Slash-Menü ergänzt sie); das Modell ruft sie über das native `skill`-Werkzeug auf, im Werkzeugprotokoll kann daher die interne ID erscheinen.
- Neu registrierte `inherit`- / `read-write`-Wurzeln haben Skills standardmäßig eingeschaltet, `read-only`-Wurzeln standardmäßig ausgeschaltet; im Dialog lässt sich das je Wurzel umschalten und `aliasId` bearbeiten (eine Änderung des angezeigten Alias ändert `aliasId` nicht). Das Einschalten von Skills an einer schreibgeschützten Wurzel verleiht keine Schreibberechtigung.
- Öffnen Sie in der Seitenleiste auf der Seite „Plugins“ die Detailseite von Multi-root Workspace; der Schalter **Skills für zusätzliche Ordner aktivieren** in der Einstellungskarte steuert alle zusätzlichen Wurzeln und ist standardmäßig eingeschaltet. Nach dem Ausschalten enden neue Erkennung und Aufrufe, die Auswahl je Wurzel bleibt jedoch erhalten. Skills, Instruktionen, LSP, Dateibrowsing und Sandbox-Berechtigungen der primären Wurzel bleiben unberührt.

### Worktree-Vorschläge für zusätzliche Wurzeln (experimentell, standardmäßig deaktiviert)

Ist die primäre Wurzel eine Git-Worktree-Wurzel, führt das Plugin die übrigen Worktrees desselben Repositories als Kandidaten in einer gemeinsamen Vorschlagskarte auf – einschließlich der zuvor von einem Terminal, einer IDE oder einer Forge angelegten Worktrees; ist die Sitzung selbst ein verknüpfter Worktree und läuft im Modus `workspace-write`, erscheint auch der Haupt-Checkout des Repositories als Kandidat. Die Erkennung liest ausschließlich Git-Metadaten und startet keinen Git-Unterprozess; sie **fügt keine Wurzeln automatisch hinzu und entfernt keine**. Sitzungen mit `danger-full-access` erhalten keinen Hinweis. Öffnen Sie in der Seitenleiste auf der Seite „Plugins“ die Detailseite von Multi-root Workspace und schalten Sie in der Einstellungskarte **Zusätzliche Worktree-Ordner vorschlagen** ein (standardmäßig deaktiviert).

Der Hinweis ist eine dauerhafte Karte: Sie können **Anzeigen** oder **Später erinnern** wählen (bis ein neuer Worktree erscheint / nach 7 Tagen / nach 30 Tagen); die Schließen-Schaltfläche oben rechts schließt nur den aktuellen Hinweis, nach einem Neustart erscheint er erneut. Nach dem Schließen lässt sich der Hinweis über **Worktree-Vorschläge** neben **Erneut versuchen** im Dialog **Arbeitsbereichsordner** erneut öffnen. Der Bestätigungsdialog zeigt Zeile für Zeile Pfad, Branch und Berechtigung (standardmäßig `inherit`, änderbar auf schreibgeschützt oder Lesen und Schreiben), bei mehreren Kandidaten lassen sich mehrere auswählen; die Zeile des Haupt-Checkouts erläutert zusätzlich ihren Umfang: den Quellbaum des Haupt-Checkouts, gemeinsame config/hooks/refs/objects und die Admin-Daten aller Worktrees, was andere Checkouts desselben Repositories beeinflussen kann. Die Registrierung gilt arbeitsbereichsweit, **auch andere Lese-/Schreib-Sitzungen erhalten die gewählte Berechtigung**; bei der Bestätigung wird erneut geprüft, und Änderungen währenddessen machen den betreffenden Eintrag ungültig. Im Dialog können Sie außerdem wählen, den Hinweis dauerhaft nicht mehr anzuzeigen.

Wird ein Worktree gelöscht oder verschoben, zeigt der Dialog ein Badge, aber es wird **niemals automatisch aufgeräumt**; ein Aufräumeinstieg wird nur angeboten, wenn das Verzeichnis nachweislich fehlt und die Identität der Registrierung übereinstimmt (gesammelt oder zeilenweise), und zwar hinter einer über den Dialog gelegten Bestätigung. Vor dem Aufräumen kann ein neues Verzeichnis am selben Pfad die alte Freigabe erben; der Bestätigungsdialog weist auf dieses Risiko hin.

### Auto-Review-Anpassung (experimentell, standardmäßig deaktiviert)

Wird ein Kontext für die Überprüfung mehrerer Wurzeln benötigt, aktivieren Sie in der Seitenleiste auf der Seite „Plugins“ auf der Detailseite von Multi-root Workspace in der Komponentenliste die standardmäßig deaktivierte Zeile Auto Review; der Schalter **Multi-Root Auto Review (experimentell)** in derselben Einstellungskarte ist gleichwertig und ebenfalls standardmäßig deaktiviert. Eine normale Installation aktiviert Auto Review nicht automatisch und wählt es nicht aus; die Integration steht nur mit den exakten DSH-Releases zur Verfügung, die sie mitbringen.

### SSH-Remote-Umgebungen (experimentell, standardmäßig deaktiviert)

Issue #32 stellt derzeit nur persönliches SSH bereit. Aktiviere **SSH-Remote-Umgebungen** in den Plugin-Einstellungen und bestätige den Risikohinweis. Der lokale DSH-Host hält die SSH-Zugangsdaten. Prozesse desselben Betriebssystemkontos können unter Umständen darauf zugreifen. Die Verbindungen lassen sich über „Remote-SSH → Verwalten“ in den Einstellungen oder „SSH-Remote-Umgebungen verwalten“ in den Arbeitsbereichsordnern verwalten.

**Persönlicher Modus.** Öffne „SSH-Remotes verwalten“ → „Verbindung hinzufügen“. Gib Host und Anmeldedaten ein und bestätige den Hostschlüssel, um die Verbindung zu speichern. Im zweiten Schritt kannst du Node ermitteln, den Helper installieren und anschließend „Befehlsausführung erlauben“ aktivieren. Klicke zum Speichern auf „Fertigstellen“. Öffne anschließend unter Arbeitsbereichsordner „Bindungen für entfernte Wurzeln verwalten“. Wähle eine Verbindung, wähle ein Verzeichnis und lege die Berechtigungen fest und registriere die Wurzel über das Menü „…“ in der Zeile des entfernten Verzeichnisses. Eine Verbindung kann mehrere Verzeichnisse anbinden.

Die Werkzeuge setzen eine kompatible SSH-Laufzeit voraus. Die Registry prüft bei jedem Aufruf die registrierten Verzeichnisse des aktuellen Arbeitsbereichs. Beim Ausschalten werden die Werkzeuge entladen und die Remote-Steuerungsebene geschlossen. Die einzelnen Schritte stehen in der [Anleitung zu SSH-Remote-Umgebungen](./docs/guide/user/ssh-remote-environments.en.md) (Englisch).

### Einstiegspunkte in der Oberfläche

- **Seitenleiste und Seite für neue Sitzungen**: Die Aktion **Ordner** unten in der Seitenleiste öffnet den Dialog **Arbeitsbereichsordner**; ab DSH `0.2.1-alpha.3` befindet sich derselbe Einstieg auch am rechten Rand der Arbeitsbereichszeile auf der Seite für neue Sitzungen (ohne Dropdown-Pfeil, in schmalen Fenstern nur als Symbol). Der Dialog ermöglicht das Hinzufügen und Entfernen von Wurzeln, das Bearbeiten von Alias und Berechtigung, das Ein- und Ausschalten der Skills je Wurzel, das Kopieren von Pfaden, das Anzeigen im Dateimanager sowie **Erneut versuchen** zum Aktualisieren der Liste und den Einstieg **Worktree-Vorschläge**.
- **Menü der Arbeitsbereichszeile**: Das `…`-Menü und das Kontextmenü der Arbeitsbereichszeile enthalten **Manage workspace folders…**; gehört die aktuelle Sitzung zu diesem Arbeitsbereich, öffnet sich der Dialog direkt, andernfalls wird zuerst die leere Seite dieses Arbeitsbereichs geöffnet oder wiederverwendet und der Dialog erst geöffnet, nachdem bestätigt ist, dass sie zur aktuellen Sitzung geworden ist.
- **Files-Tab**: Die Wurzelauswahl im Kopf wechselt zwischen der primären Wurzel und zusätzlichen Wurzeln; ist eine zusätzliche Wurzel ausgewählt, arbeiten Verzeichnisbaum, Öffnen von Dateien, Öffnen in der Anwendung, Kontextmenüs, automatische Aktualisierung und Arbeitsbereichssuche alle auf dieser Wurzel, und beim Zurückwechseln zur primären Wurzel erscheint die native Ansicht wieder.

### Modellseite

Die Topologie der zusätzlichen Wurzeln wird in den System-Prompt eingefügt und bei Änderungen der Freigaben aktualisiert; ein neues Werkzeug ist nicht erforderlich. Die `AGENTS.md` / `CLAUDE.md` einer zusätzlichen Wurzel gelangen ebenfalls bei Bedarf in den Kontext: die Datei auf der obersten Ebene der Wurzel vor dem ersten Schritt der Sitzung, die eines Unterverzeichnisses, nachdem diese Sitzung erfolgreich in diesem Verzeichnis gearbeitet hat.

Eine ausführlichere Beschreibung nach Funktionen steht in der [funktionsbezogenen Benutzeranleitung](./docs/guide/user/README.en.md).

## Projektstruktur

```text
.
├── src/
│   ├── roots.ts                      reine Regelschicht: Kanonisierung, Konfliktprüfung, Klassifizierung des Registrierungsstatus (available/missing/redirected/invalid)
│   ├── registry.ts                   Wurzel-Registry: Persistenz über dsh-storage-domain, ein einziger Speicherkern und Host-Fassade, speicherweite Reihenfolge von Zulassung und Änderung
│   ├── registry-lease.ts             prozessübergreifende Registry Authority: POSIX flock (der Kernel gibt sie beim Prozessende frei)
│   ├── registry-lease-win32.ts       dito, Implementierung über Windows Named Semaphore
│   ├── scope.ts                      ctx.multiRootScope: die einzige Autorisierungsquelle, veröffentlicht zugleich die modellsichtbare Topologie-Momentaufnahme
│   ├── fs.ts                         Dateisystem-Provider für mehrere Wurzeln (In-Process-Fence, Unterklasse des Upstream-LocalFileSystem)
│   ├── sandbox.ts                    Kernel-Sandbox-Provider für mehrere Wurzeln (Unterklasse des Upstream-LocalSandboxProvider)
│   ├── dialects.ts                   Erkennung von Seatbelt-/bwrap-/Landlock-Profilen und Zusammenbau zusätzlicher Grants (unbekannte Formen führen zu einem lauten Fehler)
│   ├── windows-*.ts                  Windows-root-set-ACL-Runner und Ausführung mit restricted token
│   ├── containment.ts                Pfad-Einschlussprüfung (lexikalischer Schnellpfad plus dev/ino-Alias-Fallback)
│   ├── instructions.ts               Erkennung, inkrementelle Zustellung, Budget und Rücknahme von AGENTS.md / CLAUDE.md zusätzlicher Wurzeln (oberste Ebene plus die in dieser Sitzung berührten Unterverzeichnisse, injiziert über agent/pre-step)
│   ├── lsp.ts                        eigener LSP-workspace für jede zusätzliche Wurzel, initialisiert an der Wurzel, in der die Datei liegt
│   ├── workspace-files.ts            Host-Routing und Confinement für das Dateibrowsing zusätzlicher Wurzeln im Files-Tab
│   ├── compat.ts                     Startgatter multi-root-compat (Versions-Allowlist und Erkennung gemischter Installationen)
│   ├── compat/                       Anpassungsschicht für Versionsunterschiede: dsh-version / sandbox-confine / agent-instructions / llm-message usw. (optionale Peers werden bei Bedarf geladen)
│   ├── command.ts                    der Befehl /workspace-folders und die Host-Hälfte des Panel-RPC
│   ├── worktrees.ts                  Zeile für Worktree-Vorschläge: Erkennung/Aktivierung/Watcher, Prompt-Warteschlange und Wartende, Bestätigung und ausdrückliches Aufräumen
│   ├── worktrees/                    kontrollierte Git-Metadaten-Momentaufnahmen (config/HEAD/index/Ahnenkette), Inventory, Sidecar und erneute Prüfung des Eigentümers (ohne Git-Aufruf)
│   ├── worktrees-contract.ts         strikter zweiseitiger Vertrag der Worktree-Endpunkte (diskriminierte Union, kein retry-Feld)
│   ├── contract.ts                   Wire-Protokoll des Panels (zod-Prüfung auf beiden Seiten, in das Browser-Bundle einbettbar)
│   └── client/                       Browser-Hälfte: Seitenleistenaktion, Ordner-Dialog, Wurzelauswahl im Files-Tab, Wörterbücher für die acht DSH-Sprachen
├── tests/                            differentielle Parität, reale Ausführungsmatrix der Dialekte, Vertrags-Roundtrips, Komponenten- und Locale-Gates, prozessübergreifende Lease-e2e, Instruktionsinjektion
├── scripts/                          Smoke-Läufe (compose / behavior / journey), Prüfungen für Dokumentation und Kernel-Runner, Prüfung des Kompatibilitätsvertrags, Upgrade-Ablauf
└── docs/                             Anforderungen, Architektur, Entscheidungsaufzeichnungen (ADR), Pläne, Entwicklungsworkflow
```

## Mitwirken

Issues und PRs sind willkommen:

1. Lesen Sie zuerst [`AGENTS.md`](./AGENTS.md) (repositoryweite Regeln) und den [Entwicklungsworkflow](./docs/development/plugin-development-workflow.md) (Umgebung, Befehle, Laufzeit-Supportmatrix, Upgrade-Ablauf).
2. Zweigen Sie von `main` ab; Commit-Nachrichten folgen Conventional Commits (`feat` / `fix` / `perf` / `refactor` + Scope), siehe die vorhandene Historie.
3. Vor einem PR müssen lokal alle folgenden Prüfungen bestehen: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (die CI führt sie in derselben Reihenfolge aus, erst build, dann test).
4. Änderungen am Verhalten aktualisieren im selben Änderungssatz die passende Dokumentation unter `docs/`; die acht Sprachfassungen des Root-README werden synchron gehalten (maßgeblich ist die chinesische Fassung); technische Entscheidungen mit Abwägungen werden in einer neuen ADR festgehalten.
5. Harte Vorgabe: **Kein Paket des Upstream-Repositories (deepseek-harness) wird geändert**; das Plugin bleibt eine Out-of-Tree-Erweiterung.

Die vollständigen Regeln stehen im [Beitragsleitfaden](./CONTRIBUTING.md).

## Bekannte Einschränkungen

### Plugin-Funktionen

- Instruktionsdateien zusätzlicher Wurzeln erreichen das Modell bei Bedarf: die Datei auf der obersten Ebene der Wurzel wird vor dem ersten Schritt der Sitzung injiziert, die eines Unterverzeichnisses, nachdem diese Sitzung **erfolgreich** in diesem Verzeichnis gearbeitet hat; verschachtelte Dateien werden nur erneut geprüft, wenn ihr Verzeichnis betrachtet wird (auf Wurzelebene bei jedem Schritt, bei Unterverzeichnissen entweder bereits zugestellt oder durch eine neue Berührung), der Zustellungsstatus liegt im Prozess (nach einem Resume kann dieselbe Information erneut mitgeteilt werden); offiziell erkannt werden `read` / `write` / `edit`, und bei aktiviertem OPS-Kompatibilitätsmodus treiben OPS-Werkzeuge die Zustellung über Live-Belege ebenfalls an (OPS-Historie ohne Live-Belege nimmt nach einem Resume nicht an der Zustellung teil). Die Instruktionskette der primären Wurzel und der benutzerglobalen Datei bleibt Aufgabe des Upstreams; dieses Plugin injiziert sie nicht erneut ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Mehrere Hosts teilen sich einen Registrierungsdienst: Nur ein Host verwaltet den Speicher, jede Instanz holt sich für jeden Vorgang eine Zulassung; ein Verbindungsabbruch beendet neue Freigaben für zusätzliche Wurzeln, und nach dem Ende der Autorität übernimmt ein anderer über die Kernel-Sperre. Gilt für dieselbe Maschine, denselben Benutzer und denselben Sperr-Namensraum; geteilte Verbindungen unter Linux benötigen SO_PEERPIDFD, unter Windows ist es auf dieselbe Anmeldesitzung beschränkt. Alte Prozesse und PTYs behalten ihre Start-Momentaufnahme ([gemeinsame Architektur](./docs/architecture/registry-authority-service.md)).
- Die Supportmatrix ist eine Allowlist exakter Versionen: Steht die Host-Version nicht auf der Liste oder mischen sich verschiedene Versionen der Kernpakete, **starten** die sechs Zeilen `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` **nicht**, und die Komposition fällt auf „dieses Plugin ist nicht installiert“ zurück ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- Der Windows-Runner für mehrere Wurzeln erbt die partielle Durchsetzung des Upstreams, die Bedingungen für caller-eigene Verzeichnisse und die Trennung des privaten Temp-Verzeichnisses; bereits gestartete Prozesse behalten die Wurzelmenge ihres Starts, spätere Prozesse verwenden die aktualisierte Menge ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Netzwerk- und Gerätepfade können unter Windows keine zusätzlichen Wurzeln sein**: UNC (`\\server\share`), `\\?\`, `\\.\` und gemappte Netzlaufwerke werden bereits bei der Registrierung mit `unsupported-path` abgelehnt – die Capability-SID des restricted token lässt sich nicht an einen SMB-Zugriff binden ([ADR-0011 Änderung](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Die eingeschränkte Windows-Shell ist pwsh und enthält kein Git Bash**: MSYS kann unter einem restricted Low-Integrity-Token nicht starten (der Upstream-Runner und der Plugin-Runner verhalten sich gleich, es ist eine Upstream-Einschränkung); ein eingeschränkter Kindprozess des Upstream-Runners erhält wegen des geerbten Ignore-Ctrl+C-Flags kein Ctrl+C, unter dem Plugin-Runner erreicht Ctrl+C den Kindprozess und der Runner spiegelt dessen Exit-Code.
- Die Zugriffsebene zusätzlicher Wurzeln ist dreiwertig: Neue Einträge sind standardmäßig `inherit` (folgen dem Sitzungsmodus), `--read-only` verweigert das Schreiben in jedem Modus (auch bei Full-access; die einzige Ausnahme ist eine vom Benutzer für einen einzelnen Aufruf genehmigte einmalige Eskalation, siehe [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)), und ein festes `--read-write` bleibt auch in einer schreibgeschützten Sitzung schreibbar (eine Frage der Schreibberechtigung, kein Lesen-Confinement; [ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). Bereits gestartete Prozesse und persistente Terminals behalten die Deny-Menge ihres Starts – ein Terminal, das vor dem Umschalten einer Wurzel auf schreibgeschützt gestartet wurde, bleibt bis zum Neustart unbeschränkt; Änderungen an cap/access wirken nur auf spätere Aufrufe und neue Prozesse ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)); Hosts, die workingDirectory anbieten, können eine zusätzliche Wurzel als Ausführungsverzeichnis für spätere Werkzeuge verwenden, während das ursprüngliche Projekt der Sitzung und die Registrierungsidentität unverändert bleiben ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **Auf Linux-Hosts, deren Upstream Landlock gewählt hat, benötigt ein eingeschränkter Full-access bwrap**: Die Allowlist von Landlock kann „alles schreibbar außer diesen Wurzeln“ nicht ausdrücken, daher wählt diese Kombination bubblewrap, um die Schreibsperrgrenze abzubilden; fehlt auf dem Host ein nutzbares bwrap (nicht installiert oder unprivilegierte userns deaktiviert), schlägt ein Full-access-Befehl mit irgendeiner Schreibsperrgrenze (schreibgeschützte Wurzel oder geschütztes `$DSH_HOME`) vor dem Start fehl (fail-closed). Aktivieren Sie dort bwrap, oder vermeiden Sie auf solchen Hosts ausdrückliche schreibgeschützte Wurzeln unter Full-access ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- Der Dateibaum zusätzlicher Wurzeln wird von der **Wurzelauswahl im Files-Tab** getragen: Der Einstieg im Kopf listet die primäre Wurzel und alle zusätzlichen Wurzeln auf, daneben wird weiterhin der vollständige Pfad der ausgewählten Wurzel angezeigt; ist eine zusätzliche Wurzel ausgewählt, übernimmt ein byte-genaues Abbild des Upstream-Files-Baums den Baumbereich (verzögert geladene Verzeichnisse, native Zeilen und Symbole, automatische Aktualisierung über watch, Klick auf eine Datei öffnet den Viewer des Hosts, manuelle Aktualisierung an Ort und Stelle im Kopfbereich), und die Schaltfläche „In Anwendung öffnen“ rechts im Kopfbereich wird zugleich von einem byte-genauen Abbild des Upstream-Steuerelements ersetzt, das die ausgewählte Wurzel statt der primären öffnet; beim Zurückwechseln zur primären Wurzel erscheint die native Ansicht wieder; der Dialog dient wieder ausschließlich der Verwaltung. Zeilen zusätzlicher Wurzeln bieten außerdem dieselben Zeilen-Kontextmenüs wie die primäre Wurzel (Dateizeilen, Verzeichniszeilen; im Ordner-Navigator der Dateivorschau gilt dasselbe), und für die ausgewählte Wurzel steht eine Arbeitsbereichssuche zur Verfügung (Suchschaltfläche im Seitenkopf, Suchleiste, Trefferbaum mit Hervorhebung, Einstellungs-Popover und Filter ausgeblendeter Einträge); beides erscheint nur, wenn der Host die entsprechende Struktur bereitstellt – Zeilenmenüs erfordern `useContextMenu` (ab `0.2.2-alpha.3`), die Suche erfordert `workspaceFiles.search` (ab `0.2.2-rc.2`), auf älteren Hosts werden keine Zeilenmenüs gebunden und keine Sucheinstiege gerendert, die Ansicht bleibt unverändert. Diese Übernahme beruht auf `data-*`-DOM-Hooks des Upstreams; wenn die Hooks nicht mehr greifen, fällt sie stillschweigend auf die native Darstellung zurück ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). LSP initialisiert je nach Wurzel, in der eine zusätzliche Datei liegt, einen eigenen workspace; der Host muss den passenden Language Server konfigurieren ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)). Bekannte Grenzen: Die native Files-Tastenkombination **Cmd+P** fokussiert weiterhin das native Suchfeld, das die Übernahme ausgeblendet hält, daher dient die native Tastenkombination nicht als Sucheinstieg für zusätzliche Wurzeln – weder die Suchoberfläche der Files-Seite noch die des Vorschau-Navigators reagiert darauf ([ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md), [ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)); die Suchhistorie des Vorschau-Navigators wird je `(pane, root)` gespeichert, getrennt von `(tab, root)` der Files-Seite, sodass eine Abfrage der Files-Seite im selben pane nicht in die Vorschau übernommen wird; die aktuelle Zeile eines Ergebnisses wird nur markiert, nicht automatisch gescrollt; das Schließen des Ordners oder ein Wurzelwechsel im selben pane verwirft ungespeicherte Einstellungsentwürfe ([ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)).
- Wenn ein Drittanbieter-Plugin den gesamten Files-Tab übernimmt (es registriert die Art `files` mit `priority: "extension"`), sind die Wurzelauswahl und das Browsing zusätzlicher Wurzeln nicht verfügbar; das Plugin zeigt einmalig einen offiziellen Info-Hinweis, nach dem Ende der Übernahme ist ein erneuter Hinweis möglich, und die Wurzelverwaltung bleibt über den Einstieg **Ordner** in der Seitenleiste sowie über `/workspace-folders` möglich ([Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)).
- Die Ausgabetexte des Befehls sind englisch (hostseitig gibt es keine Information über die aktive Sprache); die Texte des Panels folgen der Sprache der Oberfläche und sind in allen acht von DSH angebotenen Sprachen verfügbar.
- Das Arbeitsbereichsordner-Panel ist „Aktion am unteren Rand der Seitenleiste + Dialog“ und kein eigenständiges Vollbild-Panel: `sidebar.footer.action` ist ein Slot, den alle unterstützten Versionen anbieten, `sidebar.panellist`/`main` dagegen nicht. Ab DSH `0.2.1-alpha.3` hängt zusätzlich ein inkrementeller Einstieg am Slot `conversation.hero.options` der Seite für neue Sitzungen: Er hat dieselbe Geometrie wie die benachbarten Arbeitsbereichs- und Modusauswahlen, keinen Chevron, schrumpft entsprechend dem in der Arbeitsbereichszeile gemessenen freien Platz und fällt unter 88 px auf eine 28×28-Symbolschaltfläche zurück (der options-Container des Upstreams ist `flex: none`, das Plugin ändert DSH nicht, sondern misst nur den freien Platz und begrenzt sich selbst; erkennt die Sonde die Zeilenstruktur nicht, greift als Rückfall die 560-px-Viewport-Stufe); fehlt dieser Slot in einer älteren Laufzeit, löst die Registrierung stillschweigend nicht aus, der Einstieg in der Seitenleiste bleibt unberührt ([ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)). Die Rundung der rail (eingeklappter Zustand) des Seitenleisten-Einstiegs hat ihre eigene, frühere Grenze `0.1.6-alpha.2`: 23 unterstützte Versionen zeichnen wie der Host ein 12-px-Quadrat mit abgerundeten Ecken, bei den zwei ältesten Versionen (`0.1.5-rc.2`, `0.1.6-alpha.1`) zeichnet der Host einen Kreis, das Plugin aber ein 12-px-Quadrat mit abgerundeten Ecken – die dokumentierte Rundungsabweichung (ohne Auswirkung auf Ink/Layout); die `@media (hover: hover)`-Umhüllung existiert nur in den 6 Versionen mit neuer Geometrie, das Plugin bleibt ohne Umhüllung, sodass es auf Touch-Geräten einen Unterschied im Hover-Feedback zu diesen Versionen gibt ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)). Die Höhe des Seitenleisten-Einstiegs folgt dem Occupant derselben Einstellungszeile und hängt am strukturellen Marker `data-signed-out` des Konto-Launchers (eine CSS-`:has()`-Abhängigkeit, kein Slot-Vertrag): die 7 Versionen bis einschließlich `0.1.7-rc.2` behalten die 42-px-Höhe des Einstellungs-Triggers; ab `0.2.0-rc.1` sind es 32 px abgemeldet / 44 px angemeldet, die rail bleibt fest bei 36 px; wird der Marker umbenannt oder verschwindet er, greift ein Rückfall auf 42 px (keine falsche Größe), was nur die Höhe betrifft ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)).

### OPS-Anpassung

Die aktuelle Implementierung wird als **OPS-Kompatibilitätsmodus (experimentell, standardmäßig deaktiviert, Einschränkungen möglich)** angeboten: Setzen Sie unter `Settings → Plugins → Multi-root Workspace` die Einstellung `multi-root-ops-compatibility.enabled`, die standardmäßig `false` ist und ausdrücklich eingeschaltet werden muss. Die Funktion lässt sich nur auf DSH `0.2.*` innerhalb der bestehenden exakten Supportmatrix aktivieren; unter `0.1.*` bleibt sie auch bei manuell konfiguriertem `enabled: true` deaktiviert, und die ältere Settings-Oberfläche wird nicht unterstützt ([Entscheidung zum Versionsbereich](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06)). Beim Einschalten über die Einstellungsoberfläche müssen Sie den offiziellen Risikodialog lesen, bestätigen, dass Sie die Einschränkungen kennen, und erneut bestätigen; bis zur Bestätigung bleibt die Funktion deaktiviert, und Abbrechen, Schließen des Dialogs oder Esc speichern die Aktivierung nicht.

- **Eingeschaltet**: aktiviert OPS-Ausführungsschutz, Live-Aktivität und Review-Erweiterungen. Full-access (`danger-full-access`) schützt explizite RO-/Cap-Deny-Regeln auf den verifizierten macOS-/Linux-Lanes durch Kernel-Fencing; unter Windows werden OPS-Ausführungsaufrufe mit Deny (einschließlich Lesen) konservativ vor der Worker-Vorbereitung abgelehnt, geschützte Vorbereitung und legitime Schreibvorgänge in dieser Kombination werden noch nicht unterstützt. Sobald in WW/RO eine nicht schreibbare zusätzliche Wurzel oder eine schreibgeschützte Obergrenze für ein Werkzeug existiert, wird der gesamte OPS-Ausführungsaufruf (einschließlich Lesen/page) vor der Vorbereitung und dem eigentlichen Lauf abgelehnt. In allen Modi werden OPS-Ausführungsaufrufe abgelehnt, wenn die Registry-Berechtigung fehlt; reine Erkennung und Veröffentlichung ausgenommen. subprocess-Starts ohne Ausführungsdomäne oder ohne Nachweis durch das aktuell gültige Profil werden ebenfalls abgelehnt, damit Hintergrundbereinigungen die Grenze nicht umgehen; das kann auch Hintergrundprozesse von Drittanbietern ablehnen, blockiert aber nicht das eigene Terminal des Benutzers im Panel.
- **Ausgeschaltet**: OPS verhält sich wie vor dieser Anpassung und bietet diese Absicherungen nicht – **explizit schreibgeschützte zusätzliche Wurzeln können von OPS beschrieben werden**. Die normalen Multi-Root-Funktionen, die nativen Werkzeug-Fences und der eigene Schalter von Auto Review bleiben unberührt. Bereits zugestellte Instruktionen werden nicht rückwirkend gelöscht, Aufrufe, die bereits in einer geschützten Domäne laufen, und gestartete Prozesse behalten ihre ursprüngliche Momentaufnahme; neu beginnende Aufrufe aktivieren diese Anpassung nicht mehr.
- **Experimentelle Einschränkungen**: Es gibt nur einen Live-Aktivitätsindex der Phase A, keine dauerhafte Ereignisbrücke. Im eingeschalteten Zustand fehlen der OPS-Historie nach einem Resume die Live-Belege, und dynamische Pending-Zustände (replace/batch/result/bash/unknown) lassen Review technisch scheitern; nicht auf der Allowlist stehende Diagnosen wie `ops_status` unterliegen ebenfalls dieser konservativen Regel.

Konkrete bekannte Lücken:

- **Umgehung der Nur-Lese-Beschränkung von dsh-ops (F01, historische Basis)**: In den auditierten Versionen schrieb das OPS-Native-Werkzeug `ops_write_file` unter Full-access tatsächlich in eine ausdrücklich schreibgeschützte zusätzliche Wurzel, während die native fs-Kontrolle im selben Durchlauf abgelehnt wurde. Mit aktiviertem OPS-Kompatibilitätsmodus wurde in diesem Durchgang verifiziert, dass die begrenzte Anpassung die explizite RO-/Cap-Deny-Grenze unter Full-access gegenüber OPS Native und echtem PTC durchsetzt (Nachprüfung der Deny-Durchsetzung in [Audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); Versionen, Testumfang und ursprüngliche Belege stehen im [Kompatibilitätsaudit](./docs/reviews/dsh-ops-compatibility-audit.md).
- **Legitime Schreibvorgänge und Unterverzeichnis-Instruktionen bei dsh-ops (F04/F05, historische Basis)**: Das Problem, dass OPS-Vorabprüfungen unter WW Schreibvorgänge in ererbte oder fest schreibbare zusätzliche Wurzeln und unter RO in fest schreibbare zusätzliche Wurzeln ablehnen, ist nicht gelöst; die Lücke bei Unterverzeichnis-Instruktionen (F05), dass OPS-Lesevorgänge die Erkennung nicht auslösen, wurde in diesem Durchgang mit Live-Index und echtem AgentLoop im aktivierten Modus als behoben nachgeprüft (von Native und PTC erfolgreich berührte Unterverzeichnis-Instruktionen gelangen in die nächste Modellanfrage, siehe [Audit §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); die verifizierten Pfade für Instruktionen auf Wurzelebene und Skills sind nicht betroffen.
- **WW-batch/result-Degradierung unter Linux bwrap (F07)**: Unter der geteilten Registry der auditierten Version verlieren alle `ops_batch` / `ops_result`-Aufrufe (einschließlich `page`), die den Startzweig erreichen und einen gültigen cache erhalten, ihren argv-Herkunftsnachweis, weil nach dem confine ein bind angehängt wird; der Quellcode-Pfad lehnt den Worker-Start mit `EXECUTOR_UNAVAILABLE` ab. Der Konflikt auf Funktionsebene ist reproduziert, Linux wurde nicht Ende-zu-Ende getestet; gewöhnliches RO, Landlock und die Kontrollen ohne cache fallen nicht unter diese Aussage. OPS müsste eine Schnittstelle bereitstellen, um cache vor dem confine zu deklarieren; eine einseitig im MR umgesetzte Abhilfe ist derzeit nicht verifiziert, siehe [Audit F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突).
- **Weitere Grenzen der OPS-Verfügbarkeit**: Unter geteiltem WW wird ein purge außerhalb der Planung ohne gültige Zulassung abgelehnt, Ergebniscaches können daher zurückbleiben und eine Warnung erzeugen; verschachtelte PTC-Aufrufe und Hintergrund-Bash bergen ebenfalls das Risiko einer Ablehnung wegen fehlender oder abgelaufener Nachweise. Die konservativen Ablehnungsgrenzen wurden in diesem Durchgang auf allen drei Plattformen verifiziert; normaler Hintergrundbetrieb und Aufräumen sind weiterhin nicht wiederhergestellt und wurden auf unbestimmte Zeit verschoben, siehe [endgültiger Umfang in ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05).

Die P5-Absicherungen dieses Repositories ändern OPS nicht: legitime Schreibvorgänge in zusätzliche Wurzeln können weiterhin fälschlich abgelehnt werden, und Ergebniscaches im Hintergrund können zurückbleiben, weil das Aufräumen abgelehnt wird; im legacy-Modus ohne gemeinsame Registry kann PTC unter WW/RO ebenfalls abgelehnt werden, bevor der Codeprozess startet. Die dauerhafte Aktivität bleibt deaktiviert: DSH verbietet externen Plugins ausdrücklich den Aufruf von `appendPluginRecord`, und gewöhnliche Ereignisse oder eigene Logschreibvorgänge sind kein Ersatz. P6 wurde im festgelegten Umfang technisch abgenommen; die restlichen Funktionen von P5 und die Abnahme der vollständigen Kompatibilität sind **auf unbestimmte Zeit verschoben**, sind keine Bedingung für diesen Abschluss, und eine künftige Wiederaufnahme erfolgt ausschließlich als experimentelle Fähigkeit. Die Liste der Verschiebungen steht in [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源), der Abnahmeumfang im [abgeschlossenen Plan](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md).

Diese experimentellen konservativen Absicherungen werden mit `v0.1.15` ausgeliefert; sie beanspruchen keine vollständige OPS-Kompatibilität und heben die unterstützten Versionen nicht an. Die historische Nachprüfung in Audit §16 fand vor dem Hinzufügen dieses Schalters statt und entspricht dem aktivierten Pfad; spätere Wiederholungen erfordern ausdrücklich `enabled: true`.

## Dokumentation

Die langfristige Projektdokumentation liegt unter [`docs/`](./docs/README.md):

- [Versionsänderungen (CHANGELOG)](./CHANGELOG.en.md)
- [Benutzeranleitung](./docs/guide/README.en.md)
- [Anforderungen](./docs/requirements/multi-root-workspace.md)
- [Zielarchitektur](./docs/architecture/multi-root-workspace.md)
- [Upstream-Recherche](./docs/reference/multi-root-workspace-research.md)
- [Entscheidungsaufzeichnungen (ADR)](./docs/decisions/README.md)
- [Pläne](./docs/plans/README.md)
- [Entwicklungsworkflow](./docs/development/plugin-development-workflow.md)
- [Fehlerbehebung](./docs/troubleshooting/README.md)

Die repositoryweiten Regeln für Coding Agents stehen in [`AGENTS.md`](./AGENTS.md).

## Lizenz

[MIT](./LICENSE)

Lizenzen Dritter: [THIRD_PARTY_LICENSE](./THIRD_PARTY_LICENSE)
