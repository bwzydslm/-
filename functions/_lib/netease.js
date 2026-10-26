/* ============================================================================
 *  netease.js —— 网易云上游接口（Cloudflare Workers / Pages Functions 版）
 *
 *  和 server/netease-proxy.mjs 的区别：
 *    那边是 node:http 的本地小服务，靠内存 Map 缓存；
 *    这边是 Web 标准（Request/Response），缓存交给 Cache API —— 因为 Worker
 *    的 isolate 随时会被回收，内存里的 Map 活不过几分钟，等于没有缓存。
 *
 *  上游为什么必须带 UA / Referer / Cookie：
 *    music.163.com 的公开接口对这几个头有要求，不带会拿到空结果或者 128k 试听流。
 *    GUEST_COOKIE 里没有 MUSIC_U（没有登录态），但有 os=pc / appver 这几个字段，
 *    足以让接口按「PC 客户端」返回 320k 地址。这就是不登录也能听的原因，
 *    也是为什么 VIP 版权曲（fee=1）拿不到 —— 那些必须要账号。
 * ==========================================================================*/

import { streamUrlViaMeting } from './meting.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com/'
const GUEST_COOKIE = 'os=pc; appver=8.9.70; channel=netease; __csrf='

/* ---- 关于伪造国内出口 IP（已证伪，仅本地有效）------------------------------
 * 取播放直链的接口 /api/song/enhance/player/url/v1 会做地域判断：
 * 从境外 IP 发起时一律返回 data[0].url = null（dcode 404/-110），
 * 于是「搜索能出结果、点播放却拿不到地址」。
 *
 * 曾经以为带 X-Real-IP 就能解决 —— 在本机（国内宽带）确实是：
 * 带 114.114.114.114 → 200 有 url，带 8.8.8.8 → 404 无 url。
 *
 * 但在 Cloudflare 上做了 10 种头组合的对照实验（/api/diag 那次），
 * 全部 dcode 404，加不加 X-Real-IP 毫无区别 —— 说明上游判的是
 * **真实连接 IP**，这个头只在「本机 → 上游」这条链路上被采信。
 *
 * 所以线上取直链只能靠 meting.js 那层镜像兜底，这个头留着无害
 * （本地调中转时还能少走一次兜底），别指望它救线上。
 *
 * 这里只是声明「请求来自中国大陆」，不代表任何真实用户身份：
 * 下面所有接口都是游客（无 MUSIC_U 登录态），拿到的仍是非 VIP 的那一份。
 * --------------------------------------------------------------------------*/
const CN_IP = '114.114.114.114'

/* Worker 里 AbortSignal.timeout 有，但老 compat date 可能没有，兜一层 */
function signal(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined
  }
}

/**
 * 抓一个上游 JSON。
 * 上游偶尔会返回 HTML（风控页），这时 json 为 null，由调用方当失败处理。
 */
export async function ne(path, { timeout = 12000 } = {}) {
  const url = path.startsWith('http') ? path : 'https://music.163.com' + path
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: REFERER,
      Cookie: GUEST_COOKIE,
      Accept: 'application/json, text/plain, */*',
      'X-Real-IP': CN_IP,
    },
    signal: signal(timeout),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON，交给调用方判断 */
  }
  return { status: res.status, json, text }
}

/* -------------------------------------------------------------- 归一化 */

/** 把上游的一首歌压成前端认识的最小结构。字段名别改，前端在线曲目靠它对上。 */
export function toTrack(s) {
  const ar = (s.ar || s.artists || []).map((a) => a.name).filter(Boolean)
  const al = s.al || s.album || {}
  let cover = al.picUrl || al.picUrl_str || ''
  if (cover) {
    /* 上游给的是 http，https 页面里混用会被拦，统一换协议 */
    cover = cover.replace(/^http:/, 'https:')
    if (!/\?/.test(cover)) cover += '?param=240y240'
  }
  return {
    relayId: String(s.id),
    name: s.name || '未命名',
    artist: ar.join(' / ') || '未知歌手',
    album: al.name || '',
    /* dt 是毫秒，前端统一按秒 */
    duration: Math.round(((s.dt || s.duration || 0) / 1000) * 10) / 10,
    cover,
    fee: s.fee,
  }
}

/* ------------------------------------------------------------------ 三件事 */

