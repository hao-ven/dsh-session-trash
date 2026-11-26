/**
 * Session trash: DSH ships archive only, so this plugin adds a reversible
 * delete — a Session leaves `sessions/` but lands in `$DSH_HOME/session-trash/`,
 * and only an explicit purge frees the bytes.
 *
 * Two things make it behave like a real delete rather than a hide:
 * - The move is a whole-directory rename on the same volume, so it is atomic.
 * - The live Agent is released first. DSH keeps an opened Session's Agent in the
 *   Host process, and only its owner holds the `dispose` capability; this plugin
 *   captures those handles by wrapping `ctx.agents.create/resume`, so the row
 *   leaves every surface immediately instead of lingering as a ghost.
 *
 * The Remote endpoint is published through live Service markers ("SRC") and the
 * browser calls it over the page's own `/api` carrier, so no generated Typert
 * artifact is involved.
 *
 * @module @local/dsh-session-trash
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'session-trash'

/** The tool registry is the only mandatory dependency. */
export const inject = ['tools']

/** Marker key the Typert gateway reads off a Service prototype. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Symbol table of captured Agent handles, kept on the agents service itself. */
const HANDLES = Symbol.for('dsh.plugin.session-trash.handles')

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/

const TRASH_TOOLS = [
  {
    name: 'trash_session',
    description: 'Move one stored Session into the local recycle bin (reversible). Its log, projection cache and '
      + 'Workspace accounting are preserved in $DSH_HOME/session-trash and the live Agent is released. '
      + 'Use it when the human wants a Session gone but might want it back; only when they explicitly ask.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'Exact Session id, with or without the `session-` prefix.' },
        stop_running: { type: 'boolean', description: 'Stop the Session\'s running work instead of refusing.' },
      },
    },
    schema: 'trash',
    executeKey: 'trash',
  },
  {
    name: 'restore_session',
    description: 'Restore one Session from the local recycle bin back into its Workspace. '
      + 'Use it when the human wants a Session they deleted earlier to come back.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'Exact Session id of a trashed Session; list_session_trash shows them.' },
      },
    },
    schema: 'restore',
    executeKey: 'restore',
  },
  {
    name: 'purge_session',
    description: 'Permanently free a trashed Session: delete its log directory and forget its bin entry. '
      + 'Irreversible. Only after the human confirms they do not want it back.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'Exact Session id of a trashed Session.' },
      },
    },
    schema: 'purge',
    executeKey: 'purge',
  },
  {
    name: 'list_session_trash',
    description: 'List the Sessions currently in the local recycle bin with their titles, sizes and deletion time.',
    parameters: {},
    schema: 'list',
    executeKey: 'list',
  },
]

const TRASH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'trashed', 'restored', 'purged', 'path', 'workspaceTitle', 'warnings'],
  properties: {
    sessionId: { type: 'string' },
    trashed: { type: 'boolean', description: 'Whether this call moved the Session into the bin.' },
    restored: { type: 'boolean', description: 'Whether this call brought the Session back.' },
    purged: { type: 'boolean', description: 'Whether this call freed the Session permanently.' },
    path: { type: 'string', description: 'Where the log now lives (bin path, restored path, or empty after a purge).' },
    workspaceTitle: { type: 'string', description: 'Workspace the Session was detached from or reattached to.' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const LIST_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'title', 'cwd', 'deletedAt', 'bytes'],
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          deletedAt: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
    },
  },
}

const ORPHAN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['orphans', 'removed'],
  properties: {
    orphans: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'bytes'],
        properties: {
          sessionId: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
    },
    removed: { type: 'integer', description: 'Rows actually removed by this call.' },
  },
}

/** Read an optional Cordis service without turning its absence into a plugin failure. */
function optionalService(ctx, key) {
  try {
    const provided = ctx.reflect?.get?.(key)
    if (provided !== undefined) return provided
  } catch {
    // Fall through to the injected-property form.
  }
  try {
    return ctx[key] ?? undefined
  } catch {
    return undefined
  }
}

/** The DSH home holding `sessions/`, `storages/` and the bin. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

const sessionsRoot = () => join(dshHome(), 'sessions')
const trashRoot = () => join(dshHome(), 'session-trash')

/** The bin directory this plugin used before it took the plain name. */
const LEGACY_TRASH_DIR = 'local-session-trash'
const trashIndexPath = () => join(trashRoot(), 'index.json')

