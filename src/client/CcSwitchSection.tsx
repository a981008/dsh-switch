/**
 * CC Switch settings section: real-time sync status (providers mirrored into
 * DSH) + a live usage line for every provider whose usage query is enabled in
 * cc-switch. Self-contained: fetches its own state.
 */
import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { fetchState, fetchUsage, syncNow, type StateResponse, type UsageResponse } from './api.ts'
import { hostOf, type TFn } from './format.ts'
import { useSyncRevision } from './refresh.ts'
import { en, type Dict } from './locales.ts'

const COLORS = {
  input: '#4a8fd9',
  cacheRead: '#8f8f96',
  cacheWrite: '#d99a3a',
  output: '#43a25a',
}

const APP_TYPE_COLORS: Record<string, string> = {
  claude: '#d99a3a',
  codex: '#4a8fd9',
  gemini: '#43a25a',
  openclaw: '#a06fd9',
}

const CARD: CSSProperties = {
  border: '1px solid rgba(128,128,128,0.25)',
  borderRadius: 10,
  padding: '10px 12px',
  margin: '8px 0',
}

const BADGE = (color: string): CSSProperties => ({
  display: 'inline-block',
  fontSize: 11,
  lineHeight: '16px',
  padding: '0 8px',
  borderRadius: 999,
  border: `1px solid ${color}`,
  color,
  marginLeft: 6,
  verticalAlign: 'middle',
})

const BUTTON: CSSProperties = {
  fontSize: 12,
  padding: '3px 12px',
  borderRadius: 6,
  border: '1px solid rgba(128,128,128,0.45)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

function fallbackT(): TFn {
  return (key, params) => {
    let text: string = (en as Dict)[key as keyof Dict] ?? key
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    }
    return text
  }
}

function interpolate(t: TFn, key: string, params?: Record<string, unknown>): string {
  return t(key, params)
}

const PLAN_WINDOW_ORDER = ['fiveHour', 'weekly', 'monthly', 'daily'] as const

const PLAN_WINDOW_LABEL_KEYS: Record<string, string> = {
  fiveHour: 'planWindow5h',
  weekly: 'planWindowWeekly',
  monthly: 'planWindowMonthly',
  daily: 'planWindowDaily',
}

function planWindowLabel(t: TFn, name: string): string {
  const key = PLAN_WINDOW_LABEL_KEYS[name]
  return key === undefined ? name : t(key)
}

