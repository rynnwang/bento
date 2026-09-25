// Fallback page renderer for the web clipper: a real Cloudflare-managed Chromium
// (Browser Rendering, the same binding pdf.ts uses). Runs JavaScript, so it gets
// past client-side "checking your browser" interstitials that auto-resolve and
// reads JS-rendered pages. It does NOT solve interactive captchas or logins — a
// page that still shows one is reported as blocked by webclip.ts.
//
// Free-tier budget is small (shared with PDF rendering), so this is strictly a
// fallback after the plain fetch fails; see webclip.ts's clipUrl.
import puppeteer from '@cloudflare/puppeteer'
import type { Env } from './env.ts'
import { looksLikeChallenge, type BrowserRender } from './webclip.ts'

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const NAV_TIMEOUT_MS = 25_000
const MAX_CHALLENGE_WAITS = 4

export function makeBrowserRender(env: Env): BrowserRender | undefined {
  if (!env.BROWSER) return undefined
  return async (url) => {
    const browser = await puppeteer.launch(env.BROWSER)
    try {
      const page = await browser.newPage()
      await page.setUserAgent(CHROME_UA)
      await page.setViewport({ width: 1280, height: 900 })
      // images/media/fonts are irrelevant to text extraction and slow the load
      await page.setRequestInterception(true)
      page.on('request', (r) => {
        const t = r.resourceType()
        if (t === 'image' || t === 'media' || t === 'font') void r.abort()
        else void r.continue()
      })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
      let html = await page.content()
      // an auto-resolving interstitial reloads itself: give it a few beats
      for (let i = 0; i < MAX_CHALLENGE_WAITS && looksLikeChallenge(html); i++) {
        await new Promise((r) => setTimeout(r, 2500))
        html = await page.content()
      }
      return { html, url: page.url() }
    } finally {
      await browser.close()
    }
  }
}