/* limit / offset 必须有默认值：少传一个就会拼出 offset=undefined，
   上游对这种参数不报错，只默默返回空列表 —— 排查起来非常费劲。 */
export async function searchSongs(q, limit = 24, offset = 0) {
  const enc = encodeURIComponent(q)
  const path = `/api/cloudsearch/pc?s=${enc}&type=1&limit=${limit}&offset=${offset}`

  /* ★ 上游会「200 但 songs 为空」。这不是搜不到，是风控/索引抖动：
     同一个词前一次空、后一次有，间隔几百毫秒就恢复。所以空的要重试，
     不能把第一次的空当成结论 —— 否则用户看到的就是「搜周杰伦晴天没有歌」。 */
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(180)
    const r = await ne(path)
    const songs = (r.json && r.json.result && r.json.result.songs) || []
    if (songs.length) {
      const total = (r.json.result && r.json.result.songCount) || songs.length
      return { ok: true, items: songs.map(toTrack), total }
    }
  }

  /* 两次都空，换老接口再问一次。两个都空才算真的没有。 */
  try {
    const r2 = await ne(
      `/api/search/get/web?s=${enc}&type=1&limit=${limit}&offset=${offset}`
    )
    const s2 = (r2.json && r2.json.result && r2.json.result.songs) || []
    const total2 = (r2.json && r2.json.result && r2.json.result.songCount) || s2.length
    return { ok: true, items: s2.map(toTrack), total: total2 }
  } catch {
    /* 备用接口也挂了就按空结果返回，调用方会处理 */
    return { ok: true, items: [], total: 0 }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function lyricOf(id) {
  const r = await ne(`/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`)
  const lrc = (r.json && r.json.lrc && r.json.lrc.lyric) || ''
  const tlyric = (r.json && r.json.tlyric && r.json.tlyric.lyric) || ''
  return { ok: true, lrc, tlyric }
}

/**
 * 取播放直链。
 *
 * 三级：
 *   1) v1 接口（带 level，能给 br / expi 这些真元数据）
 *   2) 老接口（v1 抽风时它偶尔还给）
 *   3) Meting 镜像兜底 —— 见 meting.js 顶部那段：Cloudflare 边缘出口是
 *      境外 IP，1) 2) 在线上必然拿不到 url，这一级才是线上真正生效的那条。
 *
 * 顺序刻意把官方放前面：本机（国内 IP）调中转时 1) 就能成，能拿到真实的
 * br 和 expi；只有线上才一路掉到 3)。代价是线上白跑两次请求（几百毫秒），
 * 换来的是「能用真元数据就别用猜的」。
 */
export async function streamUrlOf(id, level) {
  let data = null

  /* 超时压到 6 秒：正常失败是上游秒回 404，只有卡住才会等满。
     线上「官方必失败 → 走镜像」是常态，不能让它把用户点播放的手感拖死
     （两次上游 + 两个镜像，最坏 6+6+8+8 秒）。 */
  try {
    const r = await ne(
      `/api/song/enhance/player/url/v1?ids=[${id}]&level=${level}&encodeType=mp3`,
      { timeout: 6000 }
    )
    data = (r.json && r.json.data && r.json.data[0]) || null
  } catch {
    data = null
  }

  if (!data || !data.url) {
    try {
      const r2 = await ne(`/api/song/enhance/player/url?ids=[${id}]&br=320000`, {
        timeout: 6000,
      })
      data = (r2.json && r2.json.data && r2.json.data[0]) || data
    } catch {
      /* 保持原样，下面走镜像兜底 */
    }
  }

  /* 官方两条路都没戏 → 交给 Meting 镜像。这一步在线上是常态，
     所以注释写在这里，免得以后有人以为「线上永远不调官方接口」是 bug。 */
  if (!data || !data.url) {
    const viaMirror = await streamUrlViaMeting(id)
    if (viaMirror.ok) return viaMirror
  }

  if (!data || !data.url) {
    const code = data && data.code
    const message =
      code === -110
        ? '这首歌需要登录或付费（换一首，或降低音质试试）'
        : code === 404
          ? '这首歌没有可播放的地址（可能已下架）'
          : '没有取到播放地址'
    return { ok: false, code, message }
  }

  return {
    ok: true,
    url: data.url,
    br: data.br || 0,
    size: data.size || 0,
    type: data.type || '',
    /* 直链约 20 分钟过期，这个值决定缓存多久 */
    expi: data.expi || 1200,
  }
}
