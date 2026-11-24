<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

<img alt="GitHub License" src="https://img.shields.io/github/license/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="GitHub Release" src="https://img.shields.io/github/v/release/cherrchen/dsh-plugin-multi-root-workspace">
<img alt="NPM Version" src="https://img.shields.io/npm/v/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">
<img alt="NPM Downloads" src="https://img.shields.io/npm/d18m/%40dsh-electron%2Fdsh-plugin-multi-root-workspace">

[中文](./README.md) | [English](./README.en.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Русский](./README.ru.md) | Português

</div>

## Sobre o projeto

Por padrão, o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) usa o diretório em que um novo espaço de trabalho é criado como diretório principal do agente; no modo padrão de leitura e escrita do espaço de trabalho (`workspace-write`), o escopo de leitura e escrita do sandbox também cobre apenas esse diretório. Este plugin amplia o escopo do espaço de trabalho do DSH para "uma raiz principal + várias raízes adicionais".

Nem todo projeto é um monorepo. Um projeto de desenvolvimento costuma ser composto por vários repositórios Git independentes, e trabalhar entre eles exigia trocar de sessão repetidamente. Ferramentas semelhantes já permitem adicionar várias pastas a um mesmo espaço de trabalho; este plugin leva a mesma capacidade ao DSH: registre os outros repositórios como raízes adicionais e defina cada uma como somente leitura, leitura e escrita, ou seguindo as permissões atuais da sessão, e o agente passa a ler e escrever dentro dessa autorização.

- **Ferramentas nativas**: em espaços de trabalho locais, o agente continua usando as ferramentas nativas `read` / `write` / `edit` / `bash`; ele apenas ganha mais alguns diretórios para trabalhar.
- **Permissões que valem de fato**: cada raiz adicional pode ser somente leitura, leitura e escrita, ou seguir as permissões da sessão atual; a restrição é aplicada pelo sandbox do sistema, e não por um aviso no prompt ao modelo. As operações de arquivo e os comandos bash do agente seguem a mesma autorização; processos iniciados por outros plugins ficam fora dessa garantia.
- **Navegar pelas raízes adicionais na aba Files**: o cabeçalho da aba Files alterna entre a raiz principal e qualquer raiz adicional; a árvore de diretórios, a abertura de arquivos, a abertura em um aplicativo externo, os menus de contexto, a atualização automática e a busca funcionam como na raiz principal, e o navegador de diretórios da prévia de arquivos também leva à raiz que contém o arquivo. Em hosts mais antigos, algumas dessas ações de interface podem não estar disponíveis, e a raiz adicional continua sendo exibida como o host a mostra nativamente.
- **Skills nas raízes adicionais**: o plugin descobre automaticamente `.dsh/skills` e `.agents/skills` nas raízes adicionais, que podem ser invocadas como `/alias:skill-name`; cada raiz tem seu próprio interruptor, ativado por padrão.
- **Auto Review (experimental, desativado por padrão)**: depois de ativado manualmente no gerenciador de plugins, a revisão automática também enxerga a estrutura de diretórios, os níveis de acesso e os arquivos de instruções das raízes adicionais, incluindo essas raízes na revisão.
- **Sugestões de Worktree (experimental, desativado por padrão)**: quando a raiz principal é um Worktree do Git, o plugin sugere adicionar outros Worktrees do mesmo repositório como raízes adicionais; nada é registrado antes da sua confirmação, e nada é adicionado ou removido automaticamente.
- **Ambientes remotos SSH (experimental, desativado por padrão)** — Ative o SSH pessoal na página do plugin para usar `remote_copy` e `remote_bash` em diretórios remotos registrados. As conexões e os vínculos do workspace são gerenciados separadamente, e o Registry autoriza cada chamada.
- **Sem registro, sem diferença**: sem nenhuma raiz adicional, o comportamento é idêntico ao de um plugin não instalado; uma configuração inválida gera erro, em vez de degradar em silêncio.

A publicação mais recente é a beta `v0.1.24-beta.6`; a tag `latest` do npm continua apontando para a versão estável `v0.1.23`, então instale a beta indicando `@beta`. As mudanças visíveis ao usuário de cada versão estão no [CHANGELOG](./CHANGELOG.en.md); o progresso e o estado das versões estão no [balanço de progresso do roadmap](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账).

## Início rápido

O plugin está publicado no [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace). Para perfis de linha de comando (`web`, `headless` etc.), a instalação leva dois comandos:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # escolha o --profile conforme a forma como você inicia o DSH; os valores estão na documentação
```

**Usuários do DSH Desktop**: na página de plugins, informe `@dsh-electron/dsh-plugin-multi-root-workspace` para instalar; se aparecer um erro na inicialização, reinicie o DeepSeek Harness Desktop.

Outras formas de instalação (tarball, GitHub, código-fonte local) estão em [Instalação](#instalação).

Depois de instalar, adicione uma raiz adicional dentro de uma sessão:

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

## Requisitos

**Para usar o plugin**: uma versão do DSH da tabela abaixo (correspondência exata, não um intervalo). O `dsh plugin` cuida da instalação; não é preciso ter uma toolchain Node local.

| Linha do DSH | Versões compatíveis |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`, `0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`, `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5` |
| `0.2.3` | `0.2.3-alpha.2` |

Quando a versão do DSH não está na tabela, ou os pacotes `@deepseek-ai/dsh-*` estão em versões divergentes, o plugin não inicia — o comportamento é o de um plugin não instalado.

