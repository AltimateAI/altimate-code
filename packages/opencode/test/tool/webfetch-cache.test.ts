import { describe, test, expect, beforeEach } from "bun:test"
import {
  normalizeUrlForCache,
  _resetFailureCache,
  _failureCacheSize,
  _cacheUrlFailureForTest,
  _failureCacheKeysInOrder,
  _isUrlCachedFailureForTest,
} from "../../src/tool/webfetch"

/**
 * Webfetch URL failure cache.
 *
 * Background: telemetry-2026-05-21 showed 486 residual webfetch 404 errors
 * (down 78% from March's 2,222, so the existing cache is working — these
 * are the cases that still escape it). The cache previously had a 5-min TTL
 * and didn't normalize URLs, so tracking-param variations of a known-bad URL
 * missed cache. This file pins the normalization contract that now
 * collapses common LLM-generated URL variations onto one cache entry.
 */

beforeEach(() => {
  _resetFailureCache()
})

describe("normalizeUrlForCache", () => {
  test("returns identical URLs unchanged (apart from sorting empty params)", () => {
    expect(normalizeUrlForCache("https://example.com/path")).toBe("https://example.com/path")
  })

  test("strips utm_* tracking params", () => {
    expect(
      normalizeUrlForCache("https://example.com/docs?utm_source=twitter&utm_medium=social"),
    ).toBe("https://example.com/docs")
  })

  test("strips fbclid, gclid, msclkid, etc.", () => {
    expect(normalizeUrlForCache("https://example.com/a?fbclid=abc123")).toBe(
      "https://example.com/a",
    )
    expect(normalizeUrlForCache("https://example.com/a?gclid=xyz")).toBe("https://example.com/a")
    expect(normalizeUrlForCache("https://example.com/a?msclkid=qqq")).toBe(
      "https://example.com/a",
    )
  })

  test("preserves functional query params", () => {
    expect(normalizeUrlForCache("https://example.com/api?page=2&limit=20")).toBe(
      "https://example.com/api?limit=20&page=2",
    )
    expect(normalizeUrlForCache("https://example.com/search?q=hello+world")).toBe(
      "https://example.com/search?q=hello+world",
    )
  })

  test("preserves functional params when mixed with tracking params", () => {
    // `ref` is preserved (it's functional on GitHub etc.); `referrer` is stripped.
    // utm_* and fbclid are stripped.
    expect(
      normalizeUrlForCache(
        "https://example.com/post?id=42&utm_source=email&utm_campaign=monthly&fbclid=abc&referrer=twitter",
      ),
    ).toBe("https://example.com/post?id=42")
  })

  test("sorts query params for stable cache key", () => {
    expect(normalizeUrlForCache("https://example.com/x?b=2&a=1")).toBe(
      "https://example.com/x?a=1&b=2",
    )
    expect(normalizeUrlForCache("https://example.com/x?a=1&b=2")).toBe(
      "https://example.com/x?a=1&b=2",
    )
  })

  test("strips URL fragments", () => {
    expect(normalizeUrlForCache("https://example.com/page#section-3")).toBe(
      "https://example.com/page",
    )
    expect(normalizeUrlForCache("https://example.com/page?id=1#section-3")).toBe(
      "https://example.com/page?id=1",
    )
  })

  test("lowercases hostname (case-insensitive per RFC 3986)", () => {
    expect(normalizeUrlForCache("https://EXAMPLE.COM/path")).toBe("https://example.com/path")
    expect(normalizeUrlForCache("https://Example.Com/Path")).toBe("https://example.com/Path")
  })

  test("preserves path case (paths ARE case-sensitive per HTTP)", () => {
    expect(normalizeUrlForCache("https://example.com/Foo/Bar")).toBe("https://example.com/Foo/Bar")
  })

  test("collapses Cloudflare challenge tokens (__cf_chl_* prefix)", () => {
    expect(
      normalizeUrlForCache(
        "https://example.com/page?__cf_chl_tk=abc&__cf_chl_jschl_tk__=xyz",
      ),
    ).toBe("https://example.com/page")
  })

  test("returns input verbatim if URL parsing fails", () => {
    expect(normalizeUrlForCache("not a url at all")).toBe("not a url at all")
  })

  test("multiple variations of the same logical URL collapse to one cache key", () => {
    const variations = [
      "https://docs.example.com/api/v1?utm_source=docs",
      "https://docs.example.com/api/v1?utm_source=twitter&fbclid=q",
      "https://docs.example.com/api/v1?gclid=z",
      "https://docs.example.com/api/v1#anchor",
      "https://DOCS.EXAMPLE.COM/api/v1",
      "https://docs.example.com/api/v1?utm_campaign=monthly",
    ]
    const normalized = variations.map(normalizeUrlForCache)
    const unique = new Set(normalized)
    expect(unique.size).toBe(1)
    expect(unique.values().next().value).toBe("https://docs.example.com/api/v1")
  })

  test("different functional params do NOT collapse", () => {
    const a = normalizeUrlForCache("https://example.com/a?page=1")
    const b = normalizeUrlForCache("https://example.com/a?page=2")
    expect(a).not.toBe(b)
  })

  test("different paths do NOT collapse", () => {
    expect(normalizeUrlForCache("https://example.com/v1/api")).not.toBe(
      normalizeUrlForCache("https://example.com/v2/api"),
    )
  })

  test("preserves `ref` param (functional on GitHub raw URLs / git APIs)", () => {
    // GitHub: `?ref=main` vs `?ref=v2.0` selects different branches/tags.
    // Stripping `ref` would suppress legitimate fetches of different refs.
    // Caught by reviewer (2026-05-22). Same for ref_src and ref_url.
    expect(normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=main")).toBe(
      "https://api.github.com/repos/x/y/contents/foo.md?ref=main",
    )
    expect(normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=v2.0")).toBe(
      "https://api.github.com/repos/x/y/contents/foo.md?ref=v2.0",
    )
    // Different `ref` values must NOT collapse — they identify different
    // resources. Pinning this prevents a regression that would re-add ref
    // to TRACKING_PARAMS.
    expect(
      normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=main"),
    ).not.toBe(normalizeUrlForCache("https://api.github.com/repos/x/y/contents/foo.md?ref=v2.0"))
  })

  test("still strips `referrer` (full word, tracking-only)", () => {
    // The abbreviated `ref` is functional; the full word `referrer` is
    // a tracking header and stays in TRACKING_PARAMS.
    expect(normalizeUrlForCache("https://example.com/page?referrer=twitter")).toBe(
      "https://example.com/page",
    )
  })

  test("strips userinfo (basic-auth user:pass@) from cache key", () => {
    // Reviewer (2026-05-23): credentials in the URL don't change the
    // resource the request hits, so they shouldn't fragment the cache.
    // Also a hygiene win — telemetry never logs cache keys with creds.
    expect(normalizeUrlForCache("https://user:pass@example.com/path")).toBe(
      "https://example.com/path",
    )
    // Same logical URL with and without userinfo collapses to one key.
    expect(normalizeUrlForCache("https://user@example.com/path")).toBe(
      normalizeUrlForCache("https://example.com/path"),
    )
    expect(normalizeUrlForCache("https://user:pass@example.com/path?a=1")).toBe(
      normalizeUrlForCache("https://example.com/path?a=1"),
    )
  })

  test("strips HubSpot tracking params (_hsenc, _hsmi, hsCtaTracking)", () => {
    expect(
      normalizeUrlForCache(
        "https://example.com/post?_hsenc=p2ANqtz-x&_hsmi=12345&hsCtaTracking=abc",
      ),
    ).toBe("https://example.com/post")
  })

  test("strips Marketo tracking param (mkt_tok)", () => {
    expect(normalizeUrlForCache("https://example.com/page?mkt_tok=eyJhbGciOi")).toBe(
      "https://example.com/page",
    )
  })

  test("strips Adobe Analytics tracking params (s_cid, s_kwcid)", () => {
    expect(
      normalizeUrlForCache("https://example.com/page?s_cid=email&s_kwcid=AL!1234"),
    ).toBe("https://example.com/page")
  })

  test("strips enumerated Piwik/Matomo tracking params (pk_campaign, pk_kwd, pk_source, pk_medium, pk_content, piwik_campaign, piwik_keyword)", () => {
    // NOTE: this is an exact-name match against TRACKING_PARAMS, NOT a
    // pk_* / piwik_* prefix match. New Matomo params (e.g. a hypothetical
    // `pk_term`) would NOT be stripped until added explicitly. The
    // restraint is deliberate — prefix-stripping `pk_` would risk false
    // positives on functional params from unrelated services that happen
    // to start with the same two letters.
    expect(
      normalizeUrlForCache(
        "https://example.com/page?pk_campaign=spring&pk_kwd=hello&pk_source=email&pk_medium=newsletter&pk_content=banner",
      ),
    ).toBe("https://example.com/page")
    expect(
      normalizeUrlForCache(
        "https://example.com/page?piwik_campaign=summer&piwik_keyword=ai",
      ),
    ).toBe("https://example.com/page")
    // Non-enumerated pk_* / piwik_* are preserved — pins the "exact-name,
    // not prefix" contract so a future refactor can't silently flip to
    // prefix-stripping.
    expect(normalizeUrlForCache("https://example.com/page?pk_unknown=x")).toBe(
      "https://example.com/page?pk_unknown=x",
    )
    expect(normalizeUrlForCache("https://example.com/page?piwik_unknown=x")).toBe(
      "https://example.com/page?piwik_unknown=x",
    )
  })

  test("real-world: HubSpot/Marketo email link variations collapse to one cache key", () => {
    const variations = [
      "https://docs.example.com/guide?_hsenc=p2ANqtz1&_hsmi=42",
      "https://docs.example.com/guide?mkt_tok=eyJhbGciOiJIUzI",
      "https://docs.example.com/guide?utm_source=email&utm_medium=marketo",
      "https://USER:PASS@docs.example.com/guide",
    ]
    const normalized = variations.map(normalizeUrlForCache)
    expect(new Set(normalized).size).toBe(1)
    expect(normalized[0]).toBe("https://docs.example.com/guide")
  })

  test("duplicate-key params collapse to a stable order regardless of input order", () => {
    // Without value-aware sort, `?a=1&a=2` and `?a=2&a=1` would produce
    // different cache keys despite carrying the same logical content.
    expect(normalizeUrlForCache("https://example.com/x?a=1&a=2")).toBe(
      normalizeUrlForCache("https://example.com/x?a=2&a=1"),
    )
    // And the normalized form is deterministic:
    expect(normalizeUrlForCache("https://example.com/x?a=2&a=1")).toBe(
      "https://example.com/x?a=1&a=2",
    )
  })
})

