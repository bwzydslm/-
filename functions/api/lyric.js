/**
 * GET /api/lyric?id=
 * ---------------------------------------------------------------------------
 * 歌词（LRC 原文 + 可选翻译）。
 *
 * 缓存 30 分钟：歌词是静态的，几乎不会变，这一类最值得缓存。
 * ---------------------------------------------------------------------------
 */

import { lyricOf } from '../_lib/netease.js'
import { cached } from '../_lib/reply.js'
import { rateLimit, tooMany } from '../_lib/ratelimit.js'

const TTL = 1800

export async function onRequestGet(context) {
  const url = new URL(context.request.url)
  const id = (url.searchParams.get('id') || '').trim()

  if (!/^\d+$/.test(id)) {
    return cached(context, 0, async () => ({
      body: { ok: false, error: 'bad_id', message: 'id 必须是数字' },
      status: 400,
    }))
  }

  const rl = await rateLimit(context, 120, 120)
  if (!rl.ok) return tooMany(rl.reset)

  return cached(context, TTL, async () => {
    try {
      return { body: await lyricOf(id), status: 200 }
    } catch {
      return {
        body: { ok: false, error: 'upstream_failed', message: '取歌词失败' },
        status: 502,
        cache: false,
      }
    }
  })
}
