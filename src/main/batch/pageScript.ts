// 목록 페이지(검색 결과, 카테고리 등)에서 영상 페이지 링크와 다음 페이지 주소를 찾는 스크립트.
// 숨김 창에 로드한 페이지 안에서 `extractListPage.toString()` 으로 주입해 실행하므로
// 이 파일의 함수는 바깥 스코프의 어떤 것도 참조하면 안 된다 (import, 다른 함수, 상수 모두 금지).

export interface ListPageItem {
  url: string
  title: string
  thumb?: string
  duration?: string
}

export interface ListPageResult {
  url: string
  title: string
  items: ListPageItem[]
  /** 필터를 적용하기 전에 찾은 영상 링크 수 (0 이면 목록이 비어 있는 페이지) */
  total: number
  next: string | null
  /** Cloudflare 등의 보안 확인 페이지로 보이면 true */
  challenge: boolean
}

export interface ListPageOptions {
  filter?: string
}

export function extractListPage(opts: ListPageOptions): ListPageResult {
  const here = location.href.replace(/#.*$/, '')
  const NAV_FIRST =
    /^(categories|category|cat|tags|tag|models|model|actors|actor|channels|channel|studios|studio|sites|playlists|playlist|search|login|signup|register|signin|logout|members|member|user|users|profile|account|sort|terms|dmca|2257|contact|upload|latest-updates|most-popular|top-rated|albums|album|photos|photo|live|cams|webcams|premium|advertising|faq|help|about|privacy|feedback|blog|news|forum|community|static|assets|img|images|css|js|ajax|api|feed|rss|sitemap)$/i
  const VIDEO_PATH = /^\/(?:[a-z]{2}\/)?(video|videos|watch|v|view|movie|movies|clip|clips|embed|play|player|film|films|detail|content|media|vid|vids|scene|scenes|episode|episodes|title|titles|post|posts|item|items)(\/|$)/i
  const VIDEO_QUERY = /[?&](v|id|vid|viewkey|video_id|videoid|video|watch)=/i
  const DUR = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*$/
  const CHALLENGE = /just a moment|attention required|checking your browser|verify you are human|ddos-guard|access denied|one more step/i

  const norm = (h: string | null): string | null => {
    if (!h) return null
    try {
      const u = new URL(h, location.href)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      u.hash = ''
      return u.href
    } catch {
      return null
    }
  }
  const pathOf = (u: string): string => {
    try {
      return new URL(u).pathname
    } catch {
      return '/'
    }
  }
  const originOf = (u: string): string => {
    try {
      return new URL(u).origin
    } catch {
      return ''
    }
  }
  const firstSeg = (u: string): string => pathOf(u).split('/').filter(Boolean)[0] || ''
  const depthOf = (u: string): number => pathOf(u).split('/').filter(Boolean).length
  const looksVideo = (u: string): boolean => VIDEO_PATH.test(pathOf(u)) || VIDEO_QUERY.test(u)
  const textOf = (el: Element | null | undefined): string => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim()
  const imgSrc = (img: Element | null): string | undefined => {
    if (!img) return undefined
    for (const a of ['data-original', 'data-src', 'data-lazy-src', 'data-thumb', 'data-lazy', 'data-echo', 'data-url', 'src']) {
      const v = img.getAttribute(a)
      if (v && !v.startsWith('data:')) {
        const n = norm(v)
        if (n) return n
      }
    }
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset')
    if (ss) {
      const first = ss.split(',')[0].trim().split(/\s+/)[0]
      const n = norm(first)
      if (n) return n
    }
    return undefined
  }

  // ---------- 후보 링크 ----------
  interface Cand {
    a: HTMLAnchorElement
    url: string
    hasImg: boolean
    video: boolean
  }
  const cands: Cand[] = []
  const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[]
  for (const a of anchors) {
    const url = norm(a.getAttribute('href'))
    if (!url || url === here) continue
    if (NAV_FIRST.test(firstSeg(url))) continue
    const hasImg = !!a.querySelector('img, picture, video')
    const video = looksVideo(url)
    if (!hasImg && !video) continue
    if (!video) {
      // 썸네일만 있는 링크는 같은 사이트의 충분히 깊은 경로일 때만 (외부 광고·홈·섹션 링크 제외)
      if (originOf(url) !== location.origin) continue
      if (depthOf(url) < 2) continue
    }
    cands.push({ a, url, hasImg, video })
  }

  // 영상 주소 패턴에 맞는 링크가 충분하면 그것만 남긴다
  const videoCount = cands.filter((c) => c.video).length
  let list = videoCount >= 3 ? cands.filter((c) => c.video) : cands

  // 후보 대부분을 담은 가장 깊은 컨테이너만 남긴다 (사이드바·관련 영상·인기 목록 제외)
  if (list.length >= 4) {
    const counts = new Map<Element, number>()
    for (const c of list) {
      let el: Element | null = c.a.parentElement
      while (el) {
        counts.set(el, (counts.get(el) || 0) + 1)
        el = el.parentElement
      }
    }
    const need = Math.max(4, Math.ceil(list.length * 0.6))
    let best: Element | null = null
    let bestDepth = -1
    for (const [el, n] of counts) {
      if (n < need) continue
      let d = 0
      let p: Element | null = el
      while (p) {
        d++
        p = p.parentElement
      }
      if (d > bestDepth) {
        best = el
        bestDepth = d
      }
    }
    if (best) {
      const container = best
      list = list.filter((c) => container.contains(c.a))
    }
  }

  // ---------- 항목 정보 ----------
  const cardOf = (a: Element): Element => {
    let el: Element = a
    for (let i = 0; i < 3 && el.parentElement; i++) {
      const p = el.parentElement
      const links = new Set<string>()
      for (const x of Array.from(p.querySelectorAll('a[href]'))) {
        const n = norm(x.getAttribute('href'))
        if (n) links.add(n)
      }
      if (links.size > 1) break
      el = p
    }
    return el
  }
  const durationIn = (card: Element): string | undefined => {
    const nodes = card.querySelectorAll('[class*="time"], [class*="dur"], [class*="length"], span, div, em, b, strong, small, p')
    let n = 0
    for (const el of Array.from(nodes)) {
      if (++n > 80) break
      if (el.children.length === 0 && DUR.test(el.textContent || '')) return textOf(el)
    }
    return undefined
  }
  let filterRe: RegExp | null = null
  const filterText = (opts.filter || '').trim()
  if (filterText) {
    try {
      filterRe = new RegExp(filterText, 'i')
    } catch {
      filterRe = null
    }
  }
  const passes = (url: string, title: string): boolean => {
    if (!filterText) return true
    const hay = `${title} ${decodeURIComponent(url)}`
    if (filterRe) return filterRe.test(hay)
    return hay.toLowerCase().includes(filterText.toLowerCase())
  }

  const seen = new Set<string>()
  const items: ListPageItem[] = []
  let total = 0
  for (const c of list) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    total++
    const a = c.a
    const card = cardOf(a)
    const img = a.querySelector('img') || card.querySelector('img')
    let title = a.getAttribute('title') || a.getAttribute('aria-label') || (img && img.getAttribute('alt')) || ''
    if (!title) title = textOf(card.querySelector('.title, .name, .video-title, .thumb-title, [class*="title"], h1, h2, h3, h4, h5, h6'))
    if (!title) title = textOf(a)
    if (!title) {
      try {
        title = decodeURIComponent(pathOf(c.url).split('/').filter(Boolean).pop() || '')
      } catch {
        title = c.url
      }
    }
    title = title.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!passes(c.url, title)) continue
    items.push({ url: c.url, title, thumb: imgSrc(img), duration: durationIn(card) })
  }

  // ---------- 다음 페이지 ----------
  const pick = (el: Element | null): string | null => {
    if (!el) return null
    const u = norm(el.getAttribute('href'))
    return u && u !== here ? u : null
  }
  const findNext = (): string | null => {
    let n = pick(document.querySelector('link[rel~="next"][href]')) || pick(document.querySelector('a[rel~="next"][href]'))
    if (n) return n
    const sels = [
      'a.next[href]',
      'li.next > a[href]',
      '.next > a[href]',
      'a.pagination-next[href]',
      'a.page-next[href]',
      'a.next-page[href]',
      'a[class*="next"][href]:not([class*="prev"])',
      'a[aria-label*="next" i][href]',
      'a[title*="next" i][href]',
      'a[title*="다음"][href]'
    ]
    for (const s of sels) {
      try {
        n = pick(document.querySelector(s))
        if (n) return n
      } catch {
        /* 선택자 미지원 */
      }
    }
    const words = ['next', 'next page', 'next »', 'next ›', 'next >', 'next→', '›', '»', '>', '>>', '다음', '다음 페이지', '다음페이지', '次へ', '次のページ', '次页', '下一页', '下一頁', '→', 'older', 'older posts']
    for (const a of anchors) {
      const t = textOf(a).toLowerCase()
      if (words.indexOf(t) >= 0) {
        n = pick(a)
        if (n) return n
      }
    }
    // 숫자 페이지네이션: 현재 번호 + 1 인 링크
    const conts = Array.from(document.querySelectorAll('.pagination, .pager, .pages, .paginator, .page-numbers, .pagenavi, .pagenav, [class*="pagin"], [id*="pagin"], nav'))
    for (const c of conts) {
      const cur = c.querySelector('.active, .current, [aria-current], .selected, .is-active, strong, b, span.page, li.active a')
      let target = parseInt(textOf(cur), 10)
      if (!target) {
        const m = /\/(\d+)\/?$/.exec(location.pathname) || /[?&](?:page|p|pg)=(\d+)/.exec(location.search)
        target = m ? parseInt(m[1], 10) : 1
      }
      target += 1
      for (const a of Array.from(c.querySelectorAll('a[href]'))) {
        if (parseInt(textOf(a), 10) === target) {
          n = pick(a)
          if (n) return n
        }
      }
    }
    return null
  }

  return { url: here, title: document.title, items, total, next: findNext(), challenge: CHALLENGE.test(document.title) && total === 0 }
}
