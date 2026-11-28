import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SshDependencyView } from '../remote/ssh-diagnostics.ts'
import type { Translate } from './WorkspaceFoldersAction.tsx'
import { errorKeyOf, type PanelError } from './panel-client.ts'
import { PanelErrorToast } from './error-toast.tsx'
import { SshButton as Button } from './panel-buttons.tsx'
import { sshInstallLauncher, type SshInstallPhase } from './ssh-install-launcher.ts'
import { IconCheck, IconCopy } from '../compat/client-icons.ts'

interface DependencyNoticeProps {
  readonly view: SshDependencyView
  readonly onCheck: () => void | Promise<void>
  /** Host RPC implementation of the fixed install/upgrade operation. */
  readonly onInstall?: (() => Promise<DependencyInstallResult>) | undefined
  readonly checking?: boolean
  /** Inline management surfaces auto-open the dedicated prompt; an explicit repair dialog does not nest another one. */
  readonly autoPrompt?: boolean
  /** Inline management row or the body of an explicit repair dialog. */
  readonly surface?: 'inline' | 'dialog'
  /** Explicit dialogs route Later/Close to their owner; inline surfaces use flow-local dismissal. */
  readonly onDismiss?: (() => void) | undefined
  readonly t: Translate
}

type Operation = 'install' | 'restart' | undefined

type DependencyInstallResult = {
  readonly status: 'ready' | 'restart-required'
  readonly dependencies?: SshDependencyView
}

const repairable = new Set(['ssh-deps-missing', 'ssh-deps-partial', 'ssh-deps-version'])
const dismissStorageKey = 'dsh.multi-root-workspace.ssh-upgrade-dismissed.v1'
const dismissedMemory = new Set<string>()

function fingerprintOf(view: SshDependencyView): string {
  return JSON.stringify([
    view.profile ?? '', view.release ?? '',
    view.packages.map(pkg => [pkg.name, pkg.state, pkg.version ?? '']),
  ])
}

function readDismissed(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(dismissStorageKey)
    if (raw === null) return dismissedMemory
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return dismissedMemory
  }
}

function rememberDismissed(key: string): void {
  dismissedMemory.add(key)
  try {
    const next = [...new Set([...readDismissed(), key])].slice(-64)
    window.localStorage.setItem(dismissStorageKey, JSON.stringify(next))
  } catch {
    // Storage may be denied in embedded or privacy contexts; the in-memory set
    // still guarantees same-page-session de-duplication.
  }
}

/**
 * The shared client-side SSH dependency flow controller. It owns capability
 * detection, one-at-a-time execution, upgrade-prompt dismissal memory, restart
 * guidance, and the copy-command fallback so every entry point renders the
 * same state machine.
 */
