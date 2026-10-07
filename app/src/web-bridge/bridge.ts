/**
 * Browser implementation of the `window.hermesDesktop` preload bridge.
 *
 * The renderer was written against Electron's preload API, but it already has
 * a first-class "remote gateway" mode: with `connection.mode === 'remote'`
 * every filesystem/git surface routes through `api()` (REST) instead of the
 * native bridge, and the WebSocket client is plain browser `WebSocket`. This
 * shim therefore only needs real implementations for the HTTP/WS plumbing and
 * a handful of Web-API mappings; everything Electron-only is an inert stub.
 *
 * Auth modes, mirroring the gateway (`hermes_cli/web_server.py`):
 *  - Loopback/token gateway: it injects `window.__HERMES_SESSION_TOKEN__` into
 *    the served index.html. REST sends `X-Hermes-Session-Token`, WS uses
 *    `?token=`. A `?token=` URL param or localStorage token covers `vite dev`,
 *    where the page is served by Vite and the injection never happens.
 *  - Gated gateway (cookies): REST rides the browser cookie jar same-origin;
 *    WS tickets are minted per connect via POST /api/auth/ws-ticket (they are
 *    single-use with a 30s TTL, so `getGatewayWsUrl` re-mints every call and
 *    the connection advertises `authMode: 'oauth'`, which makes the renderer
 *    re-resolve the URL on every reconnect).
 */

import type { GatewayWsUrlResult } from '@hermes/shared'

import type {
  DesktopActiveProfile,
  DesktopBootProgress,
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionsRegistry,
  DesktopConnectionTestResult,
  DesktopOauthLoginResult,
  DesktopProfileRoute,
  DesktopRegistryConnection,
  DesktopRegistryConnectionInput,
  HermesApiRequest,
  HermesConnection
} from '@/global'

import type { HermesNotification } from '../../electron/notification-types'

import {
  activeUpstreamOrigin,
  addGateway,
  classifyGatewayReach,
  type GatewayConnection,
  getActiveGateway,
  getGateway,
  listGateways,
  normalizeBase,
  removeGateway,
  servingBase,
  setActiveGateway,
  syncDevGatewayCookie,
  updateGateway,
  upstreamOriginFor,
  withGatewayRoute
} from './gateways'

declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string
    __HERMES_BASE_PATH__?: string
    /** Dev only: gateway origins the developer whitelisted as reachable, folded
     *  through the dev proxy (HERMES_GATEWAY_URL + config.json +
     *  HERMES_GATEWAY_WHITELIST; see vite.config.ts). */
    __HERMES_GATEWAY_WHITELIST__?: string[]
    /** Set by web-bridge/install.ts; read by lib/web-platform isWebPlatform(). */
    __HERMES_WEB__?: boolean
  }
}

const TOKEN_STORAGE_KEY = 'hermes-web.session-token'

const noop = (): void => {}
const unsubscribed = (): (() => void) => noop

/**
 * The bridge always operates on the ACTIVE gateway (see `./gateways`). This is
 * the adapter shape the connection-config methods below speak; it is derived
 * from, and written back to, the active gateway entry.
 */
interface StoredConnection {
  mode: 'local' | 'remote'
  remoteAuthMode: 'oauth' | 'token'
  remoteToken: string
  remoteUrl: string
}

function loadStoredConnection(): StoredConnection {
  const gateway = getActiveGateway()

  return {
    mode: 'remote',
    remoteAuthMode: gateway.authMode,
    remoteToken: gateway.token ?? '',
    remoteUrl: gateway.url || servingBase()
  }
}

function persistConnection(input: DesktopConnectionConfigInput): StoredConnection {
  updateGateway(getActiveGateway().id, {
    ...(input.remoteAuthMode !== undefined ? { authMode: input.remoteAuthMode } : {}),
    // An omitted token means "leave the saved one unchanged".
    ...(input.remoteToken !== undefined ? { token: input.remoteToken } : {}),
    ...(input.remoteUrl !== undefined ? { url: input.remoteUrl.trim() } : {})
  })

  return loadStoredConnection()
}

function baseUrl(): string {
  return normalizeBase(getActiveGateway().url)
}

/**
 * Everything needed to talk to one saved gateway: its absolute base, the dev
 * proxy route (`__hgw` upstream origin, null in production / for the default)
 * and its auth token ('' = cookie / OAuth mode).
 */
interface GatewayTarget {
  gateway: GatewayConnection
  base: string
  origin: string | null
  token: string
}

