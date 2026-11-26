/**
 * Regression harness for the recycle bin, run against a throwaway DSH_HOME.
 *
 * It drives the plugin through the same tool definitions the Host registers, so
 * a change to the move/restore/purge order or the on-disk layout fails here
 * instead of in the person's sidebar.
 *
 * Usage: ELECTRON_RUN_AS_NODE=1 <node> test/trash.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_ID = 'session-test-0001'
const BUCKET = '--E-Projects-demo--'
const CWD = 'E:\\Projects\\demo'
const CREATED_AT = 1_700_000_000_000
const LAST_PROMPT_AT = 1_700_000_100_000

/** Create the throwaway home with one stored Session in it. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-trash-test-'))
  const sessionDir = join(home, 'sessions', BUCKET, SESSION_ID)
  await mkdir(sessionDir, { recursive: true })
  const header = { type: 'session', version: 4, id: SESSION_ID, createdAt: CREATED_AT, cwd: CWD, isSeeded: false, delegationDepth: 0 }
  await writeFile(join(sessionDir, 'session.v4.jsonl'), `${JSON.stringify(header)}\n`, 'utf8')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${SESSION_ID}.json`), JSON.stringify({
    version: 7,
    record: {
      identity: { id: SESSION_ID, cwd: CWD, createdAt: CREATED_AT },
      rows: {
        title: { ver: 1, seq: 9, val: '演示会话' },
        sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: LAST_PROMPT_AT } },
        sessionStats: { ver: 1, seq: 9, val: { turns: 3 } },
        tokenUsage: { ver: 1, seq: 9, val: { totals: { outputTokens: 1234 } } },
        modelSelection: { ver: 1, seq: 9, val: { lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } } },
      },
    },
  }), 'utf8')
  return home
}

/** Register the plugin on a minimal Context and return its tools by name. */
async function loadPlugin() {
  const module = await import('../index.js')
  const tools = new Map()
  const provided = {}
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition) } },
    provide(name, value) { provided[name] = value; return () => {} },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    reflect: { get() { return undefined } },
    waterfall: async () => [],
    parallel: async () => {},
    emit() {},
    inject() {},
  }
  module.apply(ctx)
  // Expose the Remote service the same way the Gateway would reach it.
  tools.provided = provided
  return tools
}

/** Run one tool and return its value. */
async function run(tools, name, args) {
  const definition = tools.get(name)
  assert.ok(definition !== undefined, `missing tool ${name}`)
  return definition.execute(args ?? {})
}

/** One labelled check. */
const checks = []
function check(label, fn) {
  checks.push({ label, fn })
}

const home = await fixture()
process.env.DSH_HOME = home
const tools = await loadPlugin()
const bin = join(home, 'session-trash')
const sessionDir = join(home, 'sessions', BUCKET, SESSION_ID)
const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', `${SESSION_ID}.json`)

check('bin starts empty', async () => {
  const entries = await run(tools, 'list_session_trash')
  assert.deepEqual(entries.entries, [])
})

check('trash moves the log, parks the cache and records facts', async () => {
  const value = await run(tools, 'trash_session', { session_id: SESSION_ID })
  assert.equal(value.trashed, true)
  assert.equal(existsSync(sessionDir), false, 'log directory should be gone')
  assert.equal(existsSync(join(bin, SESSION_ID, 'session.v4.jsonl')), true, 'log should be in the bin')
  assert.equal(existsSync(join(bin, SESSION_ID, '.projcache.json')), true, 'cache should be parked')
  assert.equal(existsSync(cacheFile), false, 'cache should leave the storage unit')
  const index = JSON.parse(await readFile(join(bin, 'index.json'), 'utf8'))
  assert.equal(index.entries[SESSION_ID].title, '演示会话')
  assert.equal(index.entries[SESSION_ID].turns, 3)
  assert.equal(index.entries[SESSION_ID].outputTokens, 1234)
})

check('list reports the title and the facts', async () => {
  const value = await run(tools, 'list_session_trash')
  assert.equal(value.entries.length, 1)
  const [entry] = value.entries
  assert.equal(entry.sessionId, SESSION_ID)
  assert.equal(entry.title, '演示会话')
  assert.equal(entry.cwd, CWD)
  assert.equal(entry.turns, 3)
  assert.equal(entry.model, 'deepseek-flash')
  assert.ok(entry.bytes > 0, 'size should be measured')
  assert.ok(entry.createdAt === CREATED_AT, 'createdAt should come from the header')
})