/** Render one error without assuming its shape. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read the bin index; a missing or malformed file reads as empty. */
async function readIndex() {
  try {
    const raw = await readFile(trashIndexPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object'
      ? parsed
      : { entries: {} }
  } catch {
    return { entries: {} }
  }
}

/** Write the bin index atomically. */
async function writeIndex(index) {
  await mkdir(trashRoot(), { recursive: true })
  const temporary = `${trashIndexPath()}.tmp`
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(temporary, trashIndexPath())
}

/**
 * Every `sessions/<bucket>/<sessionId>` directory that exists right now.
 * @param sessionId - validated Session identity.
 * @returns `{ bucket, path }` pairs.
 */
async function logLocationsOf(sessionId) {
  const found = []
  let buckets
  try {
    buckets = await readdir(sessionsRoot(), { withFileTypes: true })
  } catch {
    return found
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const candidate = join(sessionsRoot(), bucket.name, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) found.push({ bucket: bucket.name, path: candidate })
    } catch {
      // Not this bucket.
    }
  }
  return found
}

/** Recursive byte size of one directory, best effort. */
async function directoryBytes(path) {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    try {
      if (entry.isDirectory()) total += await directoryBytes(child)
      else total += (await stat(child)).size
    } catch {
      // Vanished while walking.
    }
  }
  return total
}

/**
 * Capture every Agent handle the registry hands out, so this plugin can release
 * a Session's live Agent — a capability only the handle owner holds.
 * @param ctx - plugin context.
 * @returns nothing; the table lives on the service under {@link HANDLES}.
 */
function captureAgentHandles(ctx) {
  const install = (agents) => {
    if (agents === undefined || agents === null || agents[HANDLES] !== undefined) return
    const handles = new Map()
    Object.defineProperty(agents, HANDLES, { value: handles, configurable: true })
    for (const method of ['create', 'resume']) {
      const original = agents[method]
      if (typeof original !== 'function') continue
      const wrapped = async function (...args) {
        const handle = await original.apply(this, args)
        const id = handle?.agent?.session?.id
        if (typeof id === 'string') handles.set(id, handle)
        return handle
      }
      try {
        agents[method] = wrapped
      } catch {
        // Not writable in this composition; live release stays unavailable.
      }
    }
  }
  const existing = optionalService(ctx, 'agents')
  if (existing !== undefined) {
    install(existing)
    return
  }
  try {
    ctx.inject(['agents'], (child) => { install(optionalService(child, 'agents')) })
  } catch {
    // No agents service in this composition.
  }
}

/**
 * Release a Session's live Agent so the Host stops listing it.
 * @param agents - the agents registry, when composed.
 * @param sessionId - Session to release.
 * @returns whether a live handle was disposed.
 */
async function releaseAgent(agents, sessionId) {
  const handles = agents?.[HANDLES]
  if (!(handles instanceof Map)) return false
  const handle = handles.get(sessionId)
  if (handle === undefined) return false
  handles.delete(sessionId)
  try {
    await handle.dispose()
    return true
  } catch {
    return false
  }
}

/**
 * Projection-cache rows whose Session no longer exists anywhere: no log
 * directory and no bin entry. These rows make deleted Sessions keep showing up
 * in the sidebar, so they are worth clearing explicitly.
 * @returns the orphaned rows with their sizes.
 */
async function findOrphanCacheRows() {
  const root = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let files
  try {
    files = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const index = await readIndex()
  const orphans = []
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue
    const sessionId = file.name.slice(0, -'.json'.length)
    if (index.entries[sessionId] !== undefined) continue
    if ((await logLocationsOf(sessionId)).length > 0) continue
    const path = join(root, file.name)
    let bytes = 0
    try {
      bytes = (await stat(path)).size
    } catch {
      // Ignore.
    }
    orphans.push({ sessionId, path, bytes })
  }
  return orphans
}

/**
 * Describe background work for a refusal message.
 * @param activity - entries reported by `workspace/session-activity`.
 * @returns one readable clause.
 */
function describeActivity(activity) {
  const parts = []
  for (const entry of activity) {
    const items = Array.isArray(entry?.items) ? entry.items : []
    const labels = items.map(item => item?.label ?? item?.id).filter(label => typeof label === 'string' && label.length > 0)
    parts.push(labels.length > 0 ? `${entry.kind}: ${labels.join(', ')}` : String(entry?.kind ?? 'work'))
  }
  return parts.join('; ')
}

/** Projection-cache row path for one Session in the default JSON storage unit. */
function projectionCachePath(sessionId) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/** Where a trashed Session's cache row waits while it sits in the bin. */
function parkedCachePath(sessionId) {
  return join(trashRoot(), sessionId, '.projcache.json')
}

/**
 * Read the cached title hint for one Session.
 * The cache is derived data, but it is the only cheap source of a Session's
 * display title — the log itself keeps titles in later zstd frames.
 * @param path - a projection-cache row file.
 * @returns the title and the sequence it was read at.
 */