function targetFor(gateway: GatewayConnection): GatewayTarget {
  const base = normalizeBase(gateway.url)

  return { gateway, base, origin: upstreamOriginFor(gateway.url), token: resolveToken(gateway, base) }
}

/**
 * Resolve a registry connection id to its gateway. Omitted / '' / 'local'
 * mean the active gateway. Unknown ids reject with Electron's exact message,
 * which upstream's store/gateway matches on to drop a stale route.
 */
function targetForId(connectionId?: null | string): GatewayTarget {
  if (!connectionId || connectionId === 'local') {
    return targetFor(getActiveGateway())
  }

  const gateway = getGateway(connectionId)

  if (!gateway) {
    throw new Error(`No connection with id "${connectionId}"`)
  }

  return targetFor(gateway)
}

/**
 * Token resolution for one gateway. The serving gateway's own credential comes
 * first: its HTML injection (loopback/token mode), a `?token=` URL param
 * (persisted then stripped so it never lingers in the address bar), or a
 * previously persisted param token. Otherwise the token saved on the gateway
 * itself. Empty string means cookie (gated/OAuth) mode.
 */
function resolveToken(gateway: GatewayConnection = getActiveGateway(), base = normalizeBase(gateway.url)): string {
  if (base === servingBase()) {
    const served = servingToken()

    if (served) {return served}
  }

  return gateway.authMode === 'token' ? (gateway.token ?? '') : ''
}

function servingToken(): string {
  if (window.__HERMES_SESSION_TOKEN__) {return window.__HERMES_SESSION_TOKEN__}

  try {
    const url = new URL(window.location.href)
    const param = url.searchParams.get('token')

    if (param) {
      localStorage.setItem(TOKEN_STORAGE_KEY, param)
      url.searchParams.delete('token')
      window.history.replaceState(null, '', url.toString())

      return param
    }

    const stored = localStorage.getItem(TOKEN_STORAGE_KEY)

    if (stored) {return stored}
  } catch {
    // no served token
  }

  return ''
}

function buildTokenWsUrl(target: GatewayTarget): string {
  return `${target.base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(target.token)}`
}

/**
 * A fresh WS URL for one gateway. Token gateways embed the token; cookie
 * gateways mint a single-use ticket per connect (30s TTL), which is why the
 * descriptor advertises `authMode: 'oauth'` and the renderer re-resolves the URL
 * on every reconnect. A 401/403 mint is a signed-out session: report it as
 * `needsOauthLogin` so boot offers sign-in instead of a generic failure.
 */
async function gatewayWsUrl(target: GatewayTarget): Promise<GatewayWsUrlResult> {
  if (target.token) {return withGatewayRoute(buildTokenWsUrl(target), target.origin)}

  const res = await fetch(withGatewayRoute(`${target.base}/api/auth/ws-ticket`, target.origin), {
    method: 'POST',
    credentials: 'same-origin'
  })

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `${res.status}: sign in to ${target.gateway.name}`, needsOauthLogin: true }
  }

  if (!res.ok) {
    throw new Error(`${res.status}: failed to mint websocket ticket`)
  }

  const body = (await res.json()) as { ticket?: string }

  if (!body.ticket) {throw new Error('ws-ticket response had no ticket')}

  const wsBase = target.base.replace(/^http/, 'ws')

  return withGatewayRoute(`${wsBase}/api/ws?ticket=${encodeURIComponent(body.ticket)}`, target.origin)
}

/**
 * True when a gateway currently has a usable session. Token gateways are
 * "connected" if a token is present; OAuth/cookie gateways are probed via the
 * public-ish /api/auth/me (200 = signed in, 401 = not). Best-effort: any
 * failure reports not-connected so the UI offers a sign-in path rather than
 * falsely claiming a live session. The token is the PROBED gateway's (an OAuth
 * login popup passes '' so another gateway's token can't end it early).
 */
async function probeAuthConnected(
  base: string = baseUrl(),
  origin: string | null = activeUpstreamOrigin(),
  token: string = resolveToken()
): Promise<boolean> {
  if (token) {
    return true
  }

  try {
    const res = await fetch(withGatewayRoute(`${base}/api/auth/me`, origin), {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(6_000)
    })

    return res.ok
  } catch {
    return false
  }
}

/**
 * True when `base` shares the app's origin. OAuth in the browser only works
 * same-origin: the gateway sets its session as an `HttpOnly; SameSite=Lax`
 * cookie with no credentialed CORS, so the browser refuses to send it back on a
 * cross-origin fetch/WS. Same-origin covers the zero-config default gateway and
 * any `/prefix` gateway (both resolve to the serving origin, which the Vite dev
 * proxy or the gateway's own static host routes through), plus production where
 * the gateway serves the app. An absolute cross-origin URL never can.
 */
