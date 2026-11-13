// browser/build.mjs — zero-dependency mini bundler for the browser half.
//
// The DSH web host serves exactly ONE built bundle per package at
// `/plugins/<id>/client.js` (see deepseek-harness docs/subsystems/client-modules.md),
// so this plugin is *developed* as small modules under browser/ and *shipped* as the
// generated client.js. Never hand-edit client.js; edit browser/ and run:
//
//     npm run build:client
//
// Module format inside browser/: plain JavaScript, CJS-style
// `require('./sibling.mjs')` + `module.exports`, no ESM syntax, no JSX.
// `require('react')` (and any other non-relative id) is delegated to the host loader.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REQ_RE = /require\('(\.[^']+)'\)/g

function keyOf(fromKey, spec) {
  return './' + path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), spec.slice(2)))
}

/** Collect the module graph reachable from `entryKey` (keys relative to browser/). */
export async function collectModules(entryKey = './entry.mjs') {
  const sources = new Map()
  const deps = new Map()
  async function load(key) {
    if (sources.has(key)) return
    const file = path.join(HERE, key.slice(2))
    const src = await readFile(file, 'utf8')
    const list = []
    for (const m of src.matchAll(REQ_RE)) {
      const dep = keyOf(key, m[1])
      if (!list.includes(dep)) list.push(dep)
    }
    sources.set(key, src)
    deps.set(key, list)
    for (const dep of list) await load(dep)
  }
  await load(entryKey)
  return { sources, deps }
}

/** Post-order so every dependency is defined before its dependents. */
export function emitOrder(entryKey, deps) {
  const order = []
  const seen = new Set()
  const walk = (key) => {
    if (seen.has(key)) return
    seen.add(key)
    for (const dep of deps.get(key) || []) walk(dep)
    order.push(key)
  }
  walk(entryKey)
  return order
}

/** The `__def(...)` table + local require, as source text. */
export function moduleTableSource(entryKey, sources, deps, name = 'client') {
  const order = emitOrder(entryKey, deps)
  const parts = []
  for (const key of order) {
    parts.push('__def(' + JSON.stringify(key) + ', function (module, exports, require) {\n' + sources.get(key) + '\n});')
  }
  return [
    '    const __table = new Map()',
    '    const __cache = new Map()',
    '    const __def = (id, fn) => { __table.set(id, fn) }',
    '    const __key = (base, id) => {',
    "      const parts = (base + '/' + id.slice(2)).split('/')",
    '      const stack = []',
    '      for (const part of parts) {',
    "        if (part === '' || part === '.') continue",
    "        if (part === '..') stack.pop()",
    '        else stack.push(part)',
    '      }',
    "      return './' + stack.join('/')",
    '    }',
    '    function __makeRequire(base) {',
    '      return function require(id) {',
    "        if (!id.startsWith('.')) return hostRequire(id)",
    '        const key = __key(base, id)',
    '        const hit = __cache.get(key)',
    '        if (hit) return hit.exports',
    '        const fn = __table.get(key)',
    '        if (!fn) throw new Error(' + JSON.stringify(name + ': unknown client module ') + ' + id)',
    '        const mod = { exports: {} }',
    '        __cache.set(key, mod)',
        "        fn(mod, mod.exports, __makeRequire(key.slice(2).split('/').slice(0, -1).join('/')))",
    '        return mod.exports',
    '      }',
    '    }',
    ...parts,
  ].join('\n')
}

export async function bundleSource(entryKey = './entry.mjs') {
  const { sources, deps } = await collectModules(entryKey)
  // The bundle id is the plugin's identity to the host module loader, so it must be the
  // package name. Hardcoding it here once made the id survive a package rename, and DSH
  // then died with "duplicate factory registration" because the package mounted as
  // `dsh-plugin-whale-soulmate` while the bundle registered as `dsh-plugins-soulmate`.
  const pkg = JSON.parse(await readFile(path.join(HERE, '..', 'package.json'), 'utf8'))
  return [
    '/**',
    ' * GENERATED FILE — do not hand-edit.',
    ' * Sources live in browser/; rebuild with `npm run build:client`.',
    ' */',
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(pkg.name) + ',',
    '  factory(hostRequire) {',
    moduleTableSource(entryKey, sources, deps, pkg.name),
    "    return __makeRequire('')('" + entryKey + "')",
    '  },',
    '})',
    '',
  ].join('\n')
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (direct) {
  const bundle = await bundleSource()
  await writeFile(path.join(HERE, '..', 'client.js'), bundle, 'utf8')
  console.log('client.js rebuilt:', bundle.split('\n').length, 'lines')
}
