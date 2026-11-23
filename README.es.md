<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

<img alt="GitHub License" src="https://img.shields.io/github/license/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="NPM Version" src="https://img.shields.io/npm/v/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">
<img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">

[中文](./README.md) | [English](./README.en.md) | [日本語](./README.ja.md) | Español | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | [Português](./README.pt.md)

</div>

## Descripción del proyecto

Por defecto, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) usa el directorio en el que se crea un nuevo espacio de trabajo como directorio principal del agente y, en el modo de lectura y escritura predeterminado del espacio de trabajo (`workspace-write`), el alcance de lectura y escritura del sandbox se limita a ese único directorio. Este plugin amplía el alcance del espacio de trabajo de DSH a «una raíz principal + varias raíces adicionales».

No todos los proyectos son monorepos. Un proyecto de desarrollo suele estar formado por varios repositorios Git independientes, y trabajar entre ellos obligaba antes a cambiar de sesión una y otra vez. Otras herramientas similares ya permiten añadir varias carpetas a un mismo espacio de trabajo, y este plugin lleva esa misma capacidad a DSH: registre los demás repositorios como raíces adicionales y asígneles solo lectura, lectura y escritura, o el permiso actual de la sesión, y el agente podrá leer y escribir dentro de ese permiso.

- **Herramientas nativas**: en los espacios de trabajo locales, el agente sigue usando las herramientas nativas `read` / `write` / `edit` / `bash`; simplemente obtiene algunos directorios más en los que trabajar.
- **Permisos que se aplican de verdad**: cada raíz adicional puede configurarse como solo lectura, lectura y escritura, o heredar el permiso de la sesión actual; el límite lo aplica realmente el sandbox del sistema, no un aviso en el prompt dirigido al modelo. Las operaciones de archivos y los comandos bash del agente están sujetos al mismo permiso; los procesos que otros plugins inicien por su cuenta quedan fuera de esta garantía.
- **Navegue por las raíces adicionales en la pestaña Files**: la cabecera de la pestaña Files permite cambiar entre la raíz principal y cualquiera de las raíces adicionales; el árbol de directorios, la apertura de archivos, la apertura en una aplicación externa, los menús contextuales, la actualización automática y la búsqueda funcionan igual que en la raíz principal, y el navegador de la vista previa de documentos también se sitúa en la raíz que contiene el archivo. En versiones de host más antiguas puede que estas acciones de la interfaz no estén disponibles, y la raíz adicional se muestra tal como lo hace el host de forma nativa.
- **Skills en las raíces adicionales**: descubre `.dsh/skills` y `.agents/skills` en las raíces adicionales y permite invocarlas con `/alias:nombre-de-skill`; cada raíz tiene su propio interruptor, activado por defecto.
- **Auto Review (experimental, desactivado por defecto)**: una vez activado manualmente en el gestor de plugins, la revisión automática también ve la estructura de directorios, los niveles de acceso y los archivos de instrucciones de las raíces adicionales, y las incluye en la revisión.
- **Sugerencias de Worktree (experimental, desactivado por defecto)**: cuando la raíz principal es un worktree de Git, el plugin propone añadir otros worktrees del mismo repositorio como raíces adicionales; solo se registran cuando usted lo confirma, y nunca se añaden ni se eliminan de forma automática.
- **Entornos remotos SSH (experimental, desactivado por defecto)**: activa SSH personal en la página del complemento para usar `remote_copy` y `remote_bash` en directorios remotos registrados. Las conexiones y los vínculos del espacio de trabajo se gestionan por separado, y el Registry autoriza cada llamada.
- **No registrar equivale a no tenerlo instalado**: sin raíces adicionales, el comportamiento es exactamente el mismo que con el plugin no instalado; una configuración incorrecta genera un error en lugar de degradarse en silencio.

