/* ============================================================================
 *  reply.js —— 统一响应 + 边缘缓存 + CORS
 *
 *  为什么要自己包一层缓存：
 *  Worker 的 isolate 随时会被回收，模块级 Map 活不过几分钟（这点和本地
 *  server/netease-proxy.mjs 完全不同 —— 那边是长驻进程，Map 缓存真有用）。
 *  所以这里一律用 Cache API：缓存存在 Cloudflare 边缘，跨 isolate、跨请求都在。
 *
 *  缓存 TTL 用 Cache-Control 表达：Cache API 就是读这个头。给浏览器看的值
 *  和给边缘看的是同一个，所以直链那 20 分钟有效期要在这里一次性算准。
 * ==========================================================================*/

const ALLOWED = '*' // ← 想收紧就把这里换成主站域名，例如 'https://amoyba.pages.dev'

export function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    ...extra,
  }
}

export function json(data, { status = 200, maxAge = 0, extra = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
      ...cors(),
      ...extra,
    },
  })
}

/** 查询参数里的正整数，带上下限 */
export function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 带边缘缓存的 GET。
 *
 * @param context Pages Functions 的 context（拿 caches / waitUntil）
 * @param maxAge 秒。0 表示不缓存
 * @param produce () => Promise<{ body, status, cache?: boolean }>
 *        cache=false 可以让失败结果不进缓存（比如上游抽风时别把错误钉住 10 分钟）
 */
export async function cached(context, maxAge, produce) {
  const req = context.request
  const cache = typeof caches !== 'undefined' ? caches.default : null

  /* 只有 GET 走缓存。注意 Cache API 的 key 是完整 URL，query 不同就是不同的条目。 */
  if (maxAge > 0 && cache && req.method === 'GET') {
    const hit = await cache.match(req)
    if (hit) {
      /* 加个标记，方便在浏览器 Network 里一眼看出命中了边缘缓存 */
      const res = new Response(hit.body, hit)
      res.headers.set('X-Relay-Cache', 'HIT')
      return res
    }
  }

  const out = await produce()

  /* ★ 失败结果连浏览器的 Cache-Control 也要一起关掉。
     只跳过 Cache API 的 put 是不够的：json() 仍然会带上 max-age=840，
     浏览器自己就把这份「取不到地址」缓存十四分钟，用户点几次重试都没用。 */
  const cacheable = out.cache !== false
  const res = json(out.body, { status: out.status || 200, maxAge: cacheable ? maxAge : 0 })

  if (maxAge > 0 && cacheable && cache) {
    const toCache = res.clone()
    context.waitUntil(cache.put(req, toCache))
    res.headers.set('X-Relay-Cache', 'MISS')
  }
  return res
}
