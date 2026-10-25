/**
 * GET /api —— 索引页（顺便当健康检查）
 * ---------------------------------------------------------------------------
 * 这个中转的域名是公开的，谁拿到都可能来敲一下。与其让它看起来像
 * 一个可以随便刷的开放 API，不如直接把「这是个人自用、别刷」写在首页。
 */

import { json } from '../_lib/reply.js'

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin

  return json({
    ok: true,
    service: 'netease-relay',
    version: '1.0.0',
    note: '个人站点自用的小中转，别拿来刷。',
    endpoints: {
      ping: origin + '/api/ping',
      search: origin + '/api/search?q=夜曲&limit=24&offset=0',
      lyric: origin + '/api/lyric?id=<歌曲ID>',
      url: origin + '/api/url?id=<歌曲ID>&level=exhigh',
      stream: origin + '/api/stream?id=<歌曲ID>&level=exhigh',
    },
    levels: ['standard', 'higher', 'exhigh', 'lossless'],
  })
}