function isSameOrigin(base: string): boolean {
  try {
    return new URL(base, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

/**
 * Browser equivalent of the desktop's `openOauthLoginWindow`: open the
 * gateway's `/login` in a child window and poll our own (same-origin) session
 * until it goes live, resolving `connected: true` then. The app window is never
 * navigated away - exactly the desktop behaviour. Resolves `connected: false`
 * if the popup is blocked, the user closes it before finishing, or the login
 * doesn't complete within the timeout.
 */
function openOauthLoginPopup(base: string, origin: string | null): Promise<DesktopOauthLoginResult> {
  return new Promise(resolve => {
    const popup = window.open(
      withGatewayRoute(`${base}/login`, origin),
      'hermes-oauth-login',
      'width=520,height=720'
    )

    if (!popup) {
      resolve({ ok: false, baseUrl: base, connected: false })

      return
    }

    // Sever the popup's back-reference to us so a later cross-origin page (the
    // IDP, or any redirect it makes) can't drive our window via window.opener
    // (reverse tabnabbing). We can't pass `noopener` to window.open because that
    // returns null and we need the handle to poll `.closed` / call `.close()`.
    // Safe to set here: the popup is still on our same-origin `/login`.
    try {
      popup.opener = null
    } catch {
      // Some browsers make opener read-only; the poll/close path still works.
    }

    let settled = false
    const startedAt = Date.now()
    const TIMEOUT_MS = 5 * 60_000

    const finish = (connected: boolean): void => {
      if (settled) {return}
      settled = true
      clearInterval(timer)

      try {
        if (!popup.closed) {popup.close()}
      } catch {
        // Closing a window we opened is always allowed, but guard anyway.
      }

      resolve({ ok: true, baseUrl: base, connected })
    }

    // The gateway lands on `/` (a valid authenticated page) after the callback
    // sets the cookies; we only care that the cookie jar is populated, which we
    // observe from the app window via /api/auth/me now that it's same-origin.
    const timer = setInterval(() => {
      void (async () => {
        if (settled) {return}

        if (await probeAuthConnected(base, origin, '')) {
          finish(true)

          return
        }

        if (popup.closed || Date.now() - startedAt > TIMEOUT_MS) {
          finish(false)
        }
      })()
    }, 600)
  })
}

const DEFAULT_API_TIMEOUT_MS = 30_000

async function apiFetch<T>(request: HermesApiRequest): Promise<T> {
  const { body, connectionId, method = 'GET', path, profile, timeoutMs, upload } = request
  const target = targetForId(connectionId)
  let url = target.base + path

  if (profile) {
    url += `${url.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`
  }

  const headers: Record<string, string> = {}
  let payload: BodyInit | undefined

  if (upload) {
    // Single-file multipart upload (FastAPI UploadFile); the browser sets the
    // multipart Content-Type with its boundary.
    const form = new FormData()
    form.append('file', new Blob([upload.bytes], { type: upload.contentType || 'application/octet-stream' }), upload.filename)
    payload = form
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  if (target.token) {headers['X-Hermes-Session-Token'] = target.token}

  const res = await fetch(withGatewayRoute(url, target.origin), {
    method,
    headers,
    body: payload,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_API_TIMEOUT_MS)
  })

  const text = await res.text()

  if (!res.ok) {
    // Do NOT navigate away on 401. The app shell must stay mounted so the user
    // can reach Settings -> Gateway (change the URL, switch gateways, sign in).
    // Boot surfaces the reauth state via the WS path (getGatewayWsUrl ->
    // GatewayReauthRequiredError) which drives the boot-failure sign-in branch.
    // Same error contract as the Electron IPC handler: reject with "NNN: msg".
    throw new Error(`${res.status}: ${text || res.statusText}`)
  }

  if (!text) {return null as T}
  const trimmed = text.trimStart()

  if (trimmed.startsWith('<')) {
    throw new Error(`Expected JSON from ${url} but got HTML`)
  }

  return JSON.parse(text) as T
}

function connection(target: GatewayTarget, profile?: string | null, registryScoped = false): HermesConnection {
  return {
    baseUrl: target.base,
    mode: 'remote',
    remoteKind: 'url',
    source: 'settings',
    // 'oauth' forces the renderer to re-resolve the WS URL through
    // getGatewayWsUrl on every reconnect, which cookie mode needs because
    // tickets are single-use.
    authMode: target.token ? 'token' : 'oauth',
    token: target.token,
    wsUrl: target.token ? withGatewayRoute(buildTokenWsUrl(target), target.origin) : '',
    logs: [],
    isFullscreen: false,
    nativeOverlayWidth: 0,
    windowButtonPosition: null,
    connectionId: target.gateway.id,
    registryScoped,
    // One gateway serves every profile; a profile is a request scope on it.
    ...(profile ? { profile, sharedRemote: true } : {})
  }
}

// --- v2 connection registry over the saved gateways ------------------------

type RegistryChange = { connectionId: string; reason: 'removed' | 'saved' | 'updated' }
const registryListeners = new Set<(change: RegistryChange) => void>()

function emitRegistryChange(change: RegistryChange): void {
  for (const listener of registryListeners) {
    listener(change)
  }
}

function toRegistryConnection(gateway: GatewayConnection): DesktopRegistryConnection {
  return {
    id: gateway.id,
    // Every browser-reachable source is a URL gateway; local spawn, SSH and
    // Hermes Cloud need the desktop app.
    kind: 'remote',
    label: gateway.name,
    url: gateway.url || servingBase(),
    authMode: gateway.authMode,
    tokenSet: Boolean(gateway.token),
    tokenPreview: gateway.token ? `...${gateway.token.slice(-4)}` : null
  }
}

const LAUNCH_MODE_STORAGE_KEY = 'hermes-web.launch-mode'

function registry(): DesktopConnectionsRegistry {
  const activeId = getActiveGateway().id

  return {
    version: 2,
    primary: activeId,
    // Display preference only: the browser always resumes on the gateway it
    // last used (primary and lastUsed are the same record here).
    launchMode: readStored<'last-used' | 'primary'>(LAUNCH_MODE_STORAGE_KEY) ?? 'primary',
    lastUsed: activeId,
    // Tokens live in this origin's browser storage; there is no OS keychain to
    // offer and no plaintext-on-disk opt-in to ask for.
    secureTokenStorage: true,
    connections: listGateways().map(toRegistryConnection)
  }
}

function saveRegistryConnection(input: DesktopRegistryConnectionInput): DesktopRegistryConnection {
  if (input.kind !== 'remote') {
    throw new Error('Only URL gateways can be added in the browser. Local, SSH and Hermes Cloud sources need the desktop app.')
  }

  const url = (input.url ?? '').trim()
  const block = classifyGatewayReach(url)

  if (block) {
    throw new Error(
      block === 'mixed-content'
        ? "This https page can't reach an http gateway."
        : 'A browser can only reach a gateway served from this site. Enter it as a /prefix path routed to that gateway by your reverse proxy, or whitelist it for the dev proxy.'
    )
  }

  // A URL equal to the serving origin is the zero-config default.
  const stored = normalizeBase(url) === servingBase() ? '' : url
  const authMode = input.authMode ?? 'oauth'

  if (input.id && getGateway(input.id)) {
    updateGateway(input.id, {
      name: input.label,
      url: stored,
      authMode,
      // An omitted token keeps the saved one.
      ...(input.token !== undefined ? { token: input.token } : {})
    })
    emitRegistryChange({ connectionId: input.id, reason: 'updated' })

    return toRegistryConnection(getGateway(input.id)!)
  }

  const id = addGateway({ name: input.label, url: stored, authMode, token: input.token })
  emitRegistryChange({ connectionId: id, reason: 'saved' })

  return toRegistryConnection(getGateway(id)!)
}

async function testGateway(target: GatewayTarget): Promise<DesktopConnectionTestResult> {
  try {
    const status = await fetchStatus(target.base, target.origin)

    return { baseUrl: target.base, ok: true, reachable: true, version: status?.version ?? null }
  } catch (error) {
    return {
      baseUrl: target.base,
      ok: false,
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    } as DesktopConnectionTestResult
  }
}

// --- Profile preference (per browser) --------------------------------------

const PROFILE_STORAGE_KEY = 'hermes-web.profile'
const DEFAULT_ROUTE_STORAGE_KEY = 'hermes-web.default-profile-route'
const defaultRouteListeners = new Set<(route: DesktopProfileRoute | null) => void>()

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)

    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(value))
    }
  } catch {
    // best-effort: blocked storage just means the preference isn't remembered
  }
}

