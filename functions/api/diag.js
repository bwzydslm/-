/* ============================================================================
 *  _diag.js —— 临时诊断端点（查完就删）
 *
 *  目的：弄清楚「本地能拿到直链、Cloudflare 上拿不到」到底是哪一步不同。
 *  同一次请求里用不同的头去打同一个上游，把上游的原始 code/url 全吐出来。
 *
 *  访问：GET /api/_diag?id=347230
 * ==========================================================================*/

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com/'
const GUEST_COOKIE = 'os=pc; appver=8.9.70; channel=netease; __csrf='
const CN_IP = '114.114.114.114'

async function probe(path, extraHeaders) {
  const url = 'https://music.163.com' + path
  let status = 0
  let text = ''
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        Cookie: GUEST_COOKIE,
        Accept: 'application/json, text/plain, */*',
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(12000),
    })
    status = res.status
    text = await res.text()
  } catch (e) {
    return { err: String(e && e.message).slice(0, 60) }
  }
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    return { status, raw: text.slice(0, 80) }
  }
  const d = (json && json.data && json.data[0]) || null
  return {
    status,
    httpCode: json && json.code,
    dcode: d && d.code,
    hasUrl: !!(d && d.url),
    br: d && d.br,
    fee: d && d.fee,
    urlHead: d && d.url ? String(d.url).slice(0, 42) : '',
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url)
  const id = (url.searchParams.get('id') || '347230').replace(/\D/g, '') || '347230'
  const v1 = (lv) => `/api/song/enhance/player/url/v1?ids=[${id}]&level=${lv}&encodeType=mp3`

  const tests = {}
  tests['A_v1_exhigh_无头'] = await probe(v1('exhigh'), {})
  tests['B_v1_exhigh_XRealIP'] = await probe(v1('exhigh'), { 'X-Real-IP': CN_IP })
  tests['C_v1_exhigh_XFF'] = await probe(v1('exhigh'), { 'X-Forwarded-For': CN_IP })
  tests['D_v1_exhigh_XRealIP_XFF'] = await probe(v1('exhigh'), {
    'X-Real-IP': CN_IP,
    'X-Forwarded-For': CN_IP,
  })
  tests['E_v1_standard_无头'] = await probe(v1('standard'), {})
  tests['F_v1_standard_XRealIP'] = await probe(v1('standard'), { 'X-Real-IP': CN_IP })
  tests['G_v1_higher_XRealIP'] = await probe(v1('higher'), { 'X-Real-IP': CN_IP })
  tests['H_老接口_无头'] = await probe(`/api/song/enhance/player/url?ids=[${id}]&br=128000`, {})
  tests['I_老接口_XRealIP'] = await probe(`/api/song/enhance/player/url?ids=[${id}]&br=128000`, {
    'X-Real-IP': CN_IP,
  })
  tests['J_搜索结果_无头'] = await probe(
    `/api/cloudsearch/pc?s=${encodeURIComponent('五月天')}&type=1&limit=1&offset=0`,
    {}
  )

  const cf = context.request.cf || {}
  return new Response(
    JSON.stringify(
      {
        id,
        colo: cf.colo || null,
        country: cf.country || null,
        asn: cf.asn || null,
        tests,
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    }
  )
}
