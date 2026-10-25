/* ============================================================================
 *  ratelimit.js —— 按 IP 的固定窗口限流
 *
 *  为什么需要：这个中转一旦上线，就是一个「任何人拿到地址都能免费打」的
 *  网易云接口代理。被爬或被人刷，消耗的是你的免费额度（10 万次/天），
 *  额度烧光就是站点静默失效。所以哪怕只是个人站，也得有个闸。
 *
 *  为什么不写在内存里：Worker 的 isolate 随时回收，内存计数会飘；
 *  而且一个 IP 的请求可能落到不同的 isolate 上，各数各的等于没限。
 *  所以要用 KV。
 *
 *  ★ 没绑 KV 时不会失败，只是限流不生效（见 README「加固」一节）。
 *    宁可让它能跑，也不要因为少一个绑定就整个 502。
 * ==========================================================================*/

/**
 * @param context Pages Functions context（拿 env 和 request）
 * @param {number} limit 窗口内允许的次数
 * @param {number} windowSec 窗口秒数
 * @returns {Promise<{ ok: boolean, remaining: number, reset: number }>}
 */
export async function rateLimit(context, limit, windowSec) {
  const { env, request } = context
  const kv = env && env.RL

  /* 没绑 KV：直接放行，绝不因为缺配置就让请求挂掉 */
  if (!kv || typeof kv.get !== 'function') {
    return { ok: true, remaining: limit, reset: 0, enforced: false }
  }

  /* Cloudflare 会带 CF-Connecting-IP；本地 wrangler dev 可能只有 X-Forwarded-For */
  const ip =
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'

  /* 窗口按「当前时间整除窗口长度」切，天然对齐，不需要额外存窗口起点 */
  const bucket = Math.floor(Date.now() / 1000 / windowSec)
  const key = `rl:${ip}:${bucket}`

  try {
    const raw = await kv.get(key)
    const used = raw ? parseInt(raw, 10) || 0 : 0

    if (used >= limit) {
      const reset = (bucket + 1) * windowSec
      return { ok: false, remaining: 0, reset, enforced: true }
    }

    /* 计数写回。KV 的写有延迟（最终一致），所以这是个「近似限流」：
       短时间并发打进来可能多放过几次，但对「别把人刷爆」这个目的足够了。 */
    await kv.put(key, String(used + 1), { expirationTtl: Math.max(60, windowSec) })
    return { ok: true, remaining: limit - used - 1, reset: (bucket + 1) * windowSec, enforced: true }
  } catch {
    /* KV 自己出问题时放行：限流是加固手段，不该成为单点故障 */
    return { ok: true, remaining: limit, reset: 0, enforced: false }
  }
}

/** 超限时的标准回复 */
export function tooMany(reset) {
  return new Response(
    JSON.stringify({
      ok: false,
      error: 'rate_limited',
      message: '请求太频繁了，歇一会儿再试。',
      retryAfter: reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60),
        'Access-Control-Allow-Origin': '*',
      },
    }
  )
}
