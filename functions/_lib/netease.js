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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com/'
const GUEST_COOKIE = 'os=pc; appver=8.9.70; channel=netease; __csrf='

/* ---- 为什么要伪造国内出口 IP ----------------------------------------------
 * 取播放直链的接口 /api/song/enhance/player/url/v1 会做地域判断：
 * 从境外 IP 发起时一律返回 data[0].url = null（dcode 404/-110），
 * 于是「搜索能出结果、点播放却拿不到地址」。
 *
 * Cloudflare 没有中国大陆节点，Pages Functions 实际跑在 HK / JP / SG / US，
 * 边缘出口 IP 全在境外 —— 这就是线上 /api/url 全部失败的真正原因。
 * 本机（国内家庭宽带）直连同一接口完全正常，所以之前一直以为代码有问题。
 *
 * 实测：请求里带一个国内 IP 的 X-Real-IP，dcode 立刻回到 200 且带 url；
 * 换成 8.8.8.8 则继续拿不到 —— 说明上游确实按这个头判地域。
 * 搜索 / 歌词接口不受影响（带不带都正常），但统一带上也无害。
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
 * 先问 v1 接口（带 level，能给高品质），不行退回老接口。
 * 拿不到时把上游 code 翻译成人话 —— code=-110 是「要登录/要付费」，
 * 这是最常见的一种，直接说清楚比让用户猜要好。
 */
export async function streamUrlOf(id, level) {
  let data = null

  try {
    const r = await ne(
      `/api/song/enhance/player/url/v1?ids=[${id}]&level=${level}&encodeType=mp3`
    )
    data = (r.json && r.json.data && r.json.data[0]) || null
  } catch {
    data = null
  }

  if (!data || !data.url) {
    try {
      const r2 = await ne(`/api/song/enhance/player/url?ids=[${id}]&br=320000`)
      data = (r2.json && r2.json.data && r2.json.data[0]) || data
    } catch {
      /* 保持原样，下面统一报错 */
    }
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