function storeProfile(name: string | null): DesktopActiveProfile {
  writeStored(PROFILE_STORAGE_KEY, name)

  return { profile: name }
}

async function toConnectionConfig(stored: StoredConnection): Promise<DesktopConnectionConfig> {
  const token = resolveToken()
  const hasToken = stored.remoteAuthMode === 'token' && Boolean(stored.remoteToken || token)
  // Reflect the REAL session state so isRemoteReauthFailure() can decide whether
  // to show the sign-in branch. Reporting a false "connected" here would hide
  // the sign-in path and strand the user on a dead connection.
  const remoteOauthConnected = stored.remoteAuthMode === 'oauth' ? await probeAuthConnected() : false

  return {
    // The web build has no environment overrides, so the settings screen is
    // always editable.
    envOverride: false,
    mode: stored.mode,
    profile: null,
    remoteAuthMode: stored.remoteAuthMode,
    remoteOauthConnected,
    remoteTokenPreview: stored.remoteToken ? `...${stored.remoteToken.slice(-4)}` : null,
    remoteTokenSet: hasToken,
    // Browser storage is origin-scoped; there is no OS keychain or plaintext
    // on-disk mode to report.
    secureTokenStorage: true,
    remoteTokenPlainText: false,
    remoteUrl: stored.remoteUrl,
    cloudOrg: '',
    sshHost: '',
    sshUser: '',
    sshPort: null,
    sshKeyPath: '',
    sshRemoteHermesPath: '',
    sshRemoteProfile: ''
  }
}

