/**
 * GET /api/url?id=&level=
 * ---------------------------------------------------------------------------
 * 取播放直链（前端拿到之后自己塞给 <audio src>）。
 *
 * 这里必须做「参数化缓存」：直链约 20 分钟过期，而 Cache-Control 决定
 * 边缘缓存多久。所以 TTL = expi × 0.7，留出余量 —— 宁可多问一次上游，
 * 也不要给浏览器一个快过期的地址（那样播到一半会 403）。
 *
 * 失败结果只给 30 秒缓存（甚至不缓存）：上游的 -110 有时是临时的，
 * 钉住十分钟会让用户以为这首歌永远放不了。
 * ---------------------------------------------------------------------------
 */

import { streamUrlOf } from '../_lib/netease.js'
import { cached } from '../_lib/reply.js'
import { rateLimit, tooMany } from '../_lib/ratelimit.js'

const LEVELS = new Set(['standard', 'higher', 'exhigh', 'lossless'])

export async function onRequestGet(context) {
  const url = new URL(context.request.url)
  const id = (url.searchParams.get('id') || '').trim()
  const level = LEVELS.has(url.searchParams.get('level')) ? url.searchParams.get('level') : 'exhigh'

  if (!/^\d+$/.test(id)) {
    return cached(context, 0, async () => ({
      body: { ok: false, error: 'bad_id', message: 'id 必须是数字' },
      status: 400,
    }))
  }

  const rl = await rateLimit(context, 120, 120)
  if (!rl.ok) return tooMany(rl.reset)

  /* 先按一个保守的 TTL 缓存；拿到真实 expi 之后没法再改 Cache-Control，
     所以这里用「上游默认 expi=1200」折算的保守值：840 秒。
     换歌、重播频繁时好处是明显的：同一首连点几次只打一次上游。 */
  const TTL = 840

  return cached(context, TTL, async () => {
    try {
      const out = await streamUrlOf(id, level)
      if (!out.ok) {
        /* 失败不进缓存的常规路径走不通（cached 只在成功时看 cache 标记），
           这里直接降级成 200 + ok:false，让前端按业务错误处理 ——
           用 4xx 的话前端 fetch 会抛，反而得多写一层 try。 */
        return { body: out, status: 200, cache: false }
      }
      return { body: out, status: 200 }
    } catch {
      return {
        body: { ok: false, error: 'upstream_failed', message: '取播放地址失败' },
        status: 502,
        cache: false,
      }
    }
  })
}