export function useSshDependencyFlow(view: SshDependencyView, options: {
  readonly onCheck: () => void | Promise<void>
  readonly onInstall?: (() => Promise<DependencyInstallResult>) | undefined
  readonly autoPrompt?: boolean
}) {
  const autoPrompt = options.autoPrompt !== false
  const launcher = useMemo(() => sshInstallLauncher(), [])
  const [operation, setOperation] = useState<Operation>()
  const [operationError, setOperationError] = useState<string>()
  const [launcherPhase, setLauncherPhase] = useState<SshInstallPhase>()
  const [restartRequested, setRestartRequested] = useState(false)
  const [operationTarget, setOperationTarget] = useState<{ readonly baseKey: string; readonly view: SshDependencyView }>()
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [restartOpen, setRestartOpen] = useState(false)
  const [closedRestartKey, setClosedRestartKey] = useState<string>()
  const baseKey = fingerprintOf(view)
  const effectiveView = operationTarget?.baseKey === baseKey ? operationTarget.view : view
  const key = fingerprintOf(effectiveView)

  const hostInstall = effectiveView.capabilities?.install === true && options.onInstall !== undefined
  const launcherInstall = launcher?.capabilities.install === true && launcher.install !== undefined
  const installAvailable = hostInstall || launcherInstall
  const restartAvailable = launcher?.capabilities.restart === true && launcher.restart !== undefined
  const actionable = repairable.has(effectiveView.code) && effectiveView.profile !== undefined && effectiveView.release !== undefined
  const restartRequired = restartRequested || effectiveView.code === 'ssh-deps-restart'

  useEffect(() => {
    if (launcher === undefined) return undefined
    return launcher.subscribe(phase => { setLauncherPhase(phase) })
  }, [launcher])

  useEffect(() => {
    if (autoPrompt && effectiveView.code === 'ssh-deps-version' && !readDismissed().has(key) && !restartRequested) setUpgradeOpen(true)
  }, [autoPrompt, key, restartRequested, effectiveView.code])

  useEffect(() => {
    if (restartRequested) setRestartOpen(true)
  }, [restartRequested])

  useEffect(() => {
    if (autoPrompt && effectiveView.code === 'ssh-deps-restart' && closedRestartKey !== key) setRestartOpen(true)
    if (effectiveView.code === 'ready') {
      setRestartRequested(false)
      setRestartOpen(false)
      setUpgradeOpen(false)
    }
  }, [autoPrompt, closedRestartKey, key, effectiveView.code])

  const dismissUpgrade = useCallback(() => {
    rememberDismissed(key)
    setUpgradeOpen(false)
  }, [key])

  const closeRestart = useCallback(() => {
    setClosedRestartKey(key)
    setRestartOpen(false)
  }, [key])

  const installOrUpgrade = useCallback(async (): Promise<void> => {
    if (!actionable || operation !== undefined || !installAvailable) return
    setOperation('install')
    setOperationError(undefined)
    try {
      const target = { profile: effectiveView.profile!, release: effectiveView.release! }
      const result = hostInstall
        ? await options.onInstall!()
        : await launcher!.install!(target)
      const dependencies = 'dependencies' in result && result.dependencies !== undefined
        ? result.dependencies
        : { ...effectiveView, code: result.status === 'ready' ? 'ready' as const : 'ssh-deps-restart' as const }
      setOperationTarget({ baseKey, view: dependencies })
      if (result.status === 'ready') {
        setUpgradeOpen(false)
        await options.onCheck()
      } else {
        setUpgradeOpen(false)
        setRestartRequested(true)
        setRestartOpen(true)
      }
    } catch (cause: unknown) {
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOperation(undefined)
    }
  }, [actionable, baseKey, effectiveView, hostInstall, installAvailable, launcher, operation, options])

  const restartHost = useCallback(async (): Promise<void> => {
    if (!restartAvailable || operation !== undefined || effectiveView.profile === undefined || effectiveView.release === undefined) return
    setOperation('restart')
    setOperationError(undefined)
    try {
      await launcher!.restart!({ profile: effectiveView.profile, release: effectiveView.release })
      await options.onCheck()
    } catch (cause: unknown) {
      setOperationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOperation(undefined)
    }
  }, [effectiveView, launcher, operation, options, restartAvailable])

  return {
    view: effectiveView,
    actionable, installAvailable, restartAvailable, restartRequired,
    busy: operation !== undefined, installing: operation === 'install', restarting: operation === 'restart',
    operationError, upgradeOpen, restartOpen, launcherPhase,
    setUpgradeOpen, dismissUpgrade, closeRestart, installOrUpgrade, restartHost,
    openRestart: () => { setRestartOpen(true) },
  }
}

function Packages({ view, t }: { readonly view: SshDependencyView; readonly t: Translate }): ReactNode {
  if (view.code.startsWith('ssh-host-')) return null
  return <ul className="mrfw-sshDependencyPackages">
    {view.packages.map(pkg => <li key={pkg.name}>
      <code>{pkg.name}</code> · {t(`ssh.dependency.${pkg.state}`)}{pkg.version === undefined ? '' : ` (${pkg.version})`}
    </li>)}
  </ul>
}

function ProfileLine({ view, t }: { readonly view: SshDependencyView; readonly t: Translate }): ReactNode {
  return view.profile === undefined || view.release === undefined ? null
    : <p className="mrfw-note">{t('ssh.dependenciesProfile', { profile: view.profile, version: view.release })}</p>
}

function CopyCommand({ command, primary, label = 'ssh.copyInstallCommand', t }: { readonly command: string; readonly primary: boolean; readonly label?: 'ssh.copyInstallCommand' | 'ssh.copyUpgradeCommand'; readonly t: Translate }): ReactNode {
  const [copy, setCopy] = useState<boolean>()
  const reset = useRef<number>()
  useEffect(() => () => { window.clearTimeout(reset.current) }, [])
  const copied = copy === true
  return <div className="mrfw-sshCommandCard" data-state={copy === false ? 'error' : copied ? 'copied' : undefined}>
    <div className="mrfw-sshCommandScroll">
      <code>{command}</code>
    </div>
    <div className="mrfw-sshCommandFooter">
      {copy === false ? <p className="mrfw-sshCommandError" role="alert">{t('error.copy-failed')}</p> : null}
      <Button variant={copied ? 'outline' : primary ? 'primary' : 'outline'} size="sm" className="mrfw-sshCopyButton" data-copied={copied || undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command)
            window.clearTimeout(reset.current)
            setCopy(true)
            reset.current = window.setTimeout(() => { setCopy(undefined) }, 1500)
          } catch {
            window.clearTimeout(reset.current)
            setCopy(false)
          }
        }}>
        <span className="mrfw-sshCopyGlyph" aria-hidden="true">
          {copied
            ? IconCheck === undefined ? '✓' : <IconCheck size={14} />
            : <IconCopy size={14} />}
        </span>
        <span>{copied ? t('ssh.copied') : t(label)}</span>
      </Button>
    </div>
  </div>
}


