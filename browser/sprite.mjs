// Companion sprite plumbing: drop the custom sticker server-side. Pure-ish helper
// only — no React, no component state. The caller owns the note the panel shows.
const { API } = require('./util.mjs')

/** Drop the custom sticker server-side; resolves the fallback URL. */
async function deleteSprite(gender) {
  const route = gender === 'male' ? 'sprite-male' : 'sprite'
  const res = await fetch(API + route, { method: 'DELETE' })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return data.url || ''
}

module.exports = { deleteSprite }