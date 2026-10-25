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

export async function searchSongs(q, limit, offset) {
  const r = await ne(
    `/api/cloudsearch/pc?s=${encodeURIComponent(q)}&type=1&limit=${limit}&offset=${offset}`
  )
  const songs = (r.json && r.json.result && r.json.result.songs) || []
  const total = (r.json && r.json.result && r.json.result.songCount) || songs.length
  return { ok: true, items: songs.map(toTrack), total }
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