async function readCacheHints(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const rows = parsed?.record?.rows ?? {}
    const titleRow = rows.title
    const listMeta = rows.sessionListMetadata?.val ?? {}
    const stats = rows.sessionStats?.val ?? {}
    const model = rows.modelSelection?.val?.lastUsed ?? {}
    const tokens = rows.tokenUsage?.val?.totals ?? {}
    return {
      title: typeof titleRow?.val === 'string' ? titleRow.val : '',
      seq: typeof titleRow?.seq === 'number' ? titleRow.seq : 0,
      lastPromptAt: typeof listMeta.lastPromptAt === 'number' ? listMeta.lastPromptAt : 0,
      turns: typeof stats.turns === 'number' ? stats.turns : 0,
      model: typeof model.model === 'string' ? model.model : '',
      blank: listMeta.blank === true,
      outputTokens: typeof tokens.outputTokens === 'number' ? tokens.outputTokens : 0,
    }
  } catch {
    return { title: '', seq: 0, lastPromptAt: 0, turns: 0, model: '', blank: false, outputTokens: 0 }
  }
}

/**
 * Park a trashed Session's cache row beside its log so a restore can bring the
 * title back with it.
 * @param sessionId - Session identity.
 */
async function parkProjectionCache(sessionId) {
  try {
    await rename(projectionCachePath(sessionId), parkedCachePath(sessionId))
  } catch {
    // No cache row, or the bin directory is gone; derived data can be rebuilt.
  }
}

/**
 * Put a restored Session's cache row back where the Host looks for it.
 * The parked copy rides inside the restored directory, so it is read from there.
 * @param sessionId - Session identity.
 * @param restoredDirectory - the directory the log was just moved back to.
 */
