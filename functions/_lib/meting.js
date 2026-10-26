/* ============================================================================
 *  meting.js —— 用第三方 Meting 镜像取播放直链
 *
 *  ── 为什么需要这层兜底 ────────────────────────────────────────────────
 *  网易云取直链的接口 /api/song/enhance/player/url/v1 会判地域：
 *  从境外 IP 发起时 data[0].url 一律为 null（dcode 404）。而 Cloudflare
 *  没有中国大陆节点，Pages Functions 跑在 LAX/HKG 这些地方 —— 于是线上
 *  表现成「搜索能出结果、点播放取不到地址」。
 *
 *  试过伪造 X-Real-IP（本地有效），但在 Cloudflare 边缘上 10 种头组合
 *  全部 dcode 404 —— 上游拦的是真实连接 IP，不是那个头。这条路死了。
 *
 *  Meting 是 APlayer 生态里的一个老项目：它自己在服务端调网易云、算出
 *  直链，然后 302 跳过去。我们借它的「国内出口 IP」来拿那个地址。
 *
 *  ── 它给回来的东西 ────────────────────────────────────────────────────
 *    https://api.xxx/meting/?server=netease&type=url&id=<歌曲ID>
 *      → 302 Location: https://m802.music.126.net/....mp3   （完整曲，可 Range）
 *      → 拿不到时返回 200 且没有 Location（不是 4xx，要按「无 Location」判失败）
 *
 *  ── 代价 ──────────────────────────────────────────────────────────────
 *  这是别人的免费服务：随时可能挂、限速、改参数，也拿不到 br/expi 这些
 *  元数据（所以下面一律给保守值）。所以它只做「官方接口失败后的兜底」，
 *  不做主路径 —— 官方能拿到时就不用它。
 * ==========================================================================*/

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/* 顺序 = 优先级。实测两者都能用，但 qijieya 给的是完整曲（约 320k，
   13MB 左右），injahow 有时只给 721KB 的试听片段 —— 所以 qijieya 排前面。 */
const MIRRORS = ['https://api.qijieya.cn/meting/', 'https://api.injahow.cn/meting/']

/* 单个镜像的超时。镜像本身要是卡住，不能让整个 /api/url 也卡 12 秒。 */
const MIRROR_TIMEOUT = 8000

function signal(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined
  }
}

/**
 * 问一个镜像要直链。
 * 返回 Location（http/https），失败返回 ''。
 *
 * redirect: 'manual' —— 关键是别让 Worker 真的去下载音频：
 * 我们要的只是那行 Location，body 由用户浏览器自己拉。
 */
async function resolveOne(base, id) {
  const target = base + '?server=netease&type=url&id=' + encodeURIComponent(id)
  const res = await fetch(target, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: signal(MIRROR_TIMEOUT),
  })

  /* 有些镜像不返回 302，而是直接回音频字节（Content-Type: audio/*）。
     那种情况下 res.url 就是目标地址，但 body 已经在流了 —— 不取 body，
     直接放弃这一个镜像，让下一个来。 */
  const loc = res.headers.get('Location') || ''
  if (!loc) return ''

  /* 必须是 http(s)：镜像偶尔会回相对路径或怪协议，直接当失败 */
  if (!/^https?:\/\//i.test(loc)) return ''

  /* 网易云 CDN 给的常是 http，https 页面里会被当混合内容拦掉，统一换协议 */
  return loc.replace(/^http:/i, 'https:')
}

/**
 * 依次问各镜像，第一个成功的就用。
 *
 * 返回和 netease.js 的 streamUrlOf 同构，调用方不需要区分来源：
 *   { ok: true, url, br, size, type, expi, via }
 *   { ok: false }
 *
 * br/size 拿不到真实值：br 给 0 表示「未知」，前端只在界面上显示码率，
 * 0 就不显示（别瞎猜一个 320 上去）。
 */
export async function streamUrlViaMeting(id) {
  for (const base of MIRRORS) {
    try {
      const url = await resolveOne(base, id)
      if (!url) continue
      return {
        ok: true,
        url,
        br: 0,
        size: 0,
        type: 'mp3',
        /* 直链的时效由网易云 CDN 决定，镜像不透传 expi。
           按官方接口的老规矩给 1200 秒，缓存层自己再打折。 */
        expi: 1200,
        via: new URL(base).host,
      }
    } catch {
      /* 这个镜像挂了/超时，换下一个。全部失败才返回 ok:false */
    }
  }
  return { ok: false }
}
