# ne-relay

个人站点「Amoyba的小屋」自用的网易云接口中转。Cloudflare Pages Functions。

**为什么单独一个项目**：网易云接口不让浏览器跨域直连，播放地址又是 20 分钟过期的临时直链。
这个小中转只做三件事——代查搜索、代取歌词、代解析直链。音频字节由浏览器直接从网易云 CDN 取，
**不经过这台服务器**，所以 Pages 的免费额度不会被流量吃掉。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ping` | 存活探测，不碰上游，前端据此决定要不要显示在线曲库 |
| GET | `/api/search?q=&limit=&offset=` | 搜索，返回归一化曲目（`relayId / name / artist / album / duration / cover`） |
| GET | `/api/lyric?id=` | 歌词，返回 `lrc`（原文）和 `tlyric`（翻译） |
| GET | `/api/url?id=&level=` | 播放直链，返回 `url / br / expi` |
| GET | `/api/stream?id=&level=` | 302 跳到直链，给 `<audio src>` 直接用的备选入口 |

`level`：`standard`(128k) / `higher`(192k) / `exhigh`(320k，默认) / `lossless`。

所有响应都带 CORS 头；只接受 GET/HEAD，其它方法一律 405。

## 部署

```bash
cd ne-relay
npm install                 # 只装 wrangler
npx wrangler login          # 浏览器里授权一次

npx wrangler pages deploy public --project-name netease-relay
```

第一次会问要不要创建项目，选是。部署完的地址形如
`https://netease-relay.pages.dev`，把它填进主站（见下）。

**本地跑**（不需要 Cloudflare 账号，wrangler 会本地模拟 Functions）：

```bash
cd ne-relay
npx wrangler pages dev public --compatibility-date=2024-11-01
# → http://127.0.0.1:8788
```

## 主站怎么接

主站 `src/lib/online.js` 里的地址按这个顺序取：

1. `VITE_RELAY_BASE` 环境变量（构建时注入）
2. 页面同源 `/ne`（本地开发走 vite 代理到 `server/netease-proxy.mjs`）

所以线上要把中转地址告诉构建过程：

```bash
# 主站目录下
VITE_RELAY_BASE=https://netease-relay.pages.dev npm run build
```

Cloudflare Pages 上则是在 **Settings → Environment variables** 加一条
`VITE_RELAY_BASE`，然后重新部署。

另外主站 `public/_headers` 的 CSP 要放行这个来源：

```
connect-src 'self' https://netease-relay.pages.dev;
img-src     'self' data: blob: https://*.music.126.net;
media-src   'self' blob: https://*.music.126.net;
```

`connect-src` 是打接口用的，`img-src` / `media-src` 分别是封面和音频（网易云 CDN）。

## 缓存

| 内容 | 边缘缓存 | 原因 |
| --- | --- | --- |
| 搜索 | 10 分钟 | 同一个词反复搜很常见，省上游请求 |
| 歌词 | 30 分钟 | 静态内容，几乎不变 |
| 直链 | 840 秒 | 上游 `expi` 是 1200 秒，打七折留余量，避免把快过期的地址发出去 |
| 失败结果 | 不缓存 | 上游抽风是临时的，钉住十分钟用户会以为这首歌永远放不了 |

命中了边缘缓存会带 `X-Relay-Cache: HIT`，在浏览器 Network 里能直接看出来。

## 加固（可选）

默认不限流。要限流就在 Pages 项目的 **Settings → Bindings** 加一个 **KV namespace**，
变量名必须是 `RL`。绑定后：

- 搜索：2 分钟 60 次
- 歌词 / 直链：2 分钟 120 次

没绑 KV 也不会报错，只是限流不生效——宁可让它能跑，也不要因为少一个绑定就整个 502。

## 说明

- 上游靠游客 cookie（`os=pc`）拿到 320k，**不需要登录**。代价是 VIP / 付费版权曲拿不到地址，
  接口会返回 `code: -110` 和一句人话提示，而不是静默失败。
- 仅供个人自用。别把它当成公开 API 分发，也别拿它做版权内容的再分发。
