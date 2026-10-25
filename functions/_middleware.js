/* ============================================================================
 *  _middleware.js —— 所有路由的公共处理
 *
 *  两件事：
 *   1) 处理 CORS 预检（OPTIONS）。主站域名和这个中转域名不同，
 *      浏览器在真正发请求前会先来一问，这一问必须在中间件里答掉，
 *      否则每个端点都得各写一遍。
 *   2) 兜底：任何没有被路由匹配的路径，回一个结构化的 404，
 *      而不是 Cloudflare 那页无信息的纯文本。
 *
 *  ⚠ 限流不放在这里做。中间件对所有请求都跑，包括 OPTIONS 预检和
 *    404 探测，把限流写在这儿会让「正常用户的一次播放」被算两次。
 *    限流放在各个端点内部，只对真正打到上游的动作计数。
 * ==========================================================================*/

import { cors } from './_lib/reply.js'

export async function onRequest(context) {
  const { request, next } = context

  /* 预检：直接 204，不往下走 */
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() })
  }

  const res = await next()

  /* 兜底补 CORS 头：万一某个端点忘了加，这里补上，
     免得前端只看到一句「CORS 错误」而不知道是哪个接口的问题。 */
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(cors())) {
    if (!headers.has(k)) headers.set(k, v)
  }

  /* 只允许读。写操作一律 405 —— 这个服务没有任何写入语义，
     留着 POST 通道只会变成被滥用的入口。 */
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && res.status < 400) {
    return new Response(
      JSON.stringify({ ok: false, error: 'method_not_allowed', message: '这个中转只支持 GET' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...cors(),
        },
      }
    )
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