/** Inline per-provider usage line: shown for every provider whose usage query is enabled in cc-switch. */
function ProviderUsageRow(props: { route: string; t: TFn }) {
  const { t, route } = props
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const response = await fetchUsage(route)
        if (!disposed) setUsage(response)
      } catch {
        // leave the previous state; retry on refresh
      }
    })()
    return () => {
      disposed = true
    }
  }, [route, tick])

  if (usage === null) return <div style={{ opacity: 0.45, fontSize: 12, marginTop: 2 }}>{t('usageLoading')}</div>
  if (usage.configured !== true || usage.result === undefined) return null
  const result = usage.result
  const refresh = (
    <button
      type="button"
      title={t('usageRefresh')}
      onClick={() => setTick((value) => value + 1)}
      style={{ border: 'none', background: 'transparent', cursor: 'pointer', opacity: 0.5, padding: '0 2px', fontSize: 11 }}
    >⟳</button>
  )
  let text: string
  let color = 'inherit'
  if (result.kind === 'error') {
    text = `${t('usageQueryFailed')}: ${result.error}`
    color = '#d96a4a'
  } else if (result.kind === 'plan') {
    text = Object.entries(result.windows)
      .map(([name, win]) => `${planWindowLabel(t, name)} ${win.percent.toFixed(1)}%`)
      .join(' · ')
  } else {
    const fmt = (value: number | undefined): string => (value === undefined ? '?' : value >= 100 ? value.toFixed(0) : value.toFixed(2))
    text = result.remaining !== undefined
      ? `${t('usageRemaining')} ${fmt(result.remaining)}${result.unit !== undefined ? ` ${result.unit}` : ''}${result.planName !== undefined ? ` · ${result.planName}` : ''}`
      : result.extra !== undefined
        ? result.extra
        : `${t('usageQueryFailed')}: empty`
  }
  return (
    <div style={{ fontSize: 12, marginTop: 2, color, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <span>📊 {text}</span>
      {refresh}
      <span style={{ opacity: 0.45 }}>
        {usage.checkedAt !== undefined ? `· ${t('usageCheckedAt')} ${new Date(usage.checkedAt).toLocaleTimeString()}` : null}
      </span>
    </div>
  )
}

export function CcSwitchSection(props: { t?: TFn }) {
  const t = props.t ?? fallbackT()
  // Bumped by the host's model-input events: a cc-switch sync re-reads here at
  // once instead of waiting for the section to be reopened.
  const syncRevision = useSyncRevision()
  const [state, setState] = useState<{ status: 'loading' | 'ready'; data?: StateResponse; error?: string }>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const loadState = useCallback(async () => {
    try {
      const data = await fetchState()
      setState({ status: 'ready', data })
    } catch (cause) {
      setState({ status: 'ready', error: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [])

  useEffect(() => {
    void loadState()
  }, [loadState, syncRevision])

  const onSync = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await syncNow()
      setMessage({
        kind: 'ok',
        text: interpolate(t, 'syncDone', {
          applied: result.applied.length,
          removed: result.removed.length,
          default: result.defaultChanged ? t('syncDefaultFollowed') : t('syncDefaultUntouched'),
        }),
      })
      await loadState()
    } catch (cause) {
      setMessage({ kind: 'err', text: interpolate(t, 'syncFailed', { message: cause instanceof Error ? cause.message : String(cause) }) })
    } finally {
      setBusy(false)
    }
  }

  const data = state.data
  const cc = data?.ccSwitch
  const sync = data?.sync
  const providers = cc?.providers ?? []
  const defaultModel = data?.dsh.defaultModel

  return (
    <div style={{ fontSize: 13, maxWidth: 860 }}>
      {cc !== undefined && !cc.available ? (
        <p style={{ opacity: 0.8 }}>
          {cc.error !== undefined && cc.error !== ''
            ? interpolate(t, 'unavailable', { message: cc.error })
            : t('notAvailable')}
        </p>
      ) : null}

      {message !== null ? (
        <p style={{ color: message.kind === 'ok' ? COLORS.output : '#d96a4a', whiteSpace: 'pre-wrap' }}>{message.text}</p>
      ) : null}

      {cc?.available ? (
        <>
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong>{t('syncTitle')}</strong>
              <span style={{ opacity: 0.6, fontSize: 12 }}>{data?.dbPath}</span>
              <span style={{ flex: 1 }} />
              <button style={BUTTON} onClick={() => void onSync()} disabled={busy}>
                {busy ? t('syncing') : t('syncNow')}
              </button>
            </div>
            <p style={{ opacity: 0.6, fontSize: 12, margin: '6px 0' }}>
              {sync?.lastError !== null && sync?.lastError !== undefined && sync.lastError !== ''
                ? <span style={{ color: '#d96a4a' }}>{interpolate(t, 'syncLastError', { message: sync.lastError })}</span>
                : sync?.lastSyncAt !== null && sync?.lastSyncAt !== undefined
                  ? interpolate(t, 'syncStatus', { time: new Date(sync.lastSyncAt).toLocaleString() })
                  : t('syncPending')}
            </p>
            {providers.length === 0 ? <p style={{ opacity: 0.7 }}>{t('noProviders')}</p> : null}
            {providers.map((provider) => (
              <div key={`${provider.appType}:${provider.id}`} style={{ borderTop: '1px solid rgba(128,128,128,0.14)', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={BADGE(APP_TYPE_COLORS[provider.appType] ?? 'rgba(128,128,128,0.5)')}>{t(`appType_${provider.appType}`)}</span>
                  <strong>{provider.name}</strong>
                  {provider.isCurrent ? <span style={BADGE(COLORS.input)}>{t('current')}</span> : null}
                  {provider.routable === true ? <span style={BADGE(COLORS.output)}>{t('liveInDsh')}</span> : null}
                  {provider.routable === false ? <span style={BADGE(COLORS.cacheWrite)} title={t('liveInDshPendingHint')}>{t('liveInDshPending')}</span> : null}
                  <span style={{ flex: 1 }} />
                  {provider.status === 'synced' ? (
                    <span style={{ opacity: 0.6, fontSize: 12 }}>{provider.route}</span>
                  ) : (
                    <span style={{ opacity: 0.55, fontSize: 12 }} title={provider.reason}>⚠ {provider.reason}</span>
                  )}
                </div>
                <div style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}>
                  {provider.baseUrl !== null ? `${t('baseUrl')}: ${hostOf(provider.baseUrl)}` : null}
                  {provider.hasKey ? ` · ${t('tokenTail')} …${provider.tokenTail ?? ''}` : null}
                  {provider.envName !== null ? ` · ${provider.envName}` : null}
                </div>
                {provider.models.length > 0 ? (
                  <div style={{ opacity: 0.7, fontSize: 12, marginTop: 2 }}>
                    {t('models')}: {provider.models.join(', ')}
                    {provider.routable === true && provider.liveModels !== undefined ? ` · ${interpolate(t, 'liveModelsInDsh', { count: provider.liveModels })}` : null}
                  </div>
                ) : null}
                {provider.usageConfigured ? <ProviderUsageRow route={provider.route} t={t} /> : null}
              </div>
            ))}
            {defaultModel !== undefined && defaultModel !== null ? (
              <p style={{ opacity: 0.6, fontSize: 12, margin: '6px 0 0' }}>
                {interpolate(t, 'dshDefault', { provider: defaultModel.provider, model: defaultModel.model })}
              </p>
            ) : null}
          </div>

        </>
      ) : null}
    </div>
  )
}