check('a directory that vanished drops its index row', async () => {
  await rm(join(bin, SESSION_ID), { recursive: true, force: true })
  const value = await run(tools, 'list_session_trash')
  assert.deepEqual(value.entries, [], 'ghost rows must not be listed')
  const index = JSON.parse(await readFile(join(bin, 'index.json'), 'utf8'))
  assert.equal(index.entries[SESSION_ID], undefined, 'the stale row should be pruned')
})

check('restore puts the log and the cache back', async () => {
  // Put the Session back in the bin by hand: the prune above removed the row.
  await mkdir(join(bin, SESSION_ID), { recursive: true })
  await writeFile(join(bin, SESSION_ID, 'session.v4.jsonl'), `${JSON.stringify({ type: 'session', version: 4, id: SESSION_ID, createdAt: CREATED_AT, cwd: CWD })}\n`, 'utf8')
  await writeFile(join(bin, SESSION_ID, '.projcache.json'), JSON.stringify({ record: { rows: { title: { seq: 9, val: '演示会话' } } } }), 'utf8')
  await writeFile(join(bin, 'index.json'), JSON.stringify({ entries: { [SESSION_ID]: { sessionId: SESSION_ID, bucket: BUCKET, cwd: CWD, title: '演示会话', deletedAt: new Date().toISOString(), bytes: 10 } } }), 'utf8')
  const value = await run(tools, 'restore_session', { session_id: SESSION_ID })
  assert.equal(value.restored, true)
  assert.equal(existsSync(join(sessionDir, 'session.v4.jsonl')), true, 'log should be back')
  assert.equal(existsSync(cacheFile), true, 'cache should be back')
  assert.equal(existsSync(join(bin, SESSION_ID)), false, 'bin entry should be gone')
})

check('purge frees a trashed Session and forgets it', async () => {
  await run(tools, 'trash_session', { session_id: SESSION_ID })
  const value = await run(tools, 'purge_session', { session_id: SESSION_ID })
  assert.equal(value.purged, true)
  assert.equal(existsSync(join(bin, SESSION_ID)), false, 'bin directory should be gone')
  const index = JSON.parse(await readFile(join(bin, 'index.json'), 'utf8'))
  assert.equal(index.entries[SESSION_ID], undefined)
})

check('batch moves several Sessions and reports one outcome each', async () => {
  const ids = ['session-test-0002', 'session-test-0003']
  for (const id of ids) {
    const dir = join(home, 'sessions', BUCKET, id)
    await mkdir(dir, { recursive: true })
    const header = { type: 'session', version: 4, id, createdAt: CREATED_AT, cwd: CWD }
    await writeFile(join(dir, 'session.v4.jsonl'), `${JSON.stringify(header)}\n`, 'utf8')
  }
  const service = tools.provided.sessionTrash
  assert.ok(service !== undefined, 'the Remote service should be provided')
  const trashed = await service.batch('trash', ids)
  assert.equal(trashed.results.length, 2)
  assert.ok(trashed.results.every(result => result.ok === true), 'both should move')
  for (const id of ids) {
    assert.equal(existsSync(join(bin, id)), true, `${id} should be in the bin`)
    assert.equal(existsSync(join(home, 'sessions', BUCKET, id)), false, `${id} should leave sessions/`)
  }
  const restored = await service.batch('restore', ids)
  assert.ok(restored.results.every(result => result.ok === true), 'both should restore')
  for (const id of ids) {
    assert.equal(existsSync(join(home, 'sessions', BUCKET, id, 'session.v4.jsonl')), true, `${id} should be back`)
  }
})

check('batch reports a failure without stopping the rest', async () => {
  const service = tools.provided.sessionTrash
  // The previous check restored both, so put one back in the bin first.
  await service.batch('trash', ['session-test-0002'])
  const outcome = await service.batch('purge', ['session-does-not-exist', 'session-test-0002'])
  assert.equal(outcome.results.length, 2)
  assert.equal(outcome.results[0].ok, false, 'the unknown id should fail')
  assert.equal(outcome.results[1].ok, true, 'the known id should still be purged')
  assert.equal(existsSync(join(bin, 'session-test-0002')), false, 'the purged directory should be gone')
})

let failed = 0
for (const { label, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}
await rm(home, { recursive: true, force: true })
console.log(failed === 0 ? `\nall ${checks.length} checks passed` : `\n${failed} of ${checks.length} checks failed`)
process.exit(failed === 0 ? 0 : 1)