/** GET /api/status against an arbitrary base, bypassing the auth header path. */
async function fetchStatus(
  base: string,
  origin: string | null = null
): Promise<{ auth_providers?: string[]; auth_required?: boolean; version?: string } | null> {
  const res = await fetch(withGatewayRoute(`${base}/api/status`, origin), {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(8_000)
  })

  if (!res.ok) {throw new Error(`${res.status}: ${res.statusText}`)}

  return (await res.json()) as { auth_providers?: string[]; auth_required?: boolean; version?: string }
}

function readyBootProgress(): DesktopBootProgress {
  return {
    error: null,
    fakeMode: false,
    message: 'Ready',
    phase: 'backend.ready',
    progress: 100,
    running: false,
    timestamp: Date.now()
  }
}

async function webNotify(payload: HermesNotification): Promise<boolean> {
  if (!('Notification' in window)) {return false}

  if (Notification.permission === 'default') {
    await Notification.requestPermission()
  }

  if (Notification.permission !== 'granted') {return false}
  new Notification(payload.title ?? 'Hermes', {
    body: payload.body,
    silent: payload.silent
  })

  return true
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Everything the web build supports. `terminal`, `git` and `zoom` are
 * intentionally absent: their consumers probe for bridge presence and
 * self-disable (terminal), or never reach the native path in remote mode
 * (git), or render nothing (zoom).
 */
type WebBridge = Omit<NonNullable<Window['hermesDesktop']>, 'terminal' | 'git' | 'zoom'>

/**
 * Chromium can resolve Clipboard API writes without updating the system
 * clipboard in installed Wayland web apps. The user-gesture selection path is
 * older, but is reliable there and remains scoped to the browser bridge.
 *
 * The temporary textarea steals focus and replaces the document selection, so
 * both are captured up front and restored afterwards - the Clipboard API path
 * never disturbed either, and callers (a user mid-selection, the composer's
 * caret-based inline-ref insertion) must not observe a difference.
 */
export function copyTextWithSelection(text: string): boolean {
  const previousActive = document.activeElement
  const selection = document.getSelection()
  const previousRanges: Range[] = []

  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index).cloneRange())
    }
  }

  const textarea = document.createElement('textarea')
  textarea.dataset.hermesClipboardFallback = ''
  textarea.value = text
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.append(textarea)

  try {
    textarea.select()

    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()

    if (selection) {
      selection.removeAllRanges()

      for (const range of previousRanges) {
        selection.addRange(range)
      }
    }

    if (previousActive instanceof HTMLElement && previousActive.isConnected) {
      previousActive.focus({ preventScroll: true })
    }
  }
}

