/**
 * GET /api/stream?id=&level=
 * ---------------------------------------------------------------------------
 * 302 跳到网易云直链，给 <audio src> 直接用的备选入口。
 *
 * 前端正常走 /api/url 拿地址自己管理缓存（能提前刷新、能重试）。
 * 这个端点存在的意义是：某些场景下（比如直接把地址贴进浏览器、或在
 * 不支持先取 JSON 的播放器里）需要一个「看起来像音频文件」的 URL。
 *
 * 刻意不缓存：跳转结果不值钱，缓存了反而会在直链过期后继续 302 到死链。
 * ---------------------------------------------------------------------------
 */

import { streamUrlOf } from '../_lib/netease.js'
import { json, cors } from '../_lib/reply.js'
import { rateLimit, tooMany } from '../_lib/ratelimit.js'

const LEVELS = new Set(['standard', 'higher', 'exhigh', 'lossless'])

export async function onRequestGet(context) {
  const url = new URL(context.request.url)
  const id = (url.searchParams.get('id') || '').trim()
  const level = LEVELS.has(url.searchParams.get('level')) ? url.searchParams.get('level') : 'exhigh'

  if (!/^\d+$/.test(id)) return json({ ok: false, error: 'bad_id' }, { status: 400 })

  /* 这个端点每播一次就消耗一次上游解析，限流和 /api/url 一致 */
  const rl = await rateLimit(context, 120, 120)
  if (!rl.ok) return tooMany(rl.reset)

  try {
    const got = await streamUrlOf(id, level)
    if (!got.ok) return json(got, { status: 404 })

    return new Response(null, {
      status: 302,
      headers: {
        Location: got.url,
        'Cache-Control': 'no-store',
        ...cors(),
      },
    })
  } catch {
    return json({ ok: false, error: 'upstream_failed' }, { status: 502 })
  }
}