async function unparkProjectionCache(sessionId, restoredDirectory) {
  try {
    await mkdir(join(dshHome(), 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await rename(join(restoredDirectory, '.projcache.json'), projectionCachePath(sessionId))
  } catch {
    // Nothing parked, or it could not be moved; the Host rebuilds it on demand.
  }
}

/**
 * Remove one Session's projection-cache row; the Host rebuilds it on demand.
 * @param sessionId - Session identity.
 * @returns whether a row was removed.
 */
async function dropProjectionCache(sessionId) {
  try {
    await rm(projectionCachePath(sessionId), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Drop the Session from every registry-owned account.
 * @param registry - the workspace registry, when composed.
 * @param sessionId - Session to forget.
 * @returns the affected workspace title, if any, plus warnings.
 */
async function forgetInLedger(registry, sessionId) {
  const warnings = []
  let workspaceTitle = ''
  if (registry === undefined) {
    warnings.push('workspaceRegistry is not composed; the Workspace ledger was left untouched.')
    return { workspaceTitle, warnings }
  }
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
      workspaceTitle = workspace.title
    } catch (error) {
      warnings.push(`Could not detach from "${workspace.title}": ${messageOf(error)}`)
    }
  }
  if (registry.archivedSessionIds.includes(sessionId)) {
    try {
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      warnings.push(`Could not drop the archive entry: ${messageOf(error)}`)
    }
  }
  if (registry.pinnedSessionIds.includes(sessionId)) {
    try {
      await registry.unpinSession(sessionId)
    } catch (error) {
      warnings.push(`Could not drop the pin: ${messageOf(error)}`)
    }
  }
  return { workspaceTitle, warnings }
}

/**
 * Read one Session's log header, best effort. The first line is either plain
 * JSONL or a zstd frame; later frames are appended, so only the first is read.
 * @param locations - the Session's `{ path }` directories.
 * @returns the parsed header, or undefined when unreadable.
 */
async function readHeaderObject(locations) {
  for (const location of locations) {
    let names
    try {
      names = await readdir(location.path)
    } catch {
      continue
    }
    const file = names.find(name => /^session\..*\.jsonl(\.zstd)?$/.test(name))
    if (file === undefined) continue
    const path = join(location.path, file)
    try {
      let text
      if (file.endsWith('.zstd')) {
        const zlib = await import('node:zlib')
        if (typeof zlib.zstdDecompressSync !== 'function') continue
        const compressed = await readFile(path)
        text = zlib.zstdDecompressSync(compressed).toString('utf8')
      } else {
        text = await readFile(path, 'utf8')
      }
      const firstLine = text.split('\n', 1)[0]?.trim()
      if (firstLine === undefined || firstLine.length === 0) continue
      return JSON.parse(firstLine)
    } catch {
      // Unreadable or unexpected format; try the next directory.
    }
  }
  return undefined
}

/**
 * Move a bin left by the plugin's earlier directory name into the current one.
 * Runs once at activation; a missing legacy directory is the steady state.
 */
async function migrateLegacyBin() {
  const legacy = join(dshHome(), LEGACY_TRASH_DIR)
  if (!existsSync(legacy)) return
  await mkdir(trashRoot(), { recursive: true })
  const index = await readIndex()
  let legacyIndex = { entries: {} }
  try {
    const parsed = JSON.parse(await readFile(join(legacy, 'index.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object') legacyIndex = parsed
  } catch {
    // No readable manifest; the directory scan below still adopts the logs.
  }
  for (const [sessionId, entry] of Object.entries(legacyIndex.entries)) {
    const from = join(legacy, sessionId)
    const to = join(trashRoot(), sessionId)
    if (existsSync(from) && !existsSync(to)) {
      try {
        await rename(from, to)
      } catch {
        // Leave it; the row keeps pointing at a missing log and prunes itself.
      }
    }
    if (index.entries[sessionId] === undefined) index.entries[sessionId] = entry
  }
  try {
    for (const dirent of await readdir(legacy, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const from = join(legacy, dirent.name)
      const to = join(trashRoot(), dirent.name)
      if (existsSync(to)) continue
      try {
        await rename(from, to)
      } catch {
        // Same as above.
      }
    }
  } catch {
    // The directory vanished mid-flight.
  }
  await writeIndex(index)
  // Only drop the old directory once nothing is left in it: a failed rename must
  // never take a log with it.
  try {
    const remaining = await readdir(legacy, { withFileTypes: true })
    if (remaining.some(dirent => dirent.isDirectory())) return
  } catch {
    return
  }
  try {
    await rm(legacy, { recursive: true, force: true })
  } catch {
    // A locked leftover directory is harmless.
  }
}

/**
 * Read a Session's recorded header facts.
 * @param locations - the Session's `{ path }` directories.
 * @returns the recorded cwd and creation instant, empty when unreadable.
 */
async function readHeaderInfo(locations) {
  const header = await readHeaderObject(locations)
  const cwd = header?.cwd ?? header?.header?.cwd
  const createdAt = header?.createdAt ?? header?.header?.createdAt
  return {
    cwd: typeof cwd === 'string' ? cwd : '',
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  }
}

/**
 * Stored Sessions that record this id as their parent.
 * Subagent Sessions keep a parent link in their own header; when the field is
 * absent in this build the scan simply reports none.
 * @param sessionId - the Session being deleted.
 * @returns child Session ids found on disk.
 */
async function findChildSessions(sessionId) {
  const children = []
  let buckets
  try {
    buckets = await readdir(sessionsRoot(), { withFileTypes: true })
  } catch {
    return children
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(sessionsRoot(), bucket.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === sessionId) continue
      const header = await readHeaderObject([{ path: join(sessionsRoot(), bucket.name, entry.name) }])
      const parent = header?.parentSessionId ?? header?.parent?.sessionId ?? header?.parent
      if (typeof parent === 'string' && parent === sessionId) children.push(entry.name)
    }
  }
  return children
}

/**
 * List the Sessions the Workspace registry currently archives, newest ids last.
 * Archived Sessions are hidden from the sidebar but still on disk, so the bin
 * panel can offer them for unarchiving or deletion.
 * @param ctx - plugin context.
 * @returns one entry per archived Session.
 */
async function listArchivedSessions(ctx) {
  const registry = optionalService(ctx, 'workspaceRegistry')
  if (registry === undefined) return []
  const entries = []
  for (const sessionId of registry.archivedSessionIds) {
    const id = String(sessionId)
    const locations = await logLocationsOf(id)
    let bytes = 0
    for (const location of locations) bytes += await directoryBytes(location.path)
    const hints = await readCacheHints(projectionCachePath(id))
    const header = await readHeaderInfo(locations)
    entries.push({
      sessionId: id,
      title: hints.title,
      cwd: header.cwd,
      createdAt: header.createdAt,
      lastPromptAt: hints.lastPromptAt,
      turns: hints.turns,
      model: hints.model,
      blank: hints.blank,
      bytes,
    })
  }
  entries.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  return entries
}

/**
 * Drop one Session from the registry-global archive set.
 * @param ctx - plugin context.
 * @param raw - candidate Session id.
 * @returns the acknowledgement.
 */
async function unarchiveSessionById(ctx, raw) {
  if (!SESSION_ID.test(raw)) throw new Error(`session-trash: ${JSON.stringify(raw)} is not a Session id`)
  const registry = optionalService(ctx, 'workspaceRegistry')
  if (registry === undefined) throw new Error('session-trash: workspaceRegistry is not composed')
  if (!registry.archivedSessionIds.includes(raw)) {
    throw new Error(`session-trash: Session ${raw} is not archived`)
  }
  await registry.unarchiveSession(raw)
  return { sessionId: raw, unarchived: true }
}

/**
 * Move one Session into the recycle bin.
 * @param ctx - plugin context.
 * @param raw - candidate Session id.
 * @param options - `stopRunning` stops the Session's work instead of refusing.
 * @returns the trash summary.
 */
async function trashSession(ctx, raw, options = {}) {
  if (!SESSION_ID.test(raw)) throw new Error(`session-trash: ${JSON.stringify(raw)} is not a Session id`)
  const registry = optionalService(ctx, 'workspaceRegistry')
  const agents = optionalService(ctx, 'agents')

  if (registry !== undefined) {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: raw }, () => Promise.resolve([]))
    if (Array.isArray(activity) && activity.length > 0) {
      if (options.stopRunning !== true) {
        throw new Error(
          `session-trash: Session ${raw} still has work running (${describeActivity(activity)}); `
          + 'retry with stop_running to stop it and move it to the bin',
        )
      }
      try {
        await ctx.parallel('workspace/session-stop', { sessionId: raw })
      } catch (error) {
        throw new Error(`session-trash: could not stop the Session's work: ${messageOf(error)}`)
      }
    }
  }

  const locations = await logLocationsOf(raw)
  const index = await readIndex()
  const known = index.entries[raw] !== undefined
  if (locations.length === 0 && !known) {
    throw new Error(`session-trash: no stored Session ${raw}; nothing to move`)
  }

  const warnings = []
  const released = await releaseAgent(agents, raw)
  if (!released && typeof agents?.get === 'function' && agents.get(raw) !== undefined) {
    warnings.push('会话仍在本进程内打开且拿不到它的句柄，重启 DSH 前可能仍会看到一行')
  }

  // Capture where it lived before the ledger forgets it, so the bin can show it
  // and a later restore can land back in the same workspace.
  const header = await readHeaderInfo(locations)
  const hints = await readCacheHints(projectionCachePath(raw))
  const owningWorkspace = registry?.list().find(workspace => workspace.sessionIds.includes(raw))
  const cwd = header.cwd.length > 0 ? header.cwd : (owningWorkspace?.path ?? '')

  const ledger = await forgetInLedger(registry, raw)

  // A parent Session can own subagent children in its own log directories; this
  // plugin moves exactly one log, so say so rather than leaving orphans silently.
  const children = await findChildSessions(raw)
  if (children.length > 0) {
    warnings.push(
      `它有 ${children.length} 个子会话仍在磁盘上（${children.slice(0, 3).join(', ')}${children.length > 3 ? '…' : ''}），本次只移入了父会话`,
    )
  }

  await mkdir(trashRoot(), { recursive: true })
  let trashedPath = known ? join(trashRoot(), raw) : ''
  for (const location of locations) {
    const target = join(trashRoot(), raw)
    try {
      await rm(target, { recursive: true, force: true })
      await rename(location.path, target)
      trashedPath = target
      index.entries[raw] = {
        sessionId: raw,
        bucket: location.bucket,
        cwd,
        title: hints.title.length > 0 ? hints.title : (index.entries[raw]?.title ?? ''),
        deletedAt: new Date().toISOString(),
        bytes: await directoryBytes(target),
        createdAt: header.createdAt,
        lastPromptAt: hints.lastPromptAt,
        turns: hints.turns,
        model: hints.model,
        blank: hints.blank,
        outputTokens: hints.outputTokens,
        workspaceTitle: owningWorkspace?.title ?? '',
      }
    } catch (error) {
      throw new Error(`session-trash: could not move ${location.path} into the bin: ${messageOf(error)}`)
    }
    // An emptied workspace bucket is noise; remove it when nothing else lives there.
    try {
      const siblings = await readdir(dirname(location.path))
      if (siblings.length === 0) await rm(dirname(location.path), { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
  if (known && locations.length === 0) {
    index.entries[raw].deletedAt = index.entries[raw].deletedAt ?? new Date().toISOString()
  }
  await writeIndex(index)
  await parkProjectionCache(raw)

  // Let every open page drop the row in place: these two Host events are on the
  // forwarded allowlist and the Session list applies them without a reload.
  try {
    ctx.emit('api-session/removed', raw)
  } catch {
    // Older compositions without the event: the page falls back to a refresh.
  }

  return {
    sessionId: raw,
    trashed: true,
    restored: false,
    purged: false,
    path: trashedPath,
    workspaceTitle: ledger.workspaceTitle,
    warnings: [...warnings, ...ledger.warnings],
  }
}

/**
 * Bring one Session back out of the recycle bin.
 * @param ctx - plugin context.
 * @param raw - candidate Session id.
 * @returns the restore summary.
 */
async function restoreSession(ctx, raw) {
  if (!SESSION_ID.test(raw)) throw new Error(`session-trash: ${JSON.stringify(raw)} is not a Session id`)
  const index = await readIndex()
  const entry = index.entries[raw]
  const trashedPath = join(trashRoot(), raw)
  if (entry === undefined && !existsSync(trashedPath)) {
    throw new Error(`session-trash: Session ${raw} is not in the bin`)
  }
  const bucket = typeof entry?.bucket === 'string' && entry.bucket.length > 0 ? entry.bucket : '--restored--'
  const targetDir = join(sessionsRoot(), bucket)
  const target = join(targetDir, raw)
  await mkdir(targetDir, { recursive: true })
  try {
    await rename(trashedPath, target)
  } catch (error) {
    throw new Error(`session-trash: could not restore ${trashedPath}: ${messageOf(error)}`)
  }
  const warnings = []
  let workspaceTitle = ''
  const registry = optionalService(ctx, 'workspaceRegistry')
  if (registry !== undefined) {
    // The registry validates the restored log's own header cwd, so trying each
    // Workspace finds the right one without trusting our stored path.
    for (const workspace of registry.list()) {
      try {
        await workspace.attachSession(raw)
        workspaceTitle = workspace.title
        break
      } catch {
        // Not this Workspace.
      }
    }
    if (workspaceTitle === '') {
      warnings.push('已把日志放回磁盘，但没有匹配到工作区，它会显示在「未分组」下。')
    }
  }
  delete index.entries[raw]
  await writeIndex(index)

  // Announce the restored Session so open pages add its row without a reload.
  // The cache row comes back with it, and its stored title rides along as a
  // projection hint — otherwise the fresh row would read as unnamed.
  await unparkProjectionCache(raw, target)
  const restoredHints = await readCacheHints(projectionCachePath(raw))
  const title = restoredHints.title.length > 0
    ? restoredHints.title
    : (typeof entry?.title === 'string' ? entry.title : '')
  try {
    ctx.emit('api-session/added', {
      agentAvailable: false,
      sessionId: raw,
      updatedAt: Date.now(),
      running: false,
      blank: false,
      ...(typeof entry?.cwd === 'string' && entry.cwd.length > 0 ? { cwd: entry.cwd } : {}),
      ...(title.length > 0
        ? { projections: { kind: 'cached', asOfSeq: restoredHints.seq, values: { title } } }
        : {}),
    })
  } catch {
    // Older compositions without the event: the page falls back to a refresh.
  }

  return { sessionId: raw, trashed: false, restored: true, purged: false, path: target, workspaceTitle, warnings }
}

/**
 * Free one trashed Session permanently.
 * @param ctx - plugin context.
 * @param raw - candidate Session id.
 * @returns the purge summary.
 */
async function purgeSession(ctx, raw) {
  if (!SESSION_ID.test(raw)) throw new Error(`session-trash: ${JSON.stringify(raw)} is not a Session id`)
  const index = await readIndex()
  const trashedPath = join(trashRoot(), raw)
  const existed = existsSync(trashedPath)
  if (existed) {
    try {
      await rm(trashedPath, { recursive: true, force: true })
    } catch (error) {
      throw new Error(`session-trash: could not free ${trashedPath}: ${messageOf(error)}`)
    }
  }
  if (index.entries[raw] !== undefined) {
    delete index.entries[raw]
    await writeIndex(index)
  }
  if (!existed && index.entries[raw] === undefined) {
    throw new Error(`session-trash: Session ${raw} is not in the bin`)
  }
  return { sessionId: raw, trashed: false, restored: false, purged: true, path: '', workspaceTitle: '', warnings: [] }
}

/**
 * List the recycle bin, newest first.
 * @returns the entries.
 */
async function listTrash() {
  const index = await readIndex()
  const entries = []
  let indexDirty = false
  const ids = new Set(Object.keys(index.entries))
  try {
    for (const dirent of await readdir(trashRoot(), { withFileTypes: true })) {
      if (dirent.isDirectory()) ids.add(dirent.name)
    }
  } catch {
    // No bin yet.
  }
  for (const sessionId of ids) {
    const entry = index.entries[sessionId] ?? {}
    const path = join(trashRoot(), sessionId)
    // A directory that is gone makes its index row a ghost: drop the row instead
    // of listing something that cannot be restored or purged.
    if (!existsSync(path)) {
      if (index.entries[sessionId] !== undefined) {
        delete index.entries[sessionId]
        indexDirty = true
      }
      continue
    }
    let title = typeof entry.title === 'string' ? entry.title : ''
    let lastPromptAt = typeof entry.lastPromptAt === 'number' ? entry.lastPromptAt : 0
    let turns = typeof entry.turns === 'number' ? entry.turns : 0
    let model = typeof entry.model === 'string' ? entry.model : ''
    let blank = entry.blank === true
    let outputTokens = typeof entry.outputTokens === 'number' ? entry.outputTokens : 0
    if (title === '' || lastPromptAt === 0 || turns === 0 || outputTokens === 0) {
      // Entries trashed before these facts were captured still have their parked
      // cache row; read it rather than showing blanks or a bare id.
      const parked = await readCacheHints(parkedCachePath(sessionId))
      if (title === '') title = parked.title
      if (lastPromptAt === 0) lastPromptAt = parked.lastPromptAt
      if (turns === 0) turns = parked.turns
      if (model === '') model = parked.model
      if (!blank) blank = parked.blank
      if (outputTokens === 0) outputTokens = parked.outputTokens
    }
    let createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : 0
    if (createdAt === 0) {
      const located = await logLocationsOf(sessionId)
      const header = await readHeaderInfo(located.map(location => ({ path: location.path })))
      createdAt = header.createdAt
    }
    entries.push({
      sessionId,
      title,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      deletedAt: typeof entry.deletedAt === 'string' ? entry.deletedAt : '',
      bytes: typeof entry.bytes === 'number' ? entry.bytes : await directoryBytes(path),
      createdAt,
      lastPromptAt,
      turns,
      model,
      blank,
      outputTokens,
      workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : '',
    })
  }
  if (indexDirty) await writeIndex(index)
  entries.sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))
  return entries
}

/**
 * Free every Session in the bin.
 * @returns how many were freed and how many bytes they held.
 */
async function emptyBin() {
  const entries = await listTrash()
  let purged = 0
  let bytes = 0
  for (const entry of entries) {
    try {
      await rm(join(trashRoot(), entry.sessionId), { recursive: true, force: true })
      purged += 1
      bytes += typeof entry.bytes === 'number' ? entry.bytes : 0
    } catch {
      // Leave it for a retry.
    }
  }
  await writeIndex({ entries: {} })
  return { purged, bytes }
}

/**
 * Apply one bin action to many Sessions, one at a time.
 * Sequential on purpose: every mutation rewrites the bin manifest, so running
 * them concurrently would lose entries.
 * @param ctx - plugin context.
 * @param action - `trash`, `restore`, `purge` or `unarchive`.
 * @param sessionKeys - exact Session ids.
 * @returns one outcome per input id, in order.
 */
async function runBatch(ctx, action, sessionKeys) {
  const results = []
  for (const key of sessionKeys) {
    const sessionId = String(key ?? '').trim()
    try {
      if (action === 'restore') await restoreSession(ctx, sessionId)
      else if (action === 'purge') await purgeSession(ctx, sessionId)
      else if (action === 'unarchive') await unarchiveSessionById(ctx, sessionId)
      else if (action === 'trash') await trashSession(ctx, sessionId, {})
      else throw new Error(`session-trash: unknown batch action ${JSON.stringify(action)}`)
      results.push({ sessionId, ok: true })
    } catch (error) {
      results.push({ sessionId, ok: false, message: messageOf(error) })
    }
  }
  return { results }
}

/** Remote face for the sidebar button and the bin UI. */
class SessionTrashRemote {
  /** @param ctx - plugin context. */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * @param sessionKey - exact Session id.
   * @param stopRunning - stop the Session's work instead of refusing.
   * @returns the trash summary.
   */
  async delete(sessionKey, stopRunning) {
    return trashSession(this.ctx, String(sessionKey ?? '').trim(), { stopRunning: stopRunning === true })
  }

  /**
   * @param sessionKey - exact Session id.
   * @returns the restore summary.
   */
  async restore(sessionKey) {
    return restoreSession(this.ctx, String(sessionKey ?? '').trim())
  }

  /**
   * @param sessionKey - exact Session id.
   * @returns the purge summary.
   */
  async purge(sessionKey) {
    return purgeSession(this.ctx, String(sessionKey ?? '').trim())
  }

  /** @returns the bin entries. */
  async list() {
    return listTrash()
  }

  /** @returns the archived Sessions, for the panel's 归档 segment. */
  async listArchived() {
    return listArchivedSessions(this.ctx)
  }

  /**
   * @param sessionKey - exact Session id.
   * @returns the unarchive acknowledgement.
   */
  async unarchive(sessionKey) {
    return unarchiveSessionById(this.ctx, String(sessionKey ?? '').trim())
  }

  /** @returns how many Sessions and bytes the emptied bin released. */
  async empty() {
    return emptyBin()
  }

  /** @returns where the bin lives, so a page can tell the person where their data went. */
  async location() {
    return { path: trashRoot() }
  }

  /**
   * @param action - `trash`, `restore`, `purge` or `unarchive`.
   * @param sessionKeys - exact Session ids.
   * @returns one outcome per id, in order.
   */
  async batch(action, sessionKeys) {
    return runBatch(this.ctx, String(action ?? ''), Array.isArray(sessionKeys) ? sessionKeys : [])
  }
}

/** Attach the Typert Remote markers the gateway reads for SRC dispatch. */
function markRemote(prototype, methods) {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(method => ({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
  })
}

/** Render one trash summary for the agent. */
function renderTrash(_args, value) {
  const lines = []
  if (value.trashed) lines.push(`Moved Session ${value.sessionId} into the recycle bin.`)
  else if (value.restored) lines.push(`Restored Session ${value.sessionId} from the recycle bin.`)
  else if (value.purged) lines.push(`Permanently freed Session ${value.sessionId}.`)
  if (value.path.length > 0) lines.push(`Location: ${value.path}`)
  if (value.workspaceTitle.length > 0) lines.push(`Workspace: ${value.workspaceTitle}`)
  for (const warning of value.warnings) lines.push(`Warning: ${warning}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Install the Remote endpoints and the agent tools. */
export function apply(ctx) {
  captureAgentHandles(ctx)
  void migrateLegacyBin().catch(() => {})

  const remote = new SessionTrashRemote(ctx)
  markRemote(SessionTrashRemote.prototype, ['delete', 'restore', 'purge', 'list', 'listArchived', 'unarchive', 'empty', 'location', 'batch'])
  Object.defineProperty(remote, 'typertRemote', {
    configurable: true,
    value: Object.freeze({ service: remote, serviceKey: 'sessionTrash', namespace: 'sessionTrash' }),
  })
  const release = ctx.provide('sessionTrash', remote)
  ctx.effect(() => () => { release() }, 'session-trash.remote')

  const execute = {
    trash: (args) => trashSession(ctx, String(args?.session_id ?? '').trim(), { stopRunning: args?.stop_running === true }),
    restore: (args) => restoreSession(ctx, String(args?.session_id ?? '').trim()),
    purge: (args) => purgeSession(ctx, String(args?.session_id ?? '').trim()),
    list: () => listTrash().then(entries => ({ entries })),
  }

  for (const tool of TRASH_TOOLS) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: tool.schema === 'list' ? LIST_OUTPUT : TRASH_OUTPUT,
        render: tool.schema === 'list'
          ? (_args, value) => [{
            type: 'text',
            text: value.entries.length === 0
              ? 'The recycle bin is empty.'
              : value.entries.map(entry => `${entry.sessionId}  ${entry.title || '(untitled)'}  ${Math.round(entry.bytes / 1024)} KB  ${entry.deletedAt}`).join('\n'),
          }]
          : renderTrash,
      },
      execute: async (args) => execute[tool.executeKey](args),
    })
  }

  ctx.tools.register({
    name: 'purge_orphan_caches',
    description: 'Clear projection-cache rows whose Session no longer exists (no log, not in the recycle bin). '
      + 'Those rows are why deleted Sessions can keep appearing in the sidebar as ghost rows. '
      + 'The cache is derived data the Host rebuilds, so clearing it only loses a warm-start shortcut.',
    parameters: {
      dry_run: { type: 'boolean', description: 'Only report the orphans without removing them.' },
    },
    output: {
      schema: ORPHAN_OUTPUT,
      render(_args, value) {
        const lines = value.orphans.length === 0
          ? ['No orphan projection-cache rows.']
          : value.orphans.map(orphan => `${orphan.sessionId}  ${Math.round(orphan.bytes / 1024)} KB`)
        lines.push(value.removed === 0 ? 'Nothing removed.' : `Removed ${value.removed} row(s).`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const orphans = await findOrphanCacheRows()
      let removed = 0
      if (args?.dry_run !== true) {
        for (const orphan of orphans) {
          try {
            await rm(orphan.path, { force: true })
            removed += 1
          } catch {
            // Leave it for the next run.
          }
        }
      }
      return { orphans: orphans.map(orphan => ({ sessionId: orphan.sessionId, bytes: orphan.bytes })), removed }
    },
  })
}