export function createWebBridge(): Window['hermesDesktop'] {
  // Captured BEFORE installClipboardShim() rewrites navigator.clipboard.writeText
  // to point back at this bridge (install.ts runs first, main.tsx installs the
  // shim later). Falling back through the shimmed method would re-enter
  // writeClipboard forever (writeClipboard -> shim -> writeClipboard), recursing
  // to stack exhaustion with a textarea created and destroyed on every frame.
  const nativeClipboardWriteText = navigator.clipboard?.writeText
    ? navigator.clipboard.writeText.bind(navigator.clipboard)
    : undefined

  const bridge: WebBridge = {
    getConnection: async profile => connection(targetFor(getActiveGateway()), profile),
    getConnectionFor: async ({ connectionId, profile }) => connection(targetForId(connectionId), profile, true),
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    touchBackend: async () => ({ ok: true }),
    // One target for both the ticket mint and the socket connect, so the dev
    // proxy routes them to the same gateway (a mismatch would 4403).
    getGatewayWsUrl: async () => gatewayWsUrl(targetFor(getActiveGateway())),
    getGatewayWsUrlFor: async ({ connectionId }) => gatewayWsUrl(targetForId(connectionId)),
    // Upstream switched the live socket; remember the source so un-scoped REST,
    // caches and the next page load follow it.
    setActiveConnectionRoute: route => {
      if (route?.connectionId && getGateway(route.connectionId)) {
        setActiveGateway(route.connectionId)
      }
    },
    connections: {
      list: async () => registry(),
      save: async input => {
        const saved = saveRegistryConnection(input)

        return { ok: true, connection: saved, registry: registry() }
      },
      remove: async id => {
        if (listGateways().length <= 1) {
          throw new Error('The last gateway cannot be removed.')
        }

        removeGateway(id)
        emitRegistryChange({ connectionId: id, reason: 'removed' })

        return { ok: true, registry: registry() }
      },
      setPrimary: async id => {
        setActiveGateway(id)

        return { ok: true, registry: registry() }
      },
      setLaunchMode: async mode => {
        writeStored(LAUNCH_MODE_STORAGE_KEY, mode)

        return { ok: true, registry: registry() }
      },
      setLastUsed: async id => {
        setActiveGateway(id)

        return { ok: true, registry: registry() }
      },
      test: async id => testGateway(targetForId(id)),
      onChanged: callback => {
        registryListeners.add(callback)

        return () => registryListeners.delete(callback)
      }
    },
    getProfileRoutes: async profiles => {
      const connectionId = getActiveGateway().id

      return profiles.map(profile => ({ connectionId, mode: 'remote', profile, targetProfile: profile }))
    },
    openSessionWindow: async sessionId => {
      const opened = window.open(`${window.location.pathname}#/${sessionId}`, '_blank', 'noopener')

      return opened ? { ok: true } : { ok: false, error: 'popup-blocked' }
    },
    petOverlay: {
      open: async () => ({ ok: false }),
      close: async () => ({ ok: true }),
      setBounds: noop,
      setIgnoreMouse: noop,
      setFocusable: noop,
      pushState: noop,
      control: noop,
      onState: unsubscribed,
      onControl: unsubscribed
    },
    getBootProgress: async () => readyBootProgress(),
    getConnectionConfig: async () => toConnectionConfig(loadStoredConnection()),
    saveConnectionConfig: async input => toConnectionConfig(persistConnection(input)),
    applyConnectionConfig: async input => {
      const next = persistConnection(input)
      // Reconnecting the live socket in place is fiddly; a reload re-runs the
      // whole boot path against the new connection, which is exactly what the
      // desktop shell does on "Save and reconnect". Defer so this promise
      // resolves (and the UI can settle) before the navigation.
      setTimeout(() => window.location.reload(), 50)

      return toConnectionConfig(next)
    },
    testConnectionConfig: async input => {
      const remoteUrl = input?.remoteUrl ?? loadStoredConnection().remoteUrl
      const base = normalizeBase(remoteUrl)
      // Route by the gateway being tested (not the active one).
      const status = await fetchStatus(base, upstreamOriginFor(remoteUrl))

      return { baseUrl: base, ok: true, version: status?.version ?? null }
    },
    probeConnectionConfig: async remoteUrl => {
      const base = normalizeBase(remoteUrl)

      // A different-origin gateway is blocked by the browser (mixed content +
      // localhost-only CORS) before the fetch is meaningful. Report the real
      // reason via `error` so the UI explains it, instead of firing a doomed
      // request that surfaces as a generic "could not reach".
      const block = classifyGatewayReach(remoteUrl)

      if (block) {
        return { baseUrl: base, reachable: false, authMode: 'unknown', providers: [], version: null, error: block }
      }

      try {
        const status = await fetchStatus(base, upstreamOriginFor(remoteUrl))

        return {
          baseUrl: base,
          reachable: true,
          authMode: status?.auth_required ? 'oauth' : 'token',
          providers: (status?.auth_providers ?? []).map(name => ({ name, displayName: name })),
          version: status?.version ?? null,
          error: null
        }
      } catch (error) {
        return {
          baseUrl: base,
          reachable: false,
          authMode: 'unknown',
          providers: [],
          version: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },
    oauthLoginConnectionConfig: async remoteUrl => {
      const base = remoteUrl ? normalizeBase(remoteUrl) : baseUrl()
      const origin = remoteUrl ? upstreamOriginFor(remoteUrl) : activeUpstreamOrigin()

      // A cross-origin absolute URL can never hold a login session in the
      // browser (see isSameOrigin). A whitelisted gateway folds to the serving
      // origin (proxied), so it passes; a genuinely cross-origin one fails loudly
      // with guidance instead of stranding the user on the gateway's dashboard.
      if (!isSameOrigin(base)) {
        throw new Error(
          `This gateway (${base}) is on a different origin than the app, so the browser ` +
            'will not keep its login session after sign-in. Reach it on the same origin ' +
            'instead: whitelist it (HERMES_GATEWAY_URL or config.json) so the dev proxy ' +
            "folds it same-origin, or use a session token. Desktop can use an absolute URL; the browser can't."
        )
      }

      // Same-origin (incl. a whitelisted gateway folded through the dev proxy):
      // mirror the desktop popup so the app stays mounted. Sync the routing
      // cookie first so the IDP callback navigation reaches this gateway.
      syncDevGatewayCookie()

      return openOauthLoginPopup(base, origin)
    },
    oauthLogoutConnectionConfig: async remoteUrl => {
      const base = remoteUrl ? normalizeBase(remoteUrl) : baseUrl()
      const origin = remoteUrl ? upstreamOriginFor(remoteUrl) : activeUpstreamOrigin()
      await fetch(withGatewayRoute(`${base}/auth/logout`, origin), { method: 'POST', credentials: 'same-origin' })

      return { ok: true, connected: false }
    },
    profile: {
      getDefault: async () => readStored<DesktopProfileRoute>(DEFAULT_ROUTE_STORAGE_KEY),
      setDefault: async route => {
        writeStored(DEFAULT_ROUTE_STORAGE_KEY, route)
        defaultRouteListeners.forEach(listener => listener(route))

        return route
      },
      onDefaultChanged: callback => {
        defaultRouteListeners.add(callback)

        return () => defaultRouteListeners.delete(callback)
      },
      get: async () => ({ profile: readStored<string>(PROFILE_STORAGE_KEY) }),
      remember: async name => storeProfile(name),
      // No local backend to relaunch: the gateway serves every profile.
      set: async name => storeProfile(name)
    },
    api: apiFetch,
    notify: webNotify,
    requestMicrophoneAccess: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(track => track.stop())

        return true
      } catch {
        return false
      }
    },
    readFileDataUrl: async () => {
      throw new Error('local file access is unavailable in the web app')
    },
    readFileText: async () => {
      throw new Error('local file access is unavailable in the web app')
    },
    selectPaths: async () => [],
    writeClipboard: async text => {
      if (copyTextWithSelection(text)) {
        return true
      }

      if (!nativeClipboardWriteText) {
        return false
      }

      try {
        await nativeClipboardWriteText(text)

        return true
      } catch {
        return false
      }
    },
    saveImageFromUrl: async url => {
      const opened = window.open(url, '_blank', 'noopener')

      return Boolean(opened)
    },
    saveImageBuffer: async (data, ext) => {
      const bytes = data instanceof Uint8Array ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data)
      const filename = `hermes-image.${ext}`
      downloadBlob(new Blob([bytes]), filename)

      return filename
    },
    saveClipboardImage: async () => '',
    getPathForFile: () => '',
    normalizePreviewTarget: async () => null,
    watchPreviewFile: async url => ({ id: '', path: url }),
    stopPreviewFileWatch: async () => true,
    setTitleBarTheme: noop,
    setNativeTheme: noop,
    setTranslucency: noop,
    setPreviewShortcutActive: noop,
    openExternal: async url => {
      window.open(url, '_blank', 'noopener')
    },
    openPreviewInBrowser: async url => {
      window.open(url, '_blank', 'noopener')
    },
    fetchLinkTitle: async url => url,
    sanitizeWorkspaceCwd: async cwd => ({ cwd: cwd ?? '', sanitized: false }),
    settings: {
      getDefaultProjectDir: async () => ({ defaultLabel: '', dir: null, resolvedCwd: '' }),
      pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
      setDefaultProjectDir: async dir => ({ dir })
    },
    revealLogs: async () => ({ ok: false, path: '' }),
    getRecentLogs: async () => ({ path: '', lines: [] }),
    readDir: async () => ({ entries: [], error: 'local file access is unavailable in the web app' }),
    onClosePreviewRequested: unsubscribed,
    onOpenUpdatesRequested: unsubscribed,
    onDeepLink: unsubscribed,
    signalDeepLinkReady: async () => ({ ok: true }),
    onWindowStateChanged: unsubscribed,
    onFocusSession: unsubscribed,
    onNotificationAction: unsubscribed,
    onPreviewFileChanged: unsubscribed,
    onBackendExit: unsubscribed,
    onPowerResume: unsubscribed,
    onBootProgress: unsubscribed,
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      setupChoice: null,
      unsupportedPlatform: null,
      // Nothing to install or repair from a browser tab: report "bundled" so
      // recovery never offers the installer.
      bundled: true
    }),
    continueBootstrapLocal: async () => ({ ok: true }),
    getSyncStatus: async () => null,
    // --- Electron-only surfaces: honest browser equivalents or inert stubs ---
    // Hermes Cloud sign-in needs the desktop's OAuth partition.
    cloud: {
      status: async () => ({ portalBaseUrl: '', signedIn: false }),
      login: async () => ({ portalBaseUrl: '', signedIn: false, ok: false }),
      logout: async () => ({ portalBaseUrl: '', signedIn: false, ok: true }),
      discover: async () => ({ agents: [] }),
      agentSignIn: async dashboardUrl => ({ baseUrl: dashboardUrl, connected: false })
    },
    // No per-profile backend pool: the gateway serves every profile itself.
    getPoolLimits: async () => ({ maxBackends: 0, idleMs: 0 }),
    setPoolLimits: async () => ({ ok: false, limits: { maxBackends: 0, idleMs: 0 } }),
    // The browser's own find (Ctrl/Cmd+F) covers the page.
    findInPage: async () => ({ count: 0 }),
    stopFindInPage: async () => undefined,
    onFoundInPage: unsubscribed,
    onOpenFindBarRequested: unsubscribed,
    // The global quick-entry window is an OS-level shortcut.
    quickEntry: {
      getSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
      setSettings: async () => ({ enabled: false, error: null, registered: false, shortcut: '' }),
      submit: noop,
      dismiss: noop,
      pushState: noop,
      onState: unsubscribed,
      onSubmit: unsubscribed,
      onShown: unsubscribed
    },
    windowControls: { custom: false, minimize: noop, toggleMaximize: noop, close: noop },
    openSessionInTerminal: async () => ({ ok: false, error: 'No local terminal in the browser.' }),
    openWindow: async () => {
      const opened = window.open(window.location.href.split('#')[0], '_blank', 'noopener')

      return opened ? { ok: true } : { ok: false, error: 'popup-blocked' }
    },
    openBrowserWindow: async () => ({ ok: false, error: 'Pop-out windows need the desktop app.' }),
    onBrowserPopoutClosed: unsubscribed,
    // One tab, one cue.
    claimAmbientCue: async () => true,
    getSecretStorageEncryption: async () => ({ on: false }),
    setSecretStorageEncryption: async () => ({ on: false }),
    sshConfigHosts: async () => ({ hosts: [] }),
    sshResolveHost: async () => ({ hostname: null, identityFile: null, port: null, user: null }),
    readClipboard: async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    },
    // No disk to stage a large paste on: '' keeps it inline in the composer.
    savePastedText: async () => '',
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: true }),
    onBootstrapEvent: unsubscribed,
    getVersion: async () => ({
      appVersion: '0.1.0-web',
      electronVersion: '',
      nodeVersion: '',
      platform: 'web',
      hermesRoot: ''
    }),
    getRemoteDisplayReason: async () => null,
    updates: {
      check: async () => ({ supported: false }),
      apply: async () => ({ ok: false }),
      getBranch: async () => ({ branch: '' }),
      setBranch: async () => ({ branch: '' }),
      onProgress: unsubscribed
    },
    uninstall: {
      summary: async () => {
        throw new Error('uninstall is unavailable in the web app')
      },
      run: async () => {
        throw new Error('uninstall is unavailable in the web app')
      }
    },
    themes: {
      fetchMarketplace: async () => {
        throw new Error('marketplace themes are unavailable in the web app')
      },
      searchMarketplace: async () => []
    }
  }

  return bridge as Window['hermesDesktop']
}
