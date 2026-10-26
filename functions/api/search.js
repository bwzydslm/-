/**
 * GET /api/search?q=&limit=&offset=
 * ---------------------------------------------------------------------------
 * 在线搜索。前端 350ms 防抖之后打这里。
 *
 * 缓存 10 分钟：同一个搜索词反复打是很常见的（比如反复点同一首歌），
 * 缓存能省掉绝大部分上游请求，也让「额度」经得起用。
 * ---------------------------------------------------------------------------
 */

import { searchSongs } from '../_lib/netease.js'
import { cached, intParam } from '../_lib/reply.js'
import { rateLimit, tooMany } from '../_lib/ratelimit.js'

const TTL = 600 // 秒

export async function onRequestGet(context) {
  const url = new URL(context.request.url)
  const q = (url.searchParams.get('q') || '').trim()

  if (!q) {
    return cached(context, 0, async () => ({
      body: { ok: false, error: 'empty_query', message: '搜索词不能为空' },
      status: 400,
    }))
  }

  /* 搜索比取直链便宜，限流给宽一点：2 分钟 60 次 */
  const rl = await rateLimit(context, 60, 120)
  if (!rl.ok) return tooMany(rl.reset)

  const limit = intParam(url, 'limit', 24, 1, 50)
  const offset = intParam(url, 'offset', 0, 0, 1000)

  return cached(context, TTL, async () => {
    try {
      const out = await searchSongs(q, limit, offset)
      /* ★ 空结果不缓存。上游偶尔会「正常返回 200 但 songs 为空」——
         风控限速、索引抖动都会这样。这是临时状态，钉十分钟的代价是
         用户搜同一个词十分钟内全是空，看起来像「这个站搜不到歌」。 */
      const empty = !out.items || out.items.length === 0
      return { body: out, status: 200, cache: !empty }
    } catch (e) {
      /* 上游挂掉时不要把错误缓存住，否则 10 分钟内都是同一个错误 */
      return {
        body: {
          ok: false,
          error: 'upstream_failed',
          message: '上游接口没响应，稍后再试。',
        },
        status: 502,
        cache: false,
      }
    }
  })
}