La última publicación es la beta `v0.1.24-beta.4`; la etiqueta `latest` de npm sigue apuntando a la versión estable `v0.1.23`, así que instala la beta indicando `@beta`. Los cambios visibles para el usuario de cada versión están en el [CHANGELOG](./CHANGELOG.en.md); el progreso y el estado de publicación están en el [libro mayor de progreso de la hoja de ruta](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Inicio rápido

El plugin está publicado en [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace). Para los perfiles de CLI (`web`, `headless`, etc.) la instalación se completa en dos pasos:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # elija --profile según cómo inicie DSH; consulte la documentación de DSH para ver los valores disponibles
```

**Usuarios de DSH Desktop**: instale el plugin introduciendo `@dsh-electron/dsh-plugin-multi-root-workspace` en la página de plugins; si el arranque muestra un error, reinicie DeepSeek Harness Desktop.

Las demás formas de instalación (tarball, GitHub, código fuente local) se describen en [Instalación](#instalación).

Una vez instalado, añada una raíz adicional en la sesión:

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

## Requisitos

**Uso del plugin**: una versión de DSH de la tabla siguiente (coincidencia exacta, no un rango). De la instalación se encarga `dsh plugin`, sin necesidad de ninguna cadena de herramientas de Node en local.

| Serie de DSH | Versiones compatibles |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5` |

Si la versión de DSH no figura en la tabla, o si los paquetes `@deepseek-ai/dsh-*` no coinciden entre sí en la versión, el plugin no se inicia y su comportamiento equivale al de no tenerlo instalado.

**Compilar desde el código fuente / contribuir**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (se recomienda habilitarlo con corepack); la versión de DSH fijada para el desarrollo es `0.2.2-rc.5` (Node ≥24.9).

**Plataformas**: macOS (Seatbelt), Linux (bwrap / Landlock), Windows (root-set ACL runner).

## Instalación

La instalación admite dos vías: desde la línea de comandos (CLI) o desde el gestor de plugins de la interfaz gráfica de Web / Desktop. Basta con una de las dos.

### Instalación desde la CLI

`dsh plugin` admite cuatro orígenes de instalación, que se muestran aquí con el perfil `web`; los demás perfiles de CLI, como `headless`, funcionan igual. **Usuarios de DSH Desktop**: el perfil `desktop` debe gestionarse con la CLI `dsh` integrada en DeepSeek Harness Desktop; los pasos están al final de esta sección.

| Origen | Comando | Descripción |
| --- | --- | --- |
| Registro npm (recomendado) | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | Artefactos precompilados, listos para usar |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | Compila automáticamente desde el código fuente al instalar; `allowBuilds` debe contener la clave exacta de este paquete, por lo que se recomienda fijar la versión |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | Paquete precompilado, adecuado para redes internas o entornos sin conexión |
| Desde el código fuente | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | Enlace `link:` de pnpm a una copia local, ideal para desarrollo y depuración; no requiere `allowBuilds` |

#### Instalar desde npm (recomendado)

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

Actualmente `latest` es la versión estable `v0.1.23`; para instalar la beta (`v0.1.24-beta.4` en esta entrega), indica `@beta` explícitamente:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace@beta
```

#### Instalar desde un tarball

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# o descargue el tgz de los recursos del GitHub Release, por ejemplo:
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.24-beta.4/dsh-electron-dsh-plugin-multi-root-workspace-0.1.24-beta.4.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.24-beta.4.tgz
```

También son artefactos precompilados, adecuados para entregas en redes internas o entornos sin conexión.

#### Instalar desde GitHub

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

Una instalación desde GitHub descarga el código fuente y lo compila automáticamente durante `add`, sin necesidad de compilar a mano; pnpm bloquea el `prepare` del propio paquete e imprime una línea con la clave exacta (origen y commit incluidos). Copie esa línea tal cual en `allowBuilds` y vuelva a ejecutar `add`:

```yaml
allowBuilds:
  # Tanto la clave como el valor proceden del ejemplo «Add the package to allowBuilds» del mensaje de error de pnpm;
  # una clave con solo el nombre del paquete, sin origen ni commit, no surte efecto en los orígenes git.
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

Se recomienda fijar una versión (por ejemplo `#v0.1.24-beta.4`) para que un push posterior no pueda cambiar en silencio lo que realmente se ejecuta:

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.24-beta.4
```

#### Instalar desde una copia local del código fuente

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> Si `dsh` no está en el PATH (por ejemplo, si ejecuta DSH desde una copia del código fuente), sustituya `dsh` por `pnpm dsh` en los comandos.

<details>
<summary>Cómo ejecutarlo</summary>

Comprobaciones locales de desarrollo:

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

Instálelo en un entorno de ejecución de DSH y verifique la composición:

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

Salida esperada:

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

Las dos filas `fs-sandbox` y `sandbox` de upstream quedan deshabilitadas y las asumen los servicios homónimos del plugin, mientras que todas las filas `multi-root-*` del propio plugin quedan montadas. Tras el arranque aparece una acción **Carpetas** (glifo de árbol de espacio de trabajo) al pie de la barra lateral; en DSH `0.2.1-alpha.3` y posteriores, el mismo acceso también se muestra en el extremo derecho de la fila del hero de la página de nueva sesión.

</details>

#### Instalar con la CLI integrada de DeepSeek Harness Desktop

DeepSeek Harness Desktop puede instalar un comando `dsh` global desde la opción «Gestionar el comando dsh…» de su menú de aplicación; use ese comando para gestionar el perfil `desktop`.

1. Cierre Desktop por completo, incluido el icono de la bandeja.
2. Instalación nueva:
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24-beta.4
   ```
3. Ya instalado pero sin el registro del bundle: ejecute `remove` y después `add` (volver a ejecutar solo `add` no añade el registro):
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24-beta.4
   ```
4. Abra `$DSH_HOME/profiles/desktop/package.json` (normalmente `~/.dsh/profiles/desktop/package.json` cuando `DSH_HOME` no está definido) y confirme que `dsh.profile.bundles` incluye este paquete.
5. Vuelva a abrir Desktop (arranque en frío).

Si `add` termina con código 0 pero el plugin no llega a `dsh.profile.bundles`, ejecute un `remove` + `add`. La causa del conflicto de habilitación en caliente, el registro de reproducción y la investigación sobre quién escribe realmente en el perfil están en la [solución de problemas](./docs/troubleshooting/desktop-install-missing-bundle.md).

### Instalación desde el gestor de plugins de la GUI de Web / Desktop

Tanto Web como Desktop instalan desde la página «Plugins» de la barra lateral: elija «Añadir plugin», escriba `@dsh-electron/dsh-plugin-multi-root-workspace` e instálelo. Cuando termine, elija «Habilitar ahora»: la instalación por sí sola no activa el plugin. Si la página de plugins no ofrece la entrada «Añadir plugin», use la CLI descrita arriba.

Después de instalar o habilitar el plugin hay que reiniciar la aplicación DeepSeek Harness: cierre Desktop por completo (incluido el icono de la bandeja) y vuelva a abrirlo, o reinicie el proceso `dsh web`. Habilitar este plugin en una aplicación en ejecución puede provocar un error de registro duplicado de `fs` / `sandbox`; tras reiniciar, la carga se realiza con normalidad.

## Uso

### Comando

```text
/workspace-folders [list]                                                   # muestra la raíz principal y las raíces adicionales (con el permiso y el estado de cada una)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # sin ruta abre el selector de directorios del sistema; los nuevos registros usan inherit por defecto
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # atajo de /workspace-folders add
/workspace-folders access <order|path> inherit|read-only|read-write         # cambia el nivel de acceso (ampliar el permiso exige que la raíz esté disponible en ese momento)
/workspace-folders skills <order|path> on|off                               # activa o desactiva las Skills de esa raíz sin cambiar el permiso de escritura
/workspace-folders alias-id <order|path> <kebab-case>                        # edita el espacio de nombres estable de las Skills
/workspace-folders alias <order|path> [alias]                               # sin alias, borra el alias existente
/workspace-folders remove <order|path>                                      # el número es el que imprime list
/workspace-folders reveal <order|path>                                      # lo muestra en el gestor de archivos
/workspace-folders isolate-profiles [--apply]                               # inspecciona (con --apply, escribe) el modo de importación de dependencias del perfil
/workspace-folders help                                                     # muestra la ayuda del comando
```

- Las rutas pueden ir entre comillas y `~` se expande; se rechazan las rutas duplicadas, las anidadas dentro de una raíz ya registrada, la propia raíz principal y las rutas protegidas como `$DSH_HOME` o el directorio de almacenamiento del Registry.
- `remove` / `access` / `alias` / `reveal` aceptan `número|ruta`; `add` sin ruta abre el selector de directorios del sistema (cuando el host lo ofrece) y también puede recibir solo el parámetro de permiso.
- `list` muestra el permiso y el estado de cada raíz. Si un directorio falta temporalmente (`missing`) o ha sido sustituido por un enlace que apunta a otro lugar (`redirected`), la raíz conserva su registro pero no se concede; cuando el directorio vuelve, basta con ejecutar `list` o actualizar «Carpetas del espacio de trabajo» para que se recupere automáticamente.
- `isolate-profiles` sirve de comprobación previa para el Full-access restringido de Windows: por defecto solo inspecciona el `packageImportMethod` de cada perfil bajo `$DSH_HOME`, y `--apply` escribe la configuración `copy`; no elimina `node_modules` ni modifica las dependencias existentes.

### Niveles de acceso

| Nivel de acceso | Sesión `workspace-write` | Sesión `read-only` | Sesión `danger-full-access` |
| --- | --- | --- | --- |
| `inherit` (predeterminado en los nuevos registros) | permite escritura | deniega escritura | sin restricciones |
| `read-only` | deniega escritura | deniega escritura | deniega escritura (incluido Full-access) |
| `read-write` | permite escritura | permite escritura | permite escritura |

- Los nuevos registros usan `inherit` por defecto; un cambio de permiso solo afecta a las llamadas posteriores y a los procesos nuevos, mientras que los procesos ya iniciados y las terminales persistentes conservan el permiso con el que arrancaron.
- Una elevación puntual a `danger-full-access` aprobada por el usuario para una sola llamada puede levantar las denegaciones por raíz de solo lectura y por límite de herramienta de esa llamada; `$DSH_HOME` y la degradación por falta de autoridad del Registry no se ven afectados.
- Cada raíz principal admite como máximo 16 raíces adicionales (`maxAdditionalRoots` puede elevarse hasta 64). El host puede limitar de forma permanente una herramienta con `toolAccess` en la fila `multi-root-scope`; por ejemplo, `{ bash: 'read-only' }` impide que bash escriba en cualquier raíz adicional (aunque sigue pudiendo escribir en la raíz principal).

### Skills en raíces adicionales

- Las Skills se descubren en `.dsh/skills` y `.agents/skills` de cada directorio adicional; los nombres y las descripciones están visibles en el primer paso del modelo, y el cuerpo se carga bajo demanda.
- La raíz principal usa `/nombre-de-skill`; las raíces adicionales usan `/alias-id:nombre-de-skill` (con autocompletado en el menú Slash). El modelo las invoca mediante la herramienta nativa `skill`, por lo que en el registro de la herramienta pueden aparecer los ID internos.
- Las nuevas raíces `inherit` / `read-write` tienen las Skills activadas por defecto, y las raíces `read-only` las tienen desactivadas; el diálogo permite activarlas o desactivarlas por raíz y editar `aliasId` (cambiar el Alias mostrado no modifica `aliasId`). Activar las Skills en una raíz de solo lectura no concede permiso de escritura.
- En la página «Plugins» de la barra lateral, abra la página de detalles de Multi-root Workspace; la opción **Habilitar Skills de raíces adicionales** de la tarjeta de ajustes controla todas las raíces adicionales y está activada por defecto. Al desactivarla se detienen el descubrimiento y la invocación nuevos, pero se conserva la selección de cada raíz; las Skills de la raíz principal, las instrucciones, el LSP, la navegación de archivos y los permisos del sandbox no se ven afectados.

### Sugerencias de raíces Worktree (experimental, desactivado por defecto)

Cuando la raíz principal es la raíz de un worktree de Git, el plugin reúne los demás worktrees del mismo repositorio como candidatos en una única tarjeta de sugerencias, incluidos los worktrees creados antes por una terminal, un IDE o un forge; si la sesión es a su vez un worktree enlazado y está en `workspace-write`, también aparece como candidato el checkout principal de ese repositorio. El descubrimiento solo lee metadatos de Git y no inicia ningún subproceso de Git; **nunca añade ni elimina raíces de forma automática**, y las sesiones `danger-full-access` no reciben la sugerencia. Para activarlo, abra la página de detalles de Multi-root Workspace en la página «Plugins» de la barra lateral y active **Habilitar sugerencias de raíces Worktree** en la tarjeta de ajustes (desactivado por defecto).

La sugerencia es una tarjeta permanente: permite «Ver» o «Recordar más tarde» (hasta que aparezca un nuevo worktree, o dentro de 7 o de 30 días); el botón de cerrar de la esquina superior derecha solo descarta el aviso actual, que reaparece tras reiniciar. Una vez cerrada, puede volver a abrirla desde «Sugerencias de Worktree», junto a «Reintentar», en el diálogo «Carpetas del espacio de trabajo». El diálogo de confirmación muestra en cada línea la ruta, la rama y el permiso (por defecto `inherit`, modificable a solo lectura o lectura y escritura), y permite marcar varios candidatos cuando hay más de uno; la línea del checkout principal indica además su alcance: el árbol de código fuente del checkout principal, las config/hooks/refs/objects compartidas y los datos de administración de todos los worktrees, lo que puede afectar a otros checkouts del mismo repositorio. El registro tiene ámbito de espacio de trabajo, así que **otras sesiones de lectura y escritura también obtienen el permiso elegido**; al confirmar se vuelve a validar cada elemento, y cualquier cambio ocurrido entretanto lo invalida. El diálogo permite además elegir que no se vuelva a preguntar.

Cuando un worktree se elimina o se mueve, el diálogo muestra una insignia, pero **nunca se limpia de forma automática**; la entrada de limpieza solo se ofrece cuando se confirma que el directorio falta y que la identidad del registro coincide (en lote o por línea), y se confirma en un cuadro de confirmación superpuesto al diálogo. Antes de limpiar, un directorio nuevo en la misma ruta podría heredar la autorización anterior; el cuadro de confirmación advierte de ese riesgo.

### Adaptación de Auto Review (experimental, desactivada por defecto)

Si necesita contexto de revisión con varias raíces, active la fila Auto Review, desactivada por defecto, en la lista de componentes de la página de detalles de Multi-root Workspace en la página «Plugins» de la barra lateral; el interruptor «Auto Review multi-raíz (experimental)» de la misma tarjeta de ajustes es equivalente y también está desactivado por defecto. Una instalación normal no activa ni selecciona Auto Review; la integración solo está disponible en las versiones exactas de DSH que la incluyen.

### Entornos remotos SSH (experimental, desactivado por defecto)

La incidencia #32 ofrece por ahora solo SSH personal. Activa **Entornos remotos SSH** en los ajustes del complemento y confirma el aviso de riesgo. El host local de DSH conserva las credenciales SSH, a las que pueden acceder procesos que se ejecuten con la misma cuenta del sistema operativo. Puedes gestionar las conexiones desde «SSH remoto → Gestionar» en los ajustes o «Gestionar remotos SSH» en Carpetas del espacio de trabajo.

**Modo personal.** Abre «Gestionar remotos SSH» → «Añadir conexión». Introduce el host y las credenciales, confirma la clave del host y guarda la conexión. En el segundo paso, detecta Node, instala el helper, marca «Permitir ejecución de comandos» y pulsa «Finalizar» para guardar. Vuelve a Carpetas del espacio de trabajo y abre «Gestionar vínculos de raíces remotas». Elige una conexión guardada, selecciona un directorio y configura sus permisos y regístrala desde el menú «…» de su fila en los directorios remotos. Una misma conexión admite varios directorios.

Las herramientas requieren un entorno de ejecución SSH compatible. El Registry autoriza cada llamada según los directorios registrados en el espacio de trabajo actual. Al desactivar SSH se descargan las herramientas y se cierra el plano de control remoto. Consulta la [guía de entornos remotos SSH](./docs/guide/user/ssh-remote-environments.en.md) (en inglés).

### Accesos en la interfaz

- **Barra lateral y página de nueva sesión**: la acción **Carpetas del espacio de trabajo** situada al pie de la barra lateral abre el diálogo «Carpetas del espacio de trabajo»; desde DSH `0.2.1-alpha.3`, el mismo acceso aparece también en el extremo derecho de la fila del hero de la página de nueva sesión (sin flecha desplegable, y en ventanas estrechas solo se muestra el icono). El diálogo permite añadir y quitar raíces, editar alias y permisos, activar o desactivar las Skills por raíz, copiar rutas, mostrar en el gestor de archivos, y ofrece «Reintentar» para actualizar la lista y el acceso a «Sugerencias de Worktree».
- **Menú de la fila del espacio de trabajo**: tanto el menú `…` como el menú contextual de la fila del espacio de trabajo incluyen «Gestionar carpetas del espacio de trabajo…»; si la sesión actual pertenece a ese espacio de trabajo, se abre directamente, y si no, primero se abre o se reutiliza la página en blanco de ese espacio de trabajo y se abre una vez confirmado que es la sesión actual.
- **Pestaña Files**: el selector de raíz de la cabecera permite cambiar entre la raíz principal y las raíces adicionales; al seleccionar una raíz adicional, el árbol de directorios, la apertura de archivos, la apertura en la aplicación, los menús contextuales, la actualización automática y la búsqueda del espacio de trabajo funcionan sobre esa raíz, y al volver a la raíz principal se restaura la vista nativa.

### Lado del modelo

La topología de las raíces adicionales se inyecta en el prompt del sistema y se actualiza cuando cambian las autorizaciones, sin necesidad de una herramienta nueva. Los archivos `AGENTS.md` / `CLAUDE.md` de las propias raíces adicionales también llegan al contexto cuando corresponde: el del nivel superior de la raíz antes del primer paso de la sesión, y el de un subdirectorio después de que esta sesión haya trabajado correctamente en ese directorio.

Para instrucciones de uso más detalladas por función, consulte la [guía de usuario por función](./docs/guide/user/README.en.md).

## Estructura del proyecto

```text
.
├── src/
│   ├── roots.ts                      reglas puras: canonicalización, validación de conflictos, clasificación de registros (available/missing/redirected/invalid)
│   ├── registry.ts                   el registro de raíces: persistencia con dsh-storage-domain, único núcleo de almacenamiento y fachadas Host, ordenación store-wide de admisiones y cambios
│   ├── registry-lease.ts             Registry Authority entre procesos: flock de POSIX (el kernel lo libera cuando el proceso muere)
│   ├── registry-lease-win32.ts       ídem, la implementación con semáforo con nombre de Windows
│   ├── scope.ts                      ctx.multiRootScope: la única fuente de autorización, y además la instantánea de topología visible para el modelo
│   ├── fs.ts                         el proveedor de sistema de archivos multi-raíz (fence en proceso, extiende LocalFileSystem de upstream)
│   ├── sandbox.ts                    el proveedor de sandbox de kernel multi-raíz (extiende LocalSandboxProvider de upstream)
│   ├── dialects.ts                   reconocimiento de perfiles Seatbelt / bwrap / Landlock y ensamblado de grants adicionales (si no reconoce la forma, falla con un error explícito)
│   ├── windows-*.ts                  el runner de ACL root-set de Windows y la ejecución con token restringido
│   ├── containment.ts                contención de rutas (ruta rápida léxica más un respaldo por alias dev/ino)
│   ├── instructions.ts               descubrimiento, entrega incremental, presupuesto y revocación de los AGENTS.md / CLAUDE.md de una raíz adicional (nivel superior más los subdirectorios que esta sesión ha tocado, inyectados desde agent/pre-step)
│   ├── lsp.ts                        un espacio de trabajo LSP independiente inicializado por raíz adicional
│   ├── workspace-files.ts            enrutado y confinamiento en el host para la navegación de archivos de raíces adicionales en la pestaña Files
│   ├── compat.ts                     la puerta de arranque de multi-root-compat (allowlist de versiones y detección de instalaciones mixtas)
│   ├── compat/                       la capa de adaptación a diferencias entre versiones: dsh-version / sandbox-confine / agent-instructions / llm-message, etc. (peers opcionales cargados bajo demanda)
│   ├── command.ts                    el comando /workspace-folders y la mitad host del RPC del panel
│   ├── worktrees.ts                 la fila de sugerencias de Worktree: descubrimiento/activación/watchers, cola de prompts y esperas, confirmación y limpieza explícita
│   ├── worktrees/                   instantáneas controladas de metadatos de Git (config/HEAD/index/cadena de ancestros), inventario, sidecar y re-verificación del propietario (sin iniciar Git)
│   ├── worktrees-contract.ts         el contrato estricto de doble extremo de los endpoints de Worktree (unión discriminada, sin campo retry)
│   ├── contract.ts                   el protocolo de cable del panel (validación zod en ambos extremos, insertable en el bundle del navegador)
│   └── client/                       la mitad del navegador: acción de la barra lateral, diálogo Carpetas, conmutador de raíz de la pestaña Files, diccionarios para los ocho idiomas de DSH
├── tests/                            paridad diferencial, matriz de ejecución real de dialectos, ida y vuelta del contrato, puertas de componentes y de locale, e2e de lease entre procesos, inyección de instrucciones
├── scripts/                          pruebas de humo (compose / behavior / journey), comprobaciones de documentación y del runner del kernel, del contrato de compatibilidad y del flujo de actualización
└── docs/                             requisitos, arquitectura, registros de decisiones (ADR), planes y flujo de trabajo de desarrollo
```

## Contribución

Las Issues y los PR son bienvenidos:

1. Lea primero [`AGENTS.md`](./AGENTS.md) (reglas del repositorio) y el [flujo de trabajo de desarrollo](./docs/development/plugin-development-workflow.md) (entorno, comandos, matriz de compatibilidad de versiones en tiempo de ejecución y procedimiento de actualización).
2. Cree la rama a partir de `main`; los mensajes de commit siguen conventional commits (`feat` / `fix` / `perf` / `refactor` + scope); consulte el historial existente.
3. Antes de un PR, todo esto debe pasar en local: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (la CI ejecuta el mismo orden, build antes de test).
4. Los cambios que afectan al comportamiento actualizan en el mismo lote el documento correspondiente de `docs/`; las ocho ediciones del README de la raíz se mantienen sincronizadas (la versión china es la canónica); las decisiones de ingeniería con contrapartidas se registran como ADR.
5. Restricción estricta: **no se modifica ningún paquete del repositorio upstream (deepseek-harness)**; el plugin es solo una extensión out-of-tree.

Consulte la [guía de contribución](./CONTRIBUTING.md) para conocer las reglas completas.

## Limitaciones conocidas

### Funciones del plugin

- Los archivos de instrucciones de una raíz adicional llegan al modelo cuando corresponde: el del nivel superior de la raíz se inyecta antes del primer paso de la sesión, y el de un subdirectorio, después de que esta sesión haya trabajado **correctamente** en ese directorio; un archivo anidado solo se vuelve a examinar cuando se examina su directorio (el de la raíz en cada paso; el de un subdirectorio cuando ya se entregó o cuando hay un toque nuevo), el estado de entrega vive en la memoria del proceso (por lo que, tras reanudar, una sesión puede recibir el aviso otra vez); oficialmente se reconocen `read` / `write` / `edit`, y con el modo de compatibilidad OPS activado las herramientas de OPS también impulsan la entrega mediante evidencia live (tras reanudar, el historial de OPS sin evidencia live no participa en la entrega). La cadena de instrucciones de la raíz principal y la de user-global siguen siendo responsabilidad de upstream, y este plugin no las inyecta de nuevo ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Varios Hosts comparten un mismo servicio de registro: solo un Host gestiona el almacenamiento y cada instancia obtiene autorización operación por operación; una desconexión detiene las nuevas autorizaciones adicionales y, cuando el proceso que ostenta la autoridad termina, se toma el relevo mediante el bloqueo del kernel. Se limita a la misma máquina, el mismo usuario y el mismo espacio de nombres de bloqueo; en Linux la conexión compartida requiere SO_PEERPIDFD y en Windows se limita a la misma sesión de inicio. Los procesos y PTY antiguos conservan la instantánea del arranque ([arquitectura compartida](./docs/architecture/registry-authority-service.md)).
- La matriz de compatibilidad es una allowlist de versiones exactas: si la versión del host no está en la lista, o los paquetes principales mezclan versiones distintas, las seis filas `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` **no se inician** y la composición se degrada a «el plugin no está instalado» ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- El runner multi-raíz de Windows hereda la aplicación parcial de upstream, los directorios propiedad del llamador y la separación de temp privada; los procesos ya iniciados conservan el conjunto de raíces del arranque, y los procesos posteriores usan el conjunto actualizado ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Las rutas de red y de dispositivo no pueden ser raíces adicionales en Windows**: las rutas UNC (`\\server\share`), `\\?\`, `\\.\` y las unidades de red asignadas se rechazan en el registro con `unsupported-path`; el SID de capacidad del token restringido no puede vincularse al acceso SMB ([enmienda de ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **El shell restringido de Windows es pwsh, sin Git Bash**: MSYS no puede iniciarse bajo el token Low-integrity restringido en escritura (el runner de upstream y el del plugin se comportan igual, es una limitación de upstream); los subprocesos confinados del runner de upstream no reciben Ctrl+C porque heredan el indicador de ignorar Ctrl+C, mientras que con el runner del plugin los subprocesos sí lo reciben y el runner replica su código de salida.
- El nivel de acceso de una raíz adicional tiene tres estados: los nuevos registros usan `inherit` por defecto (siguen el modo de la sesión), `--read-only` deniega la escritura en cualquier modo (incluido Full-access; la única excepción es la elevación puntual aprobada por el usuario para una sola llamada, véase [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)), y un `--read-write` fijo sigue permitiendo escribir incluso en una sesión de solo lectura (es una cuestión de autorización de escritura, no de confinamiento de lectura; [ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). Los procesos ya iniciados y las terminales persistentes conservan el conjunto de denegaciones con el que arrancaron: una terminal iniciada antes de que una raíz pasara a solo lectura sigue sin restricciones hasta que se reinicie; los cambios de cap y de acceso solo afectan a las llamadas posteriores y a los procesos nuevos ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)); los hosts que ofrecen workingDirectory pueden usar una raíz adicional como directorio de ejecución de herramientas posteriores, sin que cambien el proyecto original de la Session ni la identidad del registro ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **En hosts Linux en los que upstream eligió Landlock, un Full-access restringido necesita bwrap**: la allowlist de Landlock no puede expresar «todo escribible excepto estas raíces», así que esa combinación elige bubblewrap para construir el límite de denegación; en un host sin un bwrap utilizable (no instalado o con los user namespaces no privilegiados deshabilitados), los comandos Full-access que llevan cualquier límite de denegación (una raíz de solo lectura o el `$DSH_HOME` protegido) fallan cerrados antes de arrancar. Habilite bwrap, o evite usar raíces de solo lectura explícitas bajo Full-access en ese host ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- El árbol de archivos de las raíces adicionales lo asume el **selector de raíz de la pestaña Files**: la entrada de la cabecera lista la raíz principal y todas las raíces adicionales, y junto a ella se sigue mostrando la ruta completa de la raíz seleccionada; al seleccionar una raíz adicional, una réplica byte a byte del árbol de Files de upstream toma el área del árbol (carga perezosa de directorios, filas e iconos nativos, actualización automática por watch, clic en un archivo para abrirlo en el viewer del host y actualización manual en el lugar de la cabecera), y el botón «Abrir en la aplicación» del lado derecho de la cabecera se sustituye a la vez por una réplica byte a byte del control de upstream, que abre la raíz seleccionada en lugar de la principal; al volver a la raíz principal se restaura la vista nativa, y el diálogo vuelve a ser solo de gestión. Las filas de las raíces adicionales ofrecen además el mismo menú contextual de fila que la raíz principal (filas de archivo y de directorio; el árbol de navegación Folder de la vista previa de archivos también se aplica), y la raíz seleccionada ofrece búsqueda en el espacio de trabajo (botón de búsqueda en la cabecera, barra de búsqueda, árbol de resultados con resaltado de coincidencias, capa de preferencias y filtrado de elementos ocultos); ambos aparecen solo cuando el host expone la estructura correspondiente: el menú contextual de fila requiere `useContextMenu` (desde `0.2.2-alpha.3`) y la búsqueda requiere `workspaceFiles.search` (desde `0.2.2-rc.2`), y en hosts anteriores no se enlaza el menú de fila ni se renderiza la entrada de búsqueda, con lo que la vista no cambia. Esta toma de control depende de los hooks DOM `data-*` de upstream, y cuando dejan de coincidir se degrada en silencio al aspecto nativo ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). El LSP inicializa un workspace independiente según la raíz que contiene el archivo adicional; el host debe configurar el servidor de lenguaje correspondiente ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)). Límites conocidos: el atajo nativo **Cmd+P** de Files sigue enfocando el campo de búsqueda nativo que la toma de control mantiene oculto, por lo que el atajo nativo no se considera una entrada de búsqueda de raíces adicionales: ni la superficie de búsqueda de la página Files ni la del árbol de navegación de la vista previa responden a él ([ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md), [ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)); el historial de búsqueda del árbol de navegación de la vista previa se guarda por `(pane, root)`, separado del `(tab, root)` de la página Files, así que una consulta hecha en la página Files del mismo pane no pasa a la vista previa; la fila actual de los resultados solo se marca y no se desplaza automáticamente; cerrar el Folder o cambiar de raíz en el mismo pane descarta los borradores de ajustes no guardados ([ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)).
- Cuando un plugin de terceros asume toda la pestaña Files (registrando el kind `files` con `priority: "extension"`), el selector de raíz y la navegación de raíces adicionales no están disponibles; el plugin muestra una única notificación transitoria oficial de nivel info, que puede volver a mostrarse cuando la toma de control termina, y la gestión de raíces sigue disponible desde «Carpetas del espacio de trabajo» de la barra lateral y desde `/workspace-folders` ([Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)).
- Los textos que emite el comando están en inglés (el lado host no dispone de información de idioma activo); los textos del panel siguen el idioma de la interfaz y están disponibles en los ocho idiomas que ofrece DSH.
- El panel Carpetas del espacio de trabajo es «acción al pie de la barra lateral + diálogo», no un panel independiente a pantalla completa: `sidebar.footer.action` es un slot que ofrecen todas las versiones compatibles, mientras que `sidebar.panellist`/`main` no lo son. Desde DSH `0.2.1-alpha.3` se monta además una entrada incremental en el slot `conversation.hero.options` de la página de nueva sesión: comparte la geometría de los selectores de espacio de trabajo y de modo adyacentes, no tiene chevron, se contrae según el margen disponible medido en la fila del hero, y con menos de 88 px se degrada a un botón de icono de 28×28 (el contenedor de options de upstream es `flex: none`, así que el plugin no modifica DSH: solo mide el margen y se limita a sí mismo; cuando la sonda no reconoce la estructura de la fila, recurre al valor de respaldo del viewport de 560 px); cuando ese slot falta en un runtime antiguo, el registro no se activa en silencio y la entrada de la barra lateral no se ve afectada ([ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)). El redondeo del rail (estado contraído) de la entrada de la barra lateral tiene su propio límite anterior, `0.1.6-alpha.2`: 23 versiones compatibles dibujan el mismo cuadrado redondeado de 12 px que el host, y las 2 versiones más antiguas (`0.1.5-rc.2`, `0.1.6-alpha.1`) dibujan el círculo del host frente al cuadrado redondeado de 12 px del plugin, una desviación de redondeo ya documentada (sin efecto en ink ni en el diseño); el envoltorio `@media (hover: hover)` solo existe en las 6 versiones con la nueva geometría, y el plugin mantiene el suyo sin envolver, por lo que en pantallas táctiles hay diferencias de respuesta al hover respecto a esas versiones ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)). La altura de la entrada de la barra lateral sigue al occupant de la misma fila de ajustes y depende del marcador estructural `data-signed-out` del launcher de cuenta (una dependencia de CSS `:has()`, no un contrato de slot): las 7 versiones hasta `0.1.7-rc.2` mantienen la altura de 42 px del disparador de ajustes; desde `0.2.0-rc.1`, 32 px sin sesión iniciada y 44 px con sesión iniciada, y el rail fijo en 36 px; si el marcador cambia de nombre o desaparece, se recurre a 42 px (sin dimensionar mal), y solo afecta a la altura ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)).

### Adaptación de OPS

La implementación actual se ofrece como **modo de compatibilidad OPS (experimental, desactivado por defecto y con posibles limitaciones)**: ajuste `multi-root-ops-compatibility.enabled` en `Settings → Plugins → Multi-root Workspace`; su valor por defecto es `false` y requiere una activación explícita. La función solo puede habilitarse en las versiones DSH `0.2.*` dentro de la matriz de compatibilidad exacta existente; en `0.1.*` permanece desactivada incluso con `enabled: true` configurado a mano, y no se ofrece la interfaz de Settings antigua ([decisión de alcance de versión](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06)). Al activarla desde la interfaz de ajustes, debe leer el diálogo de riesgo oficial, marcar que ha comprendido las limitaciones y confirmar de nuevo; hasta la confirmación permanece desactivada, y cancelar, cerrar el diálogo o pulsar Esc no guarda la activación.

- **Activado**: activa la protección de ejecución de OPS, la actividad en vivo y las mejoras de Review. Full-access (`danger-full-access`) protege las denegaciones explícitas de RO/cap con el confinamiento del kernel en las vías verificadas de macOS y Linux. En Windows, cuando hay denegaciones, las llamadas de ejecución de OPS se rechazan de forma conservadora antes de la preparación del Worker (incluidas las lecturas), y todavía no se admite la preparación protegida ni la escritura legítima en esa combinación. En WW/RO, en cuanto existe una raíz adicional no escribible o un límite de herramienta de solo lectura, toda la llamada de ejecución de OPS (incluidas las lecturas y page) se rechaza antes de la preparación y del cuerpo. Todos los modos rechazan las llamadas de ejecución de OPS cuando el Registry no tiene autoridad, salvo el descubrimiento y la publicación puros. También se rechazan los subprocesos sin un dominio de ejecución o sin un perfil válido de la admisión actual, para que la limpieza en segundo plano no eluda los límites; esto puede rechazar también procesos de terceros en segundo plano, pero no intercepta la terminal del propio usuario en el panel.
- **Desactivado**: OPS recupera el comportamiento anterior a esta adaptación y no ofrece estas protecciones: **las raíces adicionales explícitamente de solo lectura pueden ser escritas por OPS**. Las funciones multi-raíz normales, los límites de las herramientas nativas y el propio interruptor de Auto Review no se ven afectados. Las instrucciones ya entregadas no se borran de forma retroactiva, y las llamadas que ya entraron en el dominio de protección y los procesos ya iniciados conservan su instantánea; las llamadas nuevas que se inicien después de desactivarlo ya no activan esta adaptación.
- **Limitaciones experimentales**: solo se ofrece el índice de actividad live de la Phase A, sin puente de eventos persistente. Con la función activada, el historial de OPS sin evidencia live tras reanudar y los pendientes dinámicos (replace/batch/result/bash/unknown) hacen que Review falle técnicamente; los diagnósticos no incluidos en la allowlist, como `ops_status`, también se ven sujetos a esta regla conservadora.

Brechas conocidas concretas:

- **Elusión de la restricción de solo lectura de dsh-ops (F01, línea base histórica)**: en las versiones auditadas, bajo Full-access, la herramienta Native `ops_write_file` de OPS escribió realmente en una raíz adicional explícitamente de solo lectura, mientras que el control nativo de fs en la misma llamada fue rechazado. Con el modo de compatibilidad OPS activado, la adaptación limitada de esta ronda vuelve a verificar que la denegación explícita de RO/cap se aplica a OPS Native y al PTC real bajo Full-access (la re-verificación de la ejecución de denegaciones está en la [auditoría §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); las versiones, el alcance de las pruebas y la evidencia original están en la [auditoría de compatibilidad](./docs/reviews/dsh-ops-compatibility-audit.md).
- **Brechas de escrituras legítimas y de instrucciones de subdirectorios en dsh-ops (F04/F05, línea base histórica)**: sigue sin resolverse el problema de que OPS rechace en la pre-verificación, bajo WW, las raíces adicionales `inherit` y las de lectura y escritura fijas, y bajo RO, las raíces de lectura y escritura fijas; la brecha de descubrimiento de instrucciones de subdirectorios en las lecturas de OPS (F05) se ha re-verificado como recuperada con el índice live de esta ronda y un AgentLoop real en el modo activado (las instrucciones de los subdirectorios tocados correctamente por Native y PTC entran en la siguiente petición al modelo; véase la [auditoría §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); no afecta a las rutas ya verificadas de instrucciones a nivel de raíz ni de Skills.
- **Degradación de batch/result de WW con bwrap en Linux (F07)**: con el Registry compartido de las versiones auditadas, todas las llamadas `ops_batch` / `ops_result` (incluido `page`) que llegan a la rama de arranque y obtienen una caché válida pierden la prueba de propiedad del argv al añadirse un bind después del confine, y la ruta del código fuente rechaza el arranque del Worker con `EXECUTOR_UNAVAILABLE`. El conflicto a nivel de función está reproducido; el extremo a extremo en Linux no se ha probado; las pruebas de control con RO normal, Landlock y sin caché quedan fuera de esta conclusión. Se necesita que OPS ofrezca una interfaz para declarar la caché antes del confine; por ahora no hay una mitigación unilateral en el MR validada; véase la [auditoría F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突).
- **Otros límites de disponibilidad de OPS**: con WW compartido, una purga fuera del despacho y sin una admisión válida se rechaza, por lo que las cachés de resultados pueden quedar residuales con un aviso; las llamadas PTC anidadas y el Bash en segundo plano también corren el riesgo de ser rechazadas por problemas de propiedad o de caducidad de las pruebas. En esta ronda se ha completado en las tres plataformas la validación de los límites de rechazo conservadores; las capacidades normales de segundo plano y de limpieza siguen sin recuperarse y se han aplazado indefinidamente; véase el [alcance final de ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05).

Las protecciones de respaldo de P5 en este repositorio no requieren cambios en OPS: las escrituras legítimas en raíces adicionales todavía pueden rechazarse, y las cachés de resultados en segundo plano pueden quedar residuales porque se rechaza su limpieza; además, en el modo legacy sin Registry compartido, el PTC de WW/RO también puede rechazarse antes de iniciar el proceso de código. La actividad persistente sigue desactivada: `appendPluginRecord` de DSH prohíbe explícitamente que los plugins externos la llamen, y no puede sustituirse por eventos normales ni por escrituras directas en el registro. P6 ha completado la aceptación técnica dentro del alcance delimitado; las capacidades restantes de P5 y la aceptación de compatibilidad completa de OPS quedan **aplazadas indefinidamente** y no forman parte de esta condición de finalización; si se retoman en el futuro, solo se ofrecerán como capacidad experimental. La lista de aplazamientos está en [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源), y el alcance de aceptación en el [plan completado](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md).

Estas protecciones experimentales conservadoras se publican con la `v0.1.15`; no declaran compatibilidad completa con OPS ni elevan la versión compatible. La re-verificación histórica de la auditoría §16 es anterior a la incorporación de este interruptor y corresponde a la ruta activada; las ejecuciones posteriores requieren `enabled: true` de forma explícita.

## Documentación

La documentación del proyecto a largo plazo está en [`docs/`](./docs/README.md):

- [Registro de cambios de versiones (CHANGELOG)](./CHANGELOG.en.md)
- [Guía de usuario](./docs/guide/README.en.md)
- [Requisitos](./docs/requirements/multi-root-workspace.md)
- [Arquitectura objetivo](./docs/architecture/multi-root-workspace.md)
- [Investigación de upstream](./docs/reference/multi-root-workspace-research.md)
- [Registros de decisiones (ADR)](./docs/decisions/README.md)
- [Planes](./docs/plans/README.md)
- [Flujo de trabajo de desarrollo](./docs/development/plugin-development-workflow.md)
- [Solución de problemas frecuentes](./docs/troubleshooting/README.md)

Las reglas de repositorio para Coding Agents se definen en [`AGENTS.md`](./AGENTS.md).

## Licencia

[MIT](./LICENSE)

Licencias de terceros: [THIRD_PARTY_LICENSE](./THIRD_PARTY_LICENSE)
