/**
 * GET /api/ping  —— 存活探测
 *
 * 前端在音乐页挂载时先打这个，决定「在线曲库」这一块要不要显示。
 * 故意做得极轻：不碰上游、不碰缓存，只要 Worker 起来了就有响应。
 *
 * 也顺便回报一下版本和限流配置，排查「线上为什么搜不到」时有用。
 */

import { json } from '../_lib/reply.js'

export async function onRequestGet() {
  return json({
    ok: true,
    service: 'netease-relay',
    version: '1.0.0',
    /* 这里只有能力声明，不暴露任何上游凭证 */
    features: { search: true, lyric: true, url: true, stream: true },
    /* 前端可以据此提示「这是线上中转」还是「本地中转」 */
    runtime: 'cloudflare-pages',
  })
}