**Compilar a partir do código-fonte / contribuir**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (recomenda-se habilitar via corepack); o DSH fixado no desenvolvimento é `0.2.3-alpha.2` (Node ≥24.22.3).

**Plataformas**: macOS (Seatbelt), Linux (bwrap / Landlock), Windows (root-set ACL runner).

## Instalação

Há duas formas de instalar: pela linha de comando (CLI) ou pelo gerenciador de plugins da interface gráfica no Web / Desktop. Basta escolher uma delas.

### Instalar pela CLI

O `dsh plugin` aceita quatro origens de instalação, mostradas aqui com o perfil `web`; perfis de CLI como `headless` funcionam do mesmo jeito. **Usuários do DSH Desktop**: o perfil `desktop` é gerenciado pela CLI `dsh` incluída no DeepSeek Harness Desktop — os passos estão no fim desta seção.

| Origem | Comando | Observações |
| --- | --- | --- |
| Registro npm (recomendado) | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | Artefatos pré-compilados, prontos para uso |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | Compila automaticamente a partir do código-fonte na instalação; `allowBuilds` precisa conter a chave exata deste pacote — recomenda-se fixar a versão |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | Pacote offline pré-compilado, útil para redes internas ou ambientes offline |
| A partir do código-fonte | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm `link:` para um checkout local — ideal para desenvolvimento e depuração; não precisa de `allowBuilds` |

#### Instalar pelo npm (recomendado)

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

Atualmente, `latest` é a versão estável `v0.1.23`; para instalar a beta (neste lançamento, `v0.1.24-beta.6`), informe `@beta` explicitamente:

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace@beta
```

#### Instalar a partir de um tarball

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# ou baixe o tgz dos assets da GitHub Release, por exemplo:
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.24-beta.6/dsh-electron-dsh-plugin-multi-root-workspace-0.1.24-beta.6.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.24-beta.6.tgz
```

Também é um artefato pré-compilado, adequado para entrega em redes internas ou ambientes offline.

#### Instalar a partir do GitHub

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

A origem GitHub instala o código-fonte e compila automaticamente durante o `add`, sem compilação manual; o pnpm bloqueia o `prepare` do próprio pacote e imprime uma linha com a chave exata (incluindo origem e commit). Copie essa linha exatamente como está em `allowBuilds` e execute o `add` de novo:

```yaml
allowBuilds:
  # A chave e o valor vêm do exemplo "Add the package to allowBuilds" da mensagem do pnpm;
  # uma chave só com o nome do pacote, sem origem e commit, não vale para origens git.
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

Recomenda-se fixar a versão (por exemplo, `#v0.1.24-beta.6`), para que um push posterior não altere em silêncio o que realmente é executado:

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.24-beta.6
```

#### Instalar a partir do código-fonte local

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> Se o `dsh` não estiver no PATH (por exemplo, quando você executa o DSH a partir do código-fonte), troque `dsh` por `pnpm dsh` nos comandos.

<details>
<summary>Como executar</summary>

Verificações de desenvolvimento:

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

Instalar em um runtime do DSH e verificar a composição:

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

Saída esperada:

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

Ou seja, as linhas `fs-sandbox` e `sandbox` do upstream ficam desativadas e são assumidas pelos serviços de mesmo nome do plugin, e todas as linhas `multi-root-*` do próprio plugin são montadas. Após a inicialização, uma ação **Pastas** (com o ícone de árvore de workspace) aparece no rodapé da barra lateral; runtimes DSH `0.2.1-alpha.3` e mais recentes também exibem a mesma entrada na extremidade direita da linha do espaço de trabalho na página de nova sessão.

</details>

#### Instalar com a CLI incluída no DeepSeek Harness Desktop

O DeepSeek Harness Desktop permite instalar um comando `dsh` global pelo menu do aplicativo (**Gerenciar comando dsh…**); use esse comando para gerenciar o perfil `desktop`.

1. Encerre o Desktop por completo, incluindo o ícone da bandeja.
2. Instalação nova:
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24-beta.6
   ```
