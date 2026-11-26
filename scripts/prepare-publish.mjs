#!/usr/bin/env node
/**
 * Point the package at the name it will be published under.
 *
 * The marketplace and npm both key on the package name, and this bundle keeps it
 * in three places: the manifest, the bundle patch's `name`, and the market index
 * entry. This rewrites all three at once so they cannot drift.
 *
 * Usage: node scripts/prepare-publish.mjs @your-scope/dsh-session-trash
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const name = process.argv[2]

if (name === undefined || name.length === 0) {
  console.error('usage: node scripts/prepare-publish.mjs <package-name>')
  process.exit(1)
}
if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name)) {
  console.error(`not a publishable npm name: ${name}`)
  process.exit(1)
}

/** Rewrite one file's package-name occurrences. */
function rewrite(relative, apply) {
  const path = join(root, relative)
  const before = readFileSync(path, 'utf8')
  const after = apply(before)
  if (after === before) {
    console.log(`unchanged ${relative}`)
    return
  }
  writeFileSync(path, after, 'utf8')
  console.log(`updated   ${relative}`)
}

rewrite('package.json', text => {
  const manifest = JSON.parse(text)
  manifest.name = name
  return `${JSON.stringify(manifest, null, 2)}\n`
})
rewrite('cordis.patch.yml', text => text.replace(/name:\s*'[^']*'/u, `name: '${name}'`))
// The browser bundle registers itself under an id the loader must match, so it
// has to follow the package name too.
rewrite('client.js', text => text.replace(
  /(__ModuleLoader__\.load\(\{\s*id:\s*')[^']*(')/u,
  `$1${name}$2`,
))
rewrite('market/index.json', text => {
  const index = JSON.parse(text)
  index.plugins[0].name = name
  return `${JSON.stringify(index, null, 2)}\n`
})

console.log(`\npackage name is now ${name}`)
console.log('next: npm publish --access public')