type Flow = ReturnType<typeof useSshDependencyFlow>

function operationPhase(flow: Flow): 'installing' | 'restarting' | undefined {
  return flow.installing ? 'installing' : flow.restarting ? 'restarting' : undefined
}

function Progress({ flow, t }: { readonly flow: Flow; readonly t: Translate }): ReactNode {
  const phase = flow.launcherPhase ?? operationPhase(flow)
  return phase === undefined ? null : <p className="mrfw-note" role="status">{t(`ssh.installPhase.${phase}`)}</p>
}

function UpgradeContent({ flow, view, command, status, onLater, t }: {
  readonly flow: Flow
  readonly view: SshDependencyView
  readonly command: string | undefined
  readonly status: string | undefined
  readonly onLater?: (() => void) | undefined
  readonly t: Translate
}): ReactNode {
  return <div className="mrfw-wizStack">
    <p className="mrfw-sshDependencySummary">{t('ssh.upgradeSummary')}</p>
    <ProfileLine view={view} t={t} />
    <Packages view={view} t={t} />
    <p className="mrfw-note">{t('ssh.upgradeTarget')}</p>
    <p className="mrfw-note">{t('ssh.upgradeScope')}</p>
    <p className="mrfw-note">{t('ssh.upgradeCaution')}</p>
    <p className="mrfw-note">{t('ssh.upgradeRestartNeeded')}</p>
    {command === undefined || flow.installAvailable ? null : <CopyCommand command={command} primary t={t} label="ssh.copyUpgradeCommand" />}
    <div className="mrfw-sshDependencyActions">
      {flow.installAvailable ? <Button variant="primary" size="sm" disabled={flow.busy} loading={flow.installing}
        onClick={() => void flow.installOrUpgrade()}>{t('ssh.upgradeRuntime')}</Button>
        : null}
      <Button variant="outline" size="sm" disabled={flow.busy} onClick={() => { flow.dismissUpgrade(); onLater?.() }}>{t('ssh.later')}</Button>
    </div>
    <Progress flow={flow} t={t} />
    {status === undefined ? null : <p className="mrfw-note" role="alert">{status}</p>}
  </div>
}

function RestartContent({ flow, view, checking, onCheck, status, onLater, t }: {
  readonly flow: Flow
  readonly view: SshDependencyView
  readonly checking: boolean
  readonly onCheck: () => void | Promise<void>
  readonly status: string | undefined
  readonly onLater?: (() => void) | undefined
  readonly t: Translate
}): ReactNode {
  return <div className="mrfw-wizStack">
    <p className="mrfw-sshDependencySummary">{t(flow.restartAvailable ? 'ssh.restartSummary' : 'ssh.manualRestartSummary')}</p>
    <ProfileLine view={view} t={t} />
    <p className="mrfw-note">{t(flow.restartAvailable ? 'ssh.restartDescription' : 'ssh.manualRestartDescription')}</p>
    <div className="mrfw-sshDependencyActions">
      {flow.restartAvailable ? <Button variant="primary" size="sm" disabled={flow.busy} loading={flow.restarting}
        onClick={() => void flow.restartHost()}>{t('ssh.restartHost')}</Button> : null}
      <Button variant={flow.restartAvailable ? 'outline' : 'primary'} size="sm" disabled={checking || flow.busy} loading={checking}
        onClick={onCheck}>{t('ssh.recheckAfterRestart')}</Button>
      <Button variant="outline" size="sm" disabled={flow.busy} onClick={onLater ?? flow.closeRestart}>{t('ssh.later')}</Button>
    </div>
    <Progress flow={flow} t={t} />
    {status === undefined ? null : <p className="mrfw-note" role="alert">{status}</p>}
  </div>
}