3. Já instalado, mas sem o registro do bundle: execute `remove` e depois `add` (repetir apenas o `add` não registra o bundle):
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.24-beta.6
   ```
4. Abra `$DSH_HOME/profiles/desktop/package.json` (normalmente `~/.dsh/profiles/desktop/package.json` quando `DSH_HOME` não está definido) e confirme que `dsh.profile.bundles` contém o pacote.
5. Abra o Desktop novamente (inicialização a frio).

Se o `add` terminar com código 0 mas o plugin não aparecer em `dsh.profile.bundles`, faça um `remove` + `add`. A causa do conflito de ativação a quente, o registro de reprodução e a investigação de quem escreve no profile estão na [solução de problemas](./docs/troubleshooting/desktop-install-missing-bundle.md).

### Instalar pelo gerenciador de plugins da GUI do Web / Desktop

No Web e no Desktop, a instalação é feita pela página **Plugins** da barra lateral: escolha **Adicionar plugin**, informe `@dsh-electron/dsh-plugin-multi-root-workspace` e instale. Depois, escolha **Ativar agora** — apenas instalar não ativa o plugin. Se a página de plugins não tiver a entrada **Adicionar plugin**, use a CLI acima.

Depois de instalar ou ativar, reinicie o aplicativo DeepSeek Harness: no Desktop, encerre por completo (incluindo o ícone da bandeja) e abra de novo; no Web, reinicie o processo `dsh web`. Ativar este plugin a quente em um aplicativo em execução pode apresentar erro de registro duplicado de `fs` / `sandbox`; após reiniciar, ele carrega normalmente.

## Uso

### Comando

```text
/workspace-folders [list]                                                   # lista a raiz principal e as raízes adicionais (com permissão e estado de cada uma)
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # sem caminho, abre o seletor de diretórios; novos registros usam inherit por padrão
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # atalho para /workspace-folders add
/workspace-folders access <order|path> inherit|read-only|read-write         # altera o nível de acesso (ampliar exige que a raiz esteja disponível no momento)
/workspace-folders skills <order|path> on|off                               # liga/desliga as Skills desta raiz sem alterar a permissão de escrita
/workspace-folders alias-id <order|path> <kebab-case>                        # edita o namespace estável da Skill
/workspace-folders alias <order|path> [alias]                               # sem alias, limpa o alias existente
/workspace-folders remove <order|path>                                      # o número é o índice que aparece na saída do list
/workspace-folders reveal <order|path>                                      # mostra no gerenciador de arquivos
/workspace-folders isolate-profiles [--apply]                               # inspeciona (com --apply, grava) o método de importação de dependências do profile
/workspace-folders help                                                     # mostra a ajuda do comando
```

- Os caminhos podem vir entre aspas, e `~` é expandido; caminhos duplicados, aninhados dentro de uma raiz existente, a própria raiz principal e caminhos protegidos como `$DSH_HOME` / o diretório de armazenamento do Registry são recusados.
- `remove` / `access` / `alias` / `reveal` aceitam um número ou um caminho; `add` sem caminho abre o seletor de diretórios (quando o host oferece um) e também pode receber apenas a opção de acesso.
- `list` mostra a permissão e o estado de cada raiz. Quando o diretório está temporariamente ausente (`missing`) ou foi substituído por um link para outro lugar (`redirected`), a raiz mantém o registro mas não recebe autorização; assim que o diretório volta, um `list` ou uma atualização de **Pastas do espaço de trabalho** restaura o acesso automaticamente.
- `isolate-profiles` serve como pré-verificação do Full-access restrito no Windows: por padrão, apenas inspeciona o `packageImportMethod` de cada profile em `$DSH_HOME`, e `--apply` grava a configuração `copy`; ele não remove `node_modules` nem altera dependências existentes.

### Níveis de acesso

| Nível de acesso | Sessão `workspace-write` | Sessão `read-only` | Sessão `danger-full-access` |
| --- | --- | --- | --- |
| `inherit` (padrão para novas raízes) | gravação permitida | gravação recusada | sem restrição |
| `read-only` | gravação recusada | gravação recusada | gravação recusada (inclusive em Full-access) |
| `read-write` | gravação permitida | gravação permitida | gravação permitida |

- Novos registros usam `inherit` por padrão; uma mudança de permissão restringe apenas as chamadas seguintes e os novos processos, enquanto processos já iniciados e terminais persistentes mantêm a permissão com que foram iniciados.
- Uma elevação pontual para `danger-full-access` aprovada pelo usuário em uma única chamada remove, nessa chamada, as recusas de raiz somente leitura e de teto por ferramenta; `$DSH_HOME` e a degradação por indisponibilidade do Registry continuam valendo.
- Cada raiz principal aceita no máximo 16 raízes adicionais (`maxAdditionalRoots` pode chegar a 64). O host pode limitar permanentemente uma ferramenta em todas as raízes adicionais com o `toolAccess` da linha `multi-root-scope` — por exemplo, `{ bash: 'read-only' }` impede o bash de escrever em qualquer raiz adicional (ele ainda pode escrever na raiz principal).

### Skills nas raízes adicionais

- As Skills são descobertas em `.dsh/skills` e `.agents/skills` de cada diretório adicional; nomes e descrições ficam disponíveis antes do primeiro passo do modelo, e o conteúdo é carregado sob demanda.
- A raiz principal usa `/skill-name`; as raízes adicionais usam `/alias-id:skill-name` (com preenchimento no menu Slash). O modelo as invoca pela ferramenta nativa `skill`, então IDs internos podem aparecer no log de ferramentas.
- Raízes `inherit` / `read-write` recém-registradas vêm com Skills ativadas; raízes `read-only` vêm desativadas. O diálogo permite ligar e desligar por raiz e editar o `aliasId` (alterar o Alias exibido não muda o `aliasId`). Ativar Skills em uma raiz somente leitura não concede permissão de escrita.
- Na página **Plugins** da barra lateral, abra a página de detalhes do Multi-root Workspace; a opção **Ativar Skills das raízes adicionais** do cartão de configurações controla todas as raízes adicionais e vem ativada por padrão. Ao desativá-la, novas descobertas e invocações param, mas a escolha de cada raiz é preservada. Skills da raiz principal, instruções, LSP, navegação de arquivos e permissões de sandbox não são afetados.

### Sugestões de raízes Worktree (experimental, desativado por padrão)

Quando a raiz principal é a raiz de um Worktree do Git, o plugin lista os outros Worktrees do mesmo repositório como candidatos em um único cartão de sugestão — inclusive Worktrees criadas antes por um terminal, IDE ou forge; se a sessão for ela mesma uma linked worktree em `workspace-write`, o checkout principal do repositório também aparece como candidato. A descoberta apenas lê metadados do Git, não inicia nenhum subprocesso do Git e **nunca adiciona ou remove raízes sozinha**; sessões `danger-full-access` não recebem o aviso. Na página **Plugins** da barra lateral, abra os detalhes do Multi-root Workspace e ative **Ativar sugestões de raízes Worktree** no cartão de configurações (desativado por padrão) para que o recurso passe a valer.

A sugestão é um cartão persistente: escolha **Ver** ou **Lembrar mais tarde** (até surgir um novo Worktree / em 7 dias / em 30 dias); o botão de fechar no canto superior direito dispensa apenas o aviso atual, que volta após reiniciar. Depois de fechado, reabra em **Sugestões de Worktree**, ao lado de "Tentar novamente" no diálogo **Pastas do espaço de trabalho**. O diálogo de confirmação lista caminho, branch e permissão de cada linha (padrão `inherit`, alterável para somente leitura ou leitura e escrita), com caixas de seleção quando há mais de um candidato; a linha do checkout principal ainda descreve seu escopo: a árvore de código do checkout principal, config/hooks/refs/objects compartilhados e os dados administrativos de todas as Worktrees, o que pode afetar outros checkouts do mesmo repositório. O registro é no nível do espaço de trabalho, então **outras sessões de leitura e escrita também recebem a permissão escolhida**; o diálogo valida cada linha outra vez na confirmação, e qualquer mudança nesse intervalo invalida aquela linha. O diálogo também oferece **Nunca avisar novamente**.

Quando uma Worktree é excluída ou movida, o diálogo mostra um selo, mas **nada é limpo automaticamente**; a limpeza só é oferecida quando o diretório é confirmado como ausente e a identidade do registro confere (em lote ou por linha), com confirmação em um diálogo sobreposto. Antes da limpeza, um novo diretório no mesmo caminho pode herdar a autorização antiga, e o diálogo de confirmação informa esse risco.

### Integração com o Auto Review (experimental, desativado por padrão)

Para ter contexto de revisão com várias raízes, ative a linha Auto Review, desativada por padrão, na lista de componentes da página de detalhes do Multi-root Workspace, na página **Plugins** da barra lateral; a opção **Auto Review multiraiz (experimental)** do mesmo cartão de configurações é equivalente e também vem desativada. Uma instalação comum não ativa nem seleciona o Auto Review; a integração só existe nas versões exatas do DSH que a oferecem.

### Ambientes remotos SSH (experimental, desativado por padrão)

A issue nº 32 disponibiliza apenas o SSH pessoal por enquanto. Ative **Ambientes remotos SSH** nas configurações do plugin e confirme o aviso de risco. O processo local do DSH guarda as credenciais SSH. Processos executados na mesma conta do sistema podem acessá-las. Gerencie as conexões em “SSH remoto → Gerenciar”, nas configurações, ou em “Gerenciar remotos SSH”, nas pastas do workspace.

**Modo pessoal.** Abra “Gerenciar remotos SSH” → “Adicionar conexão”. Informe o host e as credenciais, depois confirme a chave do host para salvar. Na segunda etapa, detecte o Node, instale o helper, marque “Permitir execução de comandos” e clique em “Concluir” para salvar. Volte a Pastas do espaço de trabalho e abra “Gerenciar vínculos de raízes remotas”. Escolha uma conexão, selecione um diretório e defina as permissões e registre-a pelo menu “…” na linha do diretório remoto. Uma conexão pode vincular vários diretórios.

As ferramentas exigem um ambiente de execução SSH compatível. O Registry autoriza cada chamada de acordo com os diretórios registrados no workspace atual. Desativar o SSH descarrega as ferramentas e encerra o plano de controle remoto. Consulte o [guia de ambientes remotos SSH](./docs/guide/user/ssh-remote-environments.en.md) (em inglês) para ver as etapas completas.

### Entradas na interface

- **Barra lateral e página de nova sessão**: a ação **Pastas do espaço de trabalho** no rodapé da barra lateral abre o diálogo **Pastas do espaço de trabalho**; a partir do DSH `0.2.1-alpha.3`, a mesma entrada aparece na extremidade direita da linha do espaço de trabalho na página de nova sessão (sem seta suspensa; em janelas estreitas, apenas o ícone). O diálogo permite adicionar e remover raízes, editar aliases e permissões, ligar e desligar Skills por raiz, copiar caminhos, mostrar no gerenciador de arquivos, além de **Tentar novamente** para atualizar a lista e a entrada **Sugestões de Worktree**.
- **Menu da linha do espaço de trabalho**: o menu `…` e o menu de contexto da linha do espaço de trabalho incluem **Gerenciar pastas do espaço de trabalho…**. Quando a sessão atual pertence a esse espaço de trabalho, o diálogo abre direto; caso contrário, ele primeiro abre ou reaproveita a página em branco desse espaço de trabalho e só abre depois que ela se torna a sessão atual.
- **Aba Files**: o seletor de raiz no cabeçalho alterna entre a raiz principal e qualquer raiz adicional; com uma raiz adicional selecionada, a árvore de diretórios, a abertura de arquivos, a abertura no aplicativo, os menus de contexto, a atualização automática e a busca no espaço de trabalho seguem essa raiz, e voltar à raiz principal restaura a visualização nativa.

### Lado do modelo

A topologia das raízes adicionais é injetada no prompt do sistema e atualizada quando as autorizações mudam; nenhuma ferramenta nova é necessária. Os `AGENTS.md` / `CLAUDE.md` das próprias raízes adicionais também chegam ao contexto conforme necessário: o da camada superior da raiz antes do primeiro passo da sessão, e o de um subdiretório depois que esta sessão trabalhou nele com sucesso.

Instruções mais completas, função por função, estão no [guia do usuário](./docs/guide/user/README.en.md).

## Estrutura do projeto

```text
.
├── src/
│   ├── roots.ts                      camada de regras puras: canonicalização, validação de conflitos, classificação do estado do registro (available/missing/redirected/invalid)
│   ├── registry.ts                   o registro de raízes: persistência via dsh-storage-domain, núcleo de armazenamento único e fachada de Host, ordenação de admissões e mudanças no escopo do store
│   ├── registry-lease.ts             Registry Authority entre processos: POSIX flock (o kernel libera quando o processo morre)
│   ├── registry-lease-win32.ts       o mesmo, na implementação Windows com named semaphore
│   ├── scope.ts                      ctx.multiRootScope: a única fonte de autorização, que também publica o snapshot de topologia visível ao modelo
│   ├── fs.ts                         o provider de sistema de arquivos multi-raiz (fence no processo, estende o LocalFileSystem do upstream)
│   ├── sandbox.ts                    o provider de sandbox de kernel multi-raiz (estende o LocalSandboxProvider do upstream)
│   ├── dialects.ts                   reconhecimento de profile Seatbelt / bwrap / Landlock e montagem dos grants adicionais (formas desconhecidas falham de forma explícita)
│   ├── windows-*.ts                  o runner Windows de ACL por conjunto de raízes e a execução com restricted token
│   ├── containment.ts                verificação de contenção de caminho (caminho léxico rápido mais fallback por alias dev/ino)
│   ├── instructions.ts               descoberta, entrega incremental, orçamento e revogação dos AGENTS.md / CLAUDE.md de raízes adicionais (camada superior mais os subdiretórios tocados por esta sessão, injetados a partir de agent/pre-step)
│   ├── lsp.ts                        um workspace LSP separado inicializado para cada raiz adicional
│   ├── workspace-files.ts            roteamento no host e confinamento da navegação de arquivos das raízes adicionais na aba Files
│   ├── compat.ts                     o gate de inicialização multi-root-compat (allowlist de versões e detecção de instalação mista)
│   ├── compat/                       a camada de adaptação entre versões: dsh-version / sandbox-confine / agent-instructions / llm-message etc. (peers opcionais carregados sob demanda)
│   ├── command.ts                    o comando /workspace-folders e a metade host do RPC do painel
│   ├── worktrees.ts                  a linha de sugestões de raízes Worktree: descoberta/ativação/watchers, fila de prompts e esperas, confirmação e limpeza explícita
│   ├── worktrees/                    snapshots controlados de metadados do Git (config/HEAD/index/cadeia de ancestrais), inventário, sidecar e reverificação do owner (sem iniciar o Git)
│   ├── worktrees-contract.ts         o contrato estrito nos dois lados dos endpoints de Worktree (união discriminada, sem campo retry)
│   ├── contract.ts                   o protocolo de fio do painel (validação zod nos dois lados, inlinável no bundle do navegador)
│   └── client/                       a metade do navegador: ação da barra lateral, diálogo Pastas, seletor de raiz da aba Files, dicionários nos oito idiomas do DSH
├── tests/                            paridade diferencial, matriz de execução real dos dialetos, ida e volta de contratos, gates de componente e de locale, e2e de lease entre processos, injeção de instruções
├── scripts/                          smoke (compose / behavior / journey), verificações de documentação e do runner de kernel, verificação do contrato de compatibilidade e o fluxo de atualização
└── docs/                             requisitos, arquitetura, registros de decisão (ADRs), planos e fluxo de desenvolvimento
```

## Contribuição

Issues e PRs são bem-vindos:

1. Leia primeiro o [`AGENTS.md`](./AGENTS.md) (regras do repositório) e o [fluxo de desenvolvimento](./docs/development/plugin-development-workflow.md) (ambiente, comandos, matriz de runtimes com suporte e processo de atualização).
2. Crie a branch a partir de `main`; as mensagens de commit seguem conventional commits (`feat` / `fix` / `perf` / `refactor` + escopo) — veja o histórico existente.
3. Antes do PR, todos estes comandos precisam passar localmente: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (a CI executa a mesma ordem, com build antes de test).
4. Mudanças de comportamento atualizam o documento correspondente em `docs/` na mesma alteração; as oito edições do README da raiz permanecem sincronizadas, e a chinesa é a versão canônica; decisões de engenharia com trade-offs viram um novo ADR.
5. Restrição rígida: **nunca modifique nenhum pacote do repositório upstream (deepseek-harness)**; o plugin permanece uma extensão out-of-tree.

Consulte o [guia de contribuição](./CONTRIBUTING.md) para as regras completas.

## Limitações conhecidas

### Funcionalidades do plugin

- Os arquivos de instruções de uma raiz adicional chegam ao modelo conforme se tornam relevantes: o da camada superior da raiz é injetado antes do primeiro passo da sessão, e o de um subdiretório depois que esta sessão trabalhou nele com **sucesso**; um arquivo aninhado só é reexaminado quando seu diretório é examinado (na raiz, a cada passo; em um subdiretório, por já ter sido entregue ou por um novo toque), o estado de entrega fica na memória do processo (então uma sessão retomada pode ser informada de novo), as ferramentas reconhecidas são `read` / `write` / `edit` e, com o modo de compatibilidade OPS ativado, as ferramentas OPS também movem a entrega por evidência live (histórico OPS sem evidência live não conta após uma retomada). A cadeia da raiz principal e o arquivo user-global continuam sendo responsabilidade do upstream, e este plugin não os injeta de novo ([ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)).
- Vários Hosts compartilham o mesmo serviço de registro: só um Host administra o armazenamento e cada instância obtém admissão a cada operação; uma desconexão interrompe novas autorizações de raízes adicionais e, quando a autoridade encerra, um sucessor assume pelo bloqueio do kernel. O compartilhamento vale para a mesma máquina, o mesmo usuário e o mesmo namespace de bloqueio; no Linux, a conexão compartilhada exige SO_PEERPIDFD, e no Windows fica limitada à mesma sessão de login. Processos e PTYs antigos mantêm o snapshot de inicialização ([arquitetura de compartilhamento](./docs/architecture/registry-authority-service.md)).
- A matriz de suporte é uma allowlist de versões exatas: quando a versão do host não está na lista, ou os pacotes centrais estão em versões divergentes, as seis linhas `fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` **não iniciam** e a composição degrada para "o plugin não está instalado" ([ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)).
- O runner multi-raiz do Windows herda a aplicação parcial do upstream, os requisitos de diretórios pertencentes ao chamador e as condições de separação de temp privado; processos já iniciados mantêm o conjunto de raízes inicial, e processos posteriores usam o conjunto atualizado ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **Caminhos de rede e de dispositivo não podem ser raízes adicionais no Windows**: UNC (`\\server\share`), `\\?\`, `\\.\` e unidades de rede mapeadas são recusados já no registro com `unsupported-path` — o SID de capacidade do restricted token não consegue vincular acesso SMB ([emenda do ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)).
- **O shell restrito do Windows é o pwsh, sem Git Bash**: o MSYS não inicia sob o restricted Low-integrity token (o comportamento é idêntico nos runners do upstream e do plugin — uma limitação do upstream); um processo filho confinado pelo runner do upstream não recebe Ctrl+C porque herda o sinalizador de ignorar Ctrl+C, enquanto no runner do plugin o processo filho recebe Ctrl+C e o runner reproduz seu código de saída.
- O nível de acesso das raízes adicionais tem três estados: novos registros usam `inherit` (seguem o modo da sessão), `--read-only` recusa escrita em qualquer modo (inclusive Full-access; a única exceção é uma elevação pontual aprovada pelo usuário para uma chamada específica, veja [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)), e um `--read-write` fixo continua gravável mesmo em uma sessão somente leitura — é uma questão de autorização de escrita, nunca de confinamento de leitura ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)). Processos já iniciados e terminais persistentes mantêm o conjunto de negações com que foram iniciados — um terminal aberto antes de uma raiz virar somente leitura permanece sem restrição até ser reiniciado; mudanças de cap e access restringem apenas chamadas posteriores e novos processos ([ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)); hosts que oferecem workingDirectory podem usar uma raiz adicional como diretório de execução das ferramentas seguintes, com a origem da sessão e a identidade do registro inalteradas ([ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)).
- **Em hosts Linux em que o upstream escolheu o Landlock, o Full-access restrito precisa de bwrap**: a allowlist do Landlock não expressa "tudo gravável, exceto estas raízes", então essa combinação passa a usar o bubblewrap para montar a fronteira de negação de escrita; quando o host não tem um bwrap utilizável (não instalado ou user namespaces não privilegiados desativados), um comando Full-access que carregue qualquer fronteira de negação (uma raiz somente leitura ou o `$DSH_HOME` protegido) falha fechado antes de iniciar. Ative o bwrap, ou evite raízes somente leitura explícitas sob Full-access nesses hosts ([ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)).
- A árvore de arquivos das raízes adicionais é servida pelo **seletor de raiz da aba Files**: a entrada no cabeçalho lista a raiz principal e todas as raízes adicionais, com o caminho completo da raiz selecionada ainda exibido ao lado; ao selecionar uma raiz adicional, uma cópia byte a byte da árvore Files do upstream assume a área da árvore (diretórios carregados sob demanda, linhas e ícones nativos, atualização automática por watch, clique em arquivo abrindo no viewer do host e atualização manual no lugar do cabeçalho), e o botão "abrir no aplicativo" do lado direito do cabeçalho também é substituído por uma cópia byte a byte do controle do upstream, abrindo a raiz selecionada em vez da principal; voltar à raiz principal restaura a visualização nativa, e o diálogo volta a ser apenas de gerenciamento. As linhas das raízes adicionais também recebem os mesmos menus de contexto de linha da raiz principal (linhas de arquivo e de diretório; a árvore de navegação Folder da prévia de arquivos também funciona), e a raiz selecionada ganha busca no espaço de trabalho (botão de busca no cabeçalho, barra de busca, árvore de resultados com destaque, popover de preferências e filtragem de itens ocultos); ambos só aparecem quando o host expõe a estrutura correspondente — menus de linha exigem `useContextMenu` (`0.2.2-alpha.3` e mais recentes), e a busca exige `workspaceFiles.search` (`0.2.2-rc.2` e mais recentes); em hosts mais antigos, nenhum menu de linha é vinculado e nenhuma entrada de busca é renderizada, e a visualização permanece igual. Essa tomada depende de ganchos `data-*` do DOM do upstream e degrada em silêncio para a aparência nativa quando eles deixam de casar ([ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md), [ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)). O LSP usa a raiz adicional que contém o arquivo como seu próprio workspace; o host precisa configurar o servidor de linguagem correspondente ([ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)). Limites conhecidos: o atalho nativo da aba Files, **Cmd+P**, ainda focaliza o campo de busca nativo que a tomada mantém oculto, então ele não é uma entrada de busca em raízes adicionais — nem a página Files nem a superfície de busca da árvore de navegação da prévia respondem a ele ([ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md), [ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)); o histórico de busca da árvore de navegação da prévia é gravado por `(pane, root)`, separado do `(tab, root)` da página Files, então uma consulta feita na página Files do mesmo pane não passa para a prévia; a linha atual do resultado é apenas marcada, sem rolagem automática; e fechar o Folder ou trocar de raiz no mesmo pane descarta rascunhos de configuração não salvos ([ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)).
- Quando um plugin de terceiros assume a aba Files inteira (registrando o kind `files` com `priority: "extension"`), o seletor de raiz e a navegação pelas raízes adicionais ficam indisponíveis; o plugin mostra uma vez um aviso transitório de nível info e pode avisar de novo depois que a tomada é desfeita, e o gerenciamento de raízes continua disponível em **Pastas do espaço de trabalho** na barra lateral e em `/workspace-folders` ([Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)).
- O texto de saída do comando é em inglês (o lado do host não tem informação de locale ativo); o texto do painel acompanha o idioma da interface e está disponível nos oito idiomas oferecidos pelo DSH.
- O painel Pastas do espaço de trabalho é uma ação no rodapé da barra lateral mais um diálogo, não um painel de tela cheia: `sidebar.footer.action` é oferecido por todas as versões compatíveis, enquanto `sidebar.panellist` / `main` não são. A partir do DSH `0.2.1-alpha.3`, uma entrada incremental também ocupa o slot `conversation.hero.options` da página de nova sessão: ela compartilha a geometria dos seletores adjacentes de espaço de trabalho e de modo, não tem chevron, encolhe conforme o espaço medido dentro da linha do espaço de trabalho e degrada para um botão de ícone de 28×28 quando restam menos de 88px (o contêiner options do upstream é `flex: none`, então o plugin não altera o DSH: ele mede o espaço restante e se limita; quando a sonda não reconhece a estrutura da linha, há um fallback para o viewport de 560px). Onde um runtime mais antigo não declara esse slot, o registro simplesmente não dispara e a entrada da barra lateral não é afetada ([ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)). O arredondamento do rail (estado recolhido) da entrada da barra lateral tem um limite anterior próprio, `0.1.6-alpha.2`: as 23 versões compatíveis desenham o mesmo quadrado arredondado de 12px do host, enquanto as 2 versões mais antigas (`0.1.5-rc.2`, `0.1.6-alpha.1`) desenham o círculo do host contra o quadrado arredondado de 12px do plugin — o desvio de arredondamento documentado, sem efeito de ink ou de layout. O invólucro `@media (hover: hover)` existe apenas nas 6 versões de geometria nova, e o plugin deliberadamente mantém o seu sem invólucro, então em telas sensíveis ao toque há diferença de feedback de hover em relação a essas versões ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)). A altura da entrada da barra lateral acompanha o occupant da linha de configurações da mesma coluna, por meio de uma dependência estrutural de CSS `:has()` no marcador `data-signed-out` do launcher de conta (não é um contrato de slot): as 7 versões mais antigas (até `0.1.7-rc.2`) mantêm a altura de 42px do gatilho de configurações, a partir de `0.2.0-rc.1` o botão fica com 32px desconectado / 44px conectado, o rail permanece com 36px, e um marcador renomeado ou ausente cai para 42px em vez de dimensionar errado; apenas a altura é afetada ([ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)).

### Adaptação OPS

A implementação está disponível como **modo de compatibilidade OPS (experimental, desativado por padrão, sujeito a limitações)**: defina `multi-root-ops-compatibility.enabled` em `Settings → Plugins → Multi-root Workspace`; o padrão é `false` e é preciso ativar explicitamente. O recurso só pode ser ativado em versões DSH `0.2.*` dentro da matriz de suporte exata existente; em `0.1.*`, mesmo com `enabled: true` configurado manualmente, ele permanece desativado, e a UI legada de Settings não é suportada ([decisão de escopo de versão](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06)). Ao ativar pela interface de configurações, é preciso ler o diálogo de risco oficial, marcar que as limitações foram compreendidas e confirmar de novo; até a confirmação ele permanece desativado, e cancelar, fechar o diálogo ou pressionar Esc não salva a ativação.

- **Ativado**: ativa a proteção de execução do OPS, a atividade em tempo real e os reforços do Review. O Full-access (`danger-full-access`) aplica as fronteiras de negação explícita RO/cap por confinamento do kernel nas faixas macOS/Linux verificadas. No Windows, chamadas de execução OPS com negação, incluindo leituras, são recusadas de forma conservadora antes da preparação do Worker; preparação protegida e escritas legítimas nessa combinação ainda não são suportadas. Em WW/RO, qualquer raiz adicional não gravável ou teto de escrita por ferramenta faz a chamada de execução OPS inteira (incluindo leituras/page) ser recusada antes da preparação e do corpo. Todos os modos recusam chamadas de execução OPS quando a autoridade do Registry está indisponível; descoberta/publicação pura continua disponível. Inicializações de subprocesso também exigem um domínio de execução protegido ou um profile comprovado pela admissão atual, impedindo que a limpeza em segundo plano contorne as fronteiras; isso pode recusar também processos de terceiros em segundo plano, mas não intercepta o terminal do próprio usuário no painel.
- **Desativado**: o OPS volta ao comportamento anterior a esta adaptação, sem essas proteções — **o OPS pode gravar em uma raiz adicional explicitamente somente leitura**. Funcionalidades multi-raiz normais, as fronteiras nativas das ferramentas e o interruptor do próprio Auto Review não são afetados. Instruções já entregues não são apagadas retroativamente; chamadas que já entraram em um domínio de execução protegido e processos já iniciados mantêm o snapshot original; chamadas iniciadas após a desativação não ativam mais esta adaptação.
- **Limitações experimentais**: apenas o índice de atividade live da Fase A está disponível; não há ponte de eventos durável. Com o modo ativado, histórico OPS sem evidência live após uma retomada e pendências dinâmicas (replace/batch/result/bash/unknown) fazem o Review falhar tecnicamente; diagnósticos fora da allowlist, como `ops_status`, também estão sujeitos a essa regra conservadora.

Lacunas conhecidas em detalhe:

- **Bypass da restrição somente leitura do dsh-ops (F01, linha de base histórica)**: nas versões auditadas sob Full-access, o `ops_write_file` do OPS Native gravou de fato em uma raiz adicional explicitamente somente leitura, enquanto o controle nativo de fs, na mesma rodada, foi recusado. Com o modo de compatibilidade OPS ativado, a adaptação limitada desta rodada reverificou que a negação explícita RO/cap vale para o OPS Native e para PTC real sob Full-access (a reverificação da execução da negação está na [auditoria §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); versões, escopo de testes e evidência original estão na [auditoria de compatibilidade](./docs/reviews/dsh-ops-compatibility-audit.md).
- **Lacunas de escritas legítimas e de instruções de subdiretório no dsh-ops (F04/F05, linha de base histórica)**: o problema de a pré-verificação do OPS recusar escritas em raízes adicionais inherit/leitura e escrita fixa em WW e em raízes de leitura e escrita fixa em RO permanece sem solução; a lacuna em que uma leitura do OPS não dispara a descoberta de instruções de subdiretório (F05) foi reverificada como recuperada no modo ativado desta rodada, com o índice live e um AgentLoop real (toques bem-sucedidos do Native e do PTC levam as instruções do subdiretório para a próxima requisição ao modelo — veja a [auditoria §16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)); os caminhos já verificados de instruções no nível da raiz e de Skills não são afetados.
- **Degradação de batch/result em WW no bwrap do Linux (F07)**: na composição com Registry compartilhado das versões auditadas, toda chamada `ops_batch` / `ops_result` (incluindo `page`) que chega ao ramo de inicialização com cache válido perde a prova de propriedade do argv quando o OPS adiciona um bind após o confinamento. O caminho do código-fonte recusa a inicialização do Worker com `EXECUTOR_UNAVAILABLE`. O conflito em nível de função foi reproduzido; a execução ponta a ponta no Linux não foi testada. Controles com RO comum, Landlock e sem cache ficam fora dessa conclusão. É preciso que o OPS ofereça uma interface para declarar requisitos de cache antes do confinamento; nenhuma mitigação unilateral no MR foi validada até agora — veja [auditoria F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突).
- **Outros limites de disponibilidade do OPS**: sob WW compartilhado, um purge fora do despacho é recusado sem admissão válida, então caches de resultado podem permanecer, com um aviso; chamadas PTC aninhadas e o Bash em segundo plano também correm risco de recusa por prova de propriedade ou expiração. As fronteiras de recusa conservadora foram validadas nas três plataformas nesta rodada; a execução normal em segundo plano e a limpeza continuam indisponíveis e foram adiadas por tempo indeterminado — veja o [escopo final do ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05).

As proteções do P5 neste repositório não alteram o OPS: escritas legítimas em raízes adicionais ainda podem ser recusadas por engano, e caches de resultado em segundo plano podem permanecer quando a limpeza é recusada; no modo legacy sem Registry compartilhado, o PTC em WW/RO também pode ser recusado antes de iniciar o processo de código. A atividade durável continua desativada: o `appendPluginRecord` do DSH proíbe explicitamente a chamada por plugins externos, e eventos comuns ou escrita direta em log não substituem isso. O P6 teve a aceitação técnica concluída neste escopo delimitado; as capacidades restantes do P5 e a aceitação da compatibilidade OPS completa estão **adiadas por tempo indeterminado** e não fazem parte desta aceitação, e qualquer retomada futura continuará sendo experimental. A lista canônica de adiamentos está no [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源), e o escopo da aceitação está no [plano concluído](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md).

Essas proteções experimentais foram publicadas em `v0.1.15`; elas não declaram compatibilidade OPS completa nem ampliam a matriz de suporte. A reverificação histórica da auditoria §16 é anterior a este interruptor e corresponde ao caminho ativado; novas execuções exigem `enabled: true` explícito.

## Documentação

A documentação de longo prazo do projeto fica em [`docs/`](./docs/README.md):

- [Registro de alterações (CHANGELOG)](./CHANGELOG.en.md)
- [Guia do usuário](./docs/guide/README.en.md)
- [Requisitos](./docs/requirements/multi-root-workspace.md)
- [Arquitetura alvo](./docs/architecture/multi-root-workspace.md)
- [Pesquisa do upstream](./docs/reference/multi-root-workspace-research.md)
- [Registros de decisão (ADRs)](./docs/decisions/README.md)
- [Planos](./docs/plans/README.md)
- [Fluxo de desenvolvimento](./docs/development/plugin-development-workflow.md)
- [Solução de problemas](./docs/troubleshooting/README.md)

As regras de repositório para Coding Agents estão definidas em [`AGENTS.md`](./AGENTS.md).

## Licença

[MIT](./LICENSE)

Licenças de terceiros: [THIRD_PARTY_LICENSE](./THIRD_PARTY_LICENSE)