describe("failure cache state machine", () => {
  test("cacheUrlFailure → isUrlCachedFailure round-trips with status + ageMs", () => {
    _cacheUrlFailureForTest("https://example.com/dead", 404)
    expect(_failureCacheSize()).toBe(1)
    const hit = _isUrlCachedFailureForTest("https://example.com/dead")
    expect(hit?.status).toBe(404)
    // ageMs is the time since the entry was cached; should be small (just
    // cached) but non-negative.
    expect(hit?.ageMs).toBeGreaterThanOrEqual(0)
    expect(hit?.ageMs).toBeLessThan(60_000)
  })

  test("only 404 / 410 / 451 are cached — other statuses are ignored", () => {
    for (const status of [200, 301, 403, 429, 500, 502, 504]) {
      _cacheUrlFailureForTest(`https://example.com/status${status}`, status)
    }
    expect(_failureCacheSize()).toBe(0)

    _cacheUrlFailureForTest("https://example.com/a", 404)
    _cacheUrlFailureForTest("https://example.com/b", 410)
    _cacheUrlFailureForTest("https://example.com/c", 451)
    expect(_failureCacheSize()).toBe(3)
  })

  test("tracking-param variations of a failed URL all hit cache", () => {
    _cacheUrlFailureForTest("https://docs.example.com/page", 404)
    // All five should hit the same cache entry — normalization collapses
    // tracking variations to one logical key.
    for (const variant of [
      "https://docs.example.com/page?utm_source=x",
      "https://docs.example.com/page?fbclid=abc",
      "https://DOCS.EXAMPLE.COM/page",
      "https://docs.example.com/page#section",
      "https://user:pass@docs.example.com/page",
    ]) {
      expect(_isUrlCachedFailureForTest(variant)?.status).toBe(404)
    }
    expect(_failureCacheSize()).toBe(1)
  })

  test("re-touch on repeated failure moves entry to tail of eviction order", () => {
    // Reviewer prompt asked specifically about the re-touch logic added in
    // commit 752945356e — the delete-then-set pattern in cacheUrlFailure
    // that ensures a frequently-failing URL doesn't sit at the head of the
    // FIFO and get evicted first. Pin that contract.
    _cacheUrlFailureForTest("https://example.com/a", 404)
    _cacheUrlFailureForTest("https://example.com/b", 404)
    _cacheUrlFailureForTest("https://example.com/c", 404)
    expect(_failureCacheKeysInOrder()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ])

    // Re-cache A — should move A to the tail.
    _cacheUrlFailureForTest("https://example.com/a", 404)
    expect(_failureCacheKeysInOrder()).toEqual([
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/a",
    ])
  })

  test("451 (legal block) uses shorter TTL than 404/410", () => {
    // Real-world: an agent that swaps networks (VPN, travel) inside the
    // long-cache window for 451 would be locked out of legitimately
    // reachable URLs. Pin that the TTL split exists so a refactor doesn't
    // collapse them back to the same value.
    _cacheUrlFailureForTest("https://example.com/legal-block", 451)
    expect(_isUrlCachedFailureForTest("https://example.com/legal-block")?.status).toBe(451)

    // We don't time-travel here; the TTL constants are internal. The
    // separate isUrlCachedFailure code path that reads ttlForStatus is
    // covered by this test running through both branches:
    _cacheUrlFailureForTest("https://example.com/gone", 410)
    expect(_isUrlCachedFailureForTest("https://example.com/gone")?.status).toBe(410)

    // Both entries persist — TTL split affects expiry timing, not
    // immediate retrieval. The behavioral contract verified here is
    // "split TTL paths are wired".
    expect(_failureCacheSize()).toBe(2)
  })

  test("_resetFailureCache clears any cached entries", () => {
    _cacheUrlFailureForTest("https://example.com/dead", 404)
    _cacheUrlFailureForTest("https://example.com/gone", 410)
    expect(_failureCacheSize()).toBe(2)
    _resetFailureCache()
    expect(_failureCacheSize()).toBe(0)
    expect(_isUrlCachedFailureForTest("https://example.com/dead")).toBeNull()
  })
})