export function SshDependencyNotice({ view, onCheck, onInstall, checking = false, autoPrompt = true, surface = 'inline', onDismiss, t }: DependencyNoticeProps): ReactNode {
  const flow = useSshDependencyFlow(view, { onCheck, onInstall, autoPrompt })
  const current = flow.view
  const command = current.command
  const actionLabel = current.code === 'ssh-deps-version' ? 'ssh.upgradeRuntime'
    : current.code === 'ssh-deps-partial' ? 'ssh.repairRuntime' : 'ssh.installRuntime'
  const status = flow.operationError === undefined ? undefined
    : t('ssh.installPhase.failed', { message: flow.operationError })
  if (surface === 'dialog' && flow.restartRequired) {
    return <RestartContent flow={flow} view={current} checking={checking} onCheck={onCheck} status={status} onLater={onDismiss} t={t} />
  }
  if (surface === 'dialog' && current.code === 'ssh-deps-version') {
    return <UpgradeContent flow={flow} view={current} command={command} status={status} onLater={onDismiss} t={t} />
  }
  return <div className="mrfw-wizStack">
    <p className="mrfw-sshDependencySummary" role="status">{t(errorKeyOf(current.code))}</p>
    <ProfileLine view={current} t={t} />
    <Packages view={current} t={t} />
    {command === undefined ? null : <p className="mrfw-note">{t(flow.installAvailable ? 'ssh.dependenciesInstallManual' : 'ssh.dependenciesInstall')}</p>}
    {command === undefined && current.code !== 'ssh-deps-restart'
      ? <p className="mrfw-note">{t(current.code.startsWith('ssh-host-') ? 'ssh.remedy.host' : 'ssh.dependenciesNoCommand')}</p> : null}
    {command === undefined ? null : <CopyCommand command={command} primary={!flow.installAvailable || !flow.actionable} t={t}
      label={current.code === 'ssh-deps-version' ? 'ssh.copyUpgradeCommand' : 'ssh.copyInstallCommand'} />}
    <div className="mrfw-sshDependencyActions">
      {flow.actionable && !flow.restartRequired && flow.installAvailable ? <Button variant="primary" size="sm" disabled={flow.busy} loading={flow.installing}
        onClick={() => {
          if (current.code === 'ssh-deps-version') flow.setUpgradeOpen(true)
          else void flow.installOrUpgrade()
        }}>{t(actionLabel)}</Button> : null}
      {current.code === 'ssh-deps-version' && !flow.restartRequired && !flow.installAvailable ? <Button variant="outline" size="sm"
        onClick={() => { flow.setUpgradeOpen(true) }}>{t(actionLabel)}</Button> : null}
      {flow.restartRequired ? <Button variant="primary" size="sm" onClick={flow.openRestart}>{t('ssh.restartGuidance')}</Button> : null}
      <Button variant="outline" size="sm" disabled={checking || flow.busy} loading={checking} onClick={onCheck}>{t('ssh.recheckDependencies')}</Button>
    </div>
    <Progress flow={flow} t={t} />
    {status === undefined ? null : <p className="mrfw-note" role="status">{status}</p>}

    <Modal open={surface !== 'dialog' && flow.upgradeOpen} title={t('ssh.upgradeTitle')} closeLabel={t('panel.close')}
      className="mrfw-sshDependencyDialog" onClose={flow.dismissUpgrade}>
      <UpgradeContent flow={flow} view={current} command={command} status={status} t={t} />
    </Modal>

    <Modal open={surface !== 'dialog' && flow.restartOpen} title={t('ssh.restartTitle')} closeLabel={t('panel.close')}
      className="mrfw-sshDependencyDialog" onClose={flow.closeRestart}>
      <RestartContent flow={flow} view={current} checking={checking} onCheck={onCheck} status={status} t={t} />
    </Modal>
  </div>
}

export function SshDependencyDialog({ onClose, error, ...notice }: DependencyNoticeProps & {
  readonly onClose: () => void
  readonly error: PanelError | undefined
}): ReactNode {
  const title = notice.view.code === 'ssh-deps-version' ? 'ssh.upgradeTitle'
    : notice.view.code === 'ssh-deps-restart' ? 'ssh.restartTitle' : 'ssh.dependenciesTitle'
  return <Modal open title={notice.t(title)} closeLabel={notice.t('panel.close')}
    className="mrfw-sshDependencyDialog" onClose={onClose}>
    <SshDependencyNotice {...notice} autoPrompt={false} surface="dialog" onDismiss={onClose} />
    <PanelErrorToast error={error} t={notice.t} />
  </Modal>
}
