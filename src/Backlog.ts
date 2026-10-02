/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Backlog: is it worth going back to the shows you left unfinished? Every
// show you're behind on or dropped gets a verdict from its AniList score, how
// many viewers finish it and how well it fits your taste, with the episode
// scores from MyAnimeList on demand. A second tab recommends shows you haven't
// seen, from the AniList recommendations of what you rated highest.

interface Show {
  id: number
  idMal: number
  title: string
  cover: string
  banner: string
  color: string
  format: string
  episodes: number
  aired: number            // episodes out so far (all of them once finished)
  duration: number
  status: string
  year: number
  genres: string[]
  studios: string[]
  tags: string[]
  score: number            // AniList average score 0-100, 0 if none
  popularity: number
  dist: number[]           // viewers: [completed, watching, paused, dropped]
  recs: number[][]         // [[media id, rating]], best first
  sequel: boolean          // a sequel or side story of another anime
  adult: boolean
  at: number
}

interface ListEntry {
  id: number
  status: string
  progress: number
  score: number            // 0-100, 0 if unscored
  updatedAt: number        // unix seconds
}

function init() {
  // Seanime runs the UI handler in its own runtime, from its source text, so
  // it can't see anything declared at the top level of this file. Everything
  // it needs comes from the shared module compiled from createBacklog().
  $shared.define("backlog", createBacklog)

  $ui.register((ctx) => {
    const B = $shared.use("backlog")

    const page = ctx.newWebview({
      slot: "screen",
      fullWidth: true,
      autoHeight: true,
      sidebar: { label: "Backlog", icon: B.ICON },
    })

    const payload = ctx.state<any>(null)
    page.channel.sync("data", payload)
    page.setContent(() => B.PAGE_HTML)

    let loading = false
    async function load(force: boolean) {
      if (loading) return
      loading = true
      try {
        // What was computed last time shows up at once; fresh data replaces it.
        const cached = force ? null : B.cachedPayload()
        if (cached) payload.set(Object.assign(cached, { loading: !cached.fresh }))
        else payload.set(Object.assign({}, payload.get() || {}, { loading: true }))
        if (!cached || !cached.fresh) payload.set(await B.load(force))
      } finally {
        loading = false
      }
    }

    page.channel.on("refresh", () => { load(true) })
    page.channel.on("open", (p: any) => {
      const id = p && Number(p.id)
      if (id) ctx.screen.navigateTo("/entry", { id: String(id) })
    })
    page.channel.on("plan", (p: any) => {
      const id = p && Number(p.id)
      if (id && B.addToPlanning(id)) {
        const cur = payload.get() || {}
        const planned = Object.assign({}, cur.planned || {})
        planned[String(id)] = true
        payload.set(Object.assign({}, cur, { planned }))
      }
    })
    page.channel.on("episodes", async (p: any) => {
      const mal = p && Number(p.mal)
      if (!mal) return
      const result = await B.episodes(mal)
      const cur = payload.get() || {}
      const eps = Object.assign({}, cur.eps || {})
      eps[String(mal)] = result
      payload.set(Object.assign({}, cur, { eps }))
    })
    page.channel.on("set-prefs", (p: any) => {
      payload.set(Object.assign({}, payload.get() || {}, { prefs: B.savePrefs(p) }))
    })

    load(false)
    page.onMount(() => load(false))
  })
}

// Everything the plugin does. Self-contained: compiled from its own source
// by $shared, so it may only use globals ($anilist, $storage, fetch, ...).
// Keep it free of anything esbuild compiles into top-level helpers (tagged
// templates like String.raw, for one): those would be outside this function.
function createBacklog() {
  const PREFS_KEY = "bl-prefs"
  const LIST_KEY = "bl-list-v1"
  const SHOWS_KEY = "bl-shows-v2"
  const EPS_KEY = "bl-eps-v1"
  // Your list changes as you watch; show data hardly does.
  const LIST_TTL = 10 * 60000
  const SHOW_TTL_FINISHED = 7 * 86400000
  const SHOW_TTL_AIRING = 12 * 3600000
  const EPS_TTL = 5 * 86400000
  const MAX_EPS_CACHED = 80
  // Verdict thresholds (0-100).
  const KEEP_GOING = 65
  const YOUR_CALL = 48
  // A hidden gem: rated well, but few people have seen it.
  const GEM_SCORE = 75
  const GEM_POPULARITY = 50000
  const MAX_SOURCES = 100
  const MAX_REC_CANDIDATES = 150
  const MAX_RECS = 60
  const BACKLOG_STATUSES: { [s: string]: boolean } = { CURRENT: true, PAUSED: true, DROPPED: true }

  const ICON = `<span style="display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center;color:currentColor"><svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h13"/><path d="M3 12h9"/><path d="M3 17h7"/><path d="m15 15 2.5 2.5L22 13"/></svg></span>`

  const LIST_QUERY = `query ($u: Int) {
    MediaListCollection(userId: $u, type: ANIME) {
      lists { entries {
        status progress updatedAt score(format: POINT_100)
        media { id genres studios(isMain: true) { nodes { name } } tags { name rank } }
      } }
    }
  }`

  const SHOW_QUERY = `query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id idMal format episodes duration status isAdult seasonYear
        title { userPreferred }
        coverImage { large medium color }
        bannerImage
        startDate { year }
        genres averageScore popularity
        studios(isMain: true) { nodes { name } }
        tags { name rank }
        nextAiringEpisode { episode }
        stats { statusDistribution { status amount } }
        recommendations(sort: RATING_DESC, perPage: 8) { nodes { rating mediaRecommendation { id } } }
        relations { edges { relationType node { id type } } }
      }
    }
  }`

  // ---------------------------------------------------------------------------
  // AniList
  // ---------------------------------------------------------------------------

  // An AniList error (rate limit, outage) throws: treating it as empty data
  // would overwrite good cached data with nothing.
  function query(token: string, q: string, variables: any): any {
    const res: any = $anilist.customQuery({ query: q, variables }, token)
    if (!res || (res.errors && !res.data)) {
      throw new Error("AniList didn't answer" + (res && res.errors ? ": " + JSON.stringify(res.errors).slice(0, 120) : ""))
    }
    // customQuery may or may not unwrap "data".
    return res.data ? res.data : res
  }

  function viewerId(token: string): number {
    const cached = $storage.get("bl-viewer")
    if (cached) return cached
    const d = query(token, "query { Viewer { id } }", {})
    const id = d && d.Viewer && d.Viewer.id
    if (!id) throw new Error("could not get the AniList user")
    $storage.set("bl-viewer", id)
    return id
  }

  // Public show data straight from AniList, so requests can run in parallel:
  // Seanime's client runs one at a time and blocks the plugin meanwhile.
  // No token is sent.
  async function gql(q: string, variables: any): Promise<any> {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: q, variables }),
    })
    if (!res.ok) throw new Error("AniList HTTP " + res.status)
    const j: any = await res.json()
    if (j.errors) throw new Error("AniList: " + JSON.stringify(j.errors).slice(0, 200))
    return j.data
  }

  // ---------------------------------------------------------------------------
  // Your list and taste
  // ---------------------------------------------------------------------------

  // Your list, plus how much you like each genre, studio and tag: scored
  // shows count by how far their score is from your average, unscored ones
  // by their status (dropped counts against). Averages are pulled towards
  // zero for features you've seen only a couple of times.
  function readList(token: string, userId: number, force: boolean): any {
    const cached = $storage.get(LIST_KEY)
    if (!force && cached && cached.at && cached.userId === userId && Date.now() - cached.at < LIST_TTL) return cached

    const d = query(token, LIST_QUERY, { u: userId })
    if (!d || !d.MediaListCollection) throw new Error("AniList returned no list")
    const raw: any[] = []
    for (const l of (d.MediaListCollection.lists || [])) for (const e of (l.entries || [])) if (e && e.media) raw.push(e)

    const scores = raw.filter((e) => e.score > 0).map((e) => e.score)
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 70
    const sd = scores.length > 1
      ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length)
      : 10
    const byStatus: { [s: string]: number } = { COMPLETED: 0.4, REPEATING: 0.6, CURRENT: 0.25, PAUSED: 0, DROPPED: -1, PLANNING: 0.15 }

    const sum: { [f: string]: number } = {}
    const weight: { [f: string]: number } = {}
    for (const e of raw) {
      const w = e.score > 0
        ? Math.max(-2, Math.min(2, (e.score - mean) / Math.max(sd, 5)))
        : (byStatus[e.status] || 0)
      const add = (f: string, fw: number) => {
        sum[f] = (sum[f] || 0) + w * fw
        weight[f] = (weight[f] || 0) + fw
      }
      for (const g of (e.media.genres || [])) add("g:" + g, 1)
      for (const s of ((e.media.studios && e.media.studios.nodes) || [])) add("s:" + s.name, 0.8)
      for (const t of (e.media.tags || [])) if (t && t.rank >= 60) add("t:" + t.name, (t.rank / 100) * 0.6)
    }
    const affinity: { [f: string]: number } = {}
    for (const f in sum) affinity[f] = sum[f] / (weight[f] + 2)

    const entries: ListEntry[] = raw.map((e) => ({
      id: e.media.id, status: e.status || "", progress: e.progress || 0, score: e.score || 0, updatedAt: e.updatedAt || 0,
    }))
    const list = { at: Date.now(), userId, entries, affinity, mean, sd }
    $storage.set(LIST_KEY, list)
    return list
  }

  // 0-100: how well a show's genres, studio and tags fit your taste.
  function matchOf(show: Show, affinity: { [f: string]: number }): number {
    let total = 0
    let weights = 0
    const add = (f: string, fw: number) => {
      total += (affinity[f] || 0) * fw
      weights += fw
    }
    for (const g of show.genres) add("g:" + g, 1)
    for (const s of show.studios) add("s:" + s, 0.8)
    for (const t of show.tags) add("t:" + t, 0.5)
    // The extra weight pulls shows we know little about (one genre, no tags)
    // towards 50% instead of letting a single feature decide.
    const raw = total / (weights + 1.5)
    return Math.round(100 / (1 + Math.exp(-raw * 7)))
  }

  // Why a show got its match: the features that pushed it up the most and
  // down the most, with the same weights as matchOf().
  function explainMatch(show: Show, affinity: { [f: string]: number }): { p: string[], n: string[] } {
    const parts: { name: string, v: number }[] = []
    const add = (f: string, name: string, fw: number) => {
      const a = affinity[f] || 0
      if (Math.abs(a) >= 0.08) parts.push({ name, v: a * fw })
    }
    for (const g of show.genres) add("g:" + g, g, 1)
    for (const s of show.studios) add("s:" + s, s, 0.8)
    for (const t of show.tags) add("t:" + t, t, 0.5)
    const p = parts.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4).map((x) => x.name)
    const n = parts.filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.name)
    return { p, n }
  }

  // ---------------------------------------------------------------------------
  // Shows
  // ---------------------------------------------------------------------------

  function toShow(m: any): Show {
    const tags: string[] = []
    for (const t of (m.tags || [])) if (t && t.rank >= 60 && tags.length < 8) tags.push(t.name)
    const s: { [k: string]: number } = {}
    for (const x of ((m.stats && m.stats.statusDistribution) || [])) if (x) s[x.status] = x.amount || 0
    const next = m.nextAiringEpisode && m.nextAiringEpisode.episode
    const recs: number[][] = []
    for (const n of ((m.recommendations && m.recommendations.nodes) || [])) {
      if (n && n.mediaRecommendation && n.mediaRecommendation.id) recs.push([n.mediaRecommendation.id, n.rating || 0])
    }
    let sequel = false
    for (const e of ((m.relations && m.relations.edges) || [])) {
      if (e && e.node && e.node.type === "ANIME" && (e.relationType === "PREQUEL" || e.relationType === "PARENT")) sequel = true
    }
    return {
      id: m.id,
      idMal: m.idMal || 0,
      title: (m.title && m.title.userPreferred) || "?",
      cover: (m.coverImage && (m.coverImage.large || m.coverImage.medium)) || "",
      banner: m.bannerImage || "",
      color: (m.coverImage && m.coverImage.color) || "",
      format: m.format || "",
      episodes: m.episodes || 0,
      aired: next ? next - 1 : (m.episodes || 0),
      duration: m.duration || 0,
      status: m.status || "",
      year: m.seasonYear || (m.startDate && m.startDate.year) || 0,
      genres: m.genres || [],
      studios: ((m.studios && m.studios.nodes) || []).map((x: any) => x.name),
      tags,
      score: m.averageScore || 0,
      popularity: m.popularity || 0,
      dist: [s.COMPLETED || 0, s.CURRENT || 0, s.PAUSED || 0, s.DROPPED || 0],
      recs,
      sequel,
      adult: !!m.isAdult,
      at: Date.now(),
    }
  }

  function isFresh(s: Show): boolean {
    const ttl = s.status === "FINISHED" || s.status === "CANCELLED" ? SHOW_TTL_FINISHED : SHOW_TTL_AIRING
    return Date.now() - s.at < ttl
  }

  // Makes sure `shows` has fresh data for every id: 50 per request, three
  // requests at a time. Falls back to Seanime's client if direct requests fail.
  async function fetchShows(token: string, shows: { [id: string]: Show }, ids: number[], force: boolean) {
    const need = ids.filter((id) => force || !shows[String(id)] || !isFresh(shows[String(id)]))
    const chunks: number[][] = []
    for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50))
    const take = (d: any) => {
      for (const m of ((d && d.Page && d.Page.media) || [])) if (m && m.id) shows[String(m.id)] = toShow(m)
    }
    try {
      for (let i = 0; i < chunks.length; i += 3) {
        const batch = await Promise.all(chunks.slice(i, i + 3).map((c) => gql(SHOW_QUERY, { ids: c })))
        batch.forEach(take)
      }
    } catch (e) {
      console.error("Backlog: direct AniList request failed, using Seanime's client: " + e)
      for (const c of chunks) {
        if (c.every((id) => shows[String(id)] && Date.now() - shows[String(id)].at < 60000)) continue
        take(query(token, SHOW_QUERY, { ids: c }))
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Verdicts
  // ---------------------------------------------------------------------------

  // How viewers get on with the show. A finished show: the share of everyone
  // who started it that completed it. One still airing can't be completed
  // yet, so the share that dropped it instead. Null with too few viewers.
  // Sequels are judged on a stricter scale: only fans of the earlier seasons
  // start them, so nearly everyone finishes.
  function finishInfo(s: Show): { kind: string, rate: number, sequel: boolean } | null {
    const total = s.dist[0] + s.dist[1] + s.dist[2] + s.dist[3]
    if (total < 300) return null
    if (s.status === "FINISHED") return { kind: "finish", rate: s.dist[0] / total, sequel: s.sequel }
    return { kind: "drop", rate: s.dist[3] / total, sequel: s.sequel }
  }

  function clamp01(x: number): number { return Math.max(0, Math.min(1, x)) }

  function quality(s: Show): number { return s.score ? clamp01((s.score - 60) / 25) : 0.35 }

  function finishPart(info: { kind: string, rate: number, sequel: boolean } | null): number {
    if (!info) return 0.5
    if (info.kind === "finish") return info.sequel ? clamp01((info.rate - 0.72) / 0.22) : clamp01((info.rate - 0.5) / 0.4)
    return info.sequel ? clamp01(1 - (info.rate - 0.01) / 0.08) : clamp01(1 - (info.rate - 0.02) / 0.16)
  }

  // Sequels are never gems: few people watch them because few watched the
  // first season, not because they're overlooked.
  function isGem(s: Show): boolean {
    return !s.sequel && s.score >= GEM_SCORE && s.popularity < GEM_POPULARITY && s.popularity >= 1500
  }

  function median(xs: number[]): number {
    if (!xs.length) return 0
    const a = xs.slice().sort((x, y) => x - y)
    return a[Math.floor(a.length / 2)]
  }

  // The shows you're behind on or dropped, each with a verdict: 40% its
  // AniList score, 25% how many viewers finish it, 35% your taste.
  function buildBacklog(list: any, shows: { [id: string]: Show }): any {
    const items: any[] = []
    for (const e of (list.entries as ListEntry[])) {
      if (!BACKLOG_STATUSES[e.status]) continue
      const s = shows[String(e.id)]
      if (!s || s.adult) continue
      const available = s.aired || s.episodes
      // Caught up with an airing show: nothing to decide, just waiting.
      if (available && e.progress >= available) continue
      const info = finishInfo(s)
      const match = matchOf(s, list.affinity)
      const q = quality(s)
      const f = finishPart(info)
      const value = Math.round(100 * (0.4 * q + 0.25 * f + 0.35 * (match / 100)))
      const left = available ? available - e.progress : 0
      items.push({
        id: s.id, idMal: s.idMal, title: s.title, cover: s.cover, banner: s.banner, color: s.color,
        format: s.format, episodes: s.episodes, aired: s.aired, status: s.status, year: s.year,
        genres: s.genres.slice(0, 3), score: s.score, popularity: s.popularity,
        listStatus: e.status, progress: e.progress, updatedAt: e.updatedAt,
        left, minutes: left * (s.duration || 24),
        finish: info, match, why: explainMatch(s, list.affinity),
        parts: { q: Math.round(q * 100), f: Math.round(f * 100), m: match },
        value,
        verdict: value >= KEEP_GOING ? "keep" : value >= YOUR_CALL ? "call" : "drop",
        gem: isGem(s),
        sequel: s.sequel,
      })
    }
    items.sort((a, b) => b.value - a.value)
    // The usual finish and drop rates in your backlog, sequels apart.
    const typical = (kind: string, sequel: boolean) =>
      median(items.filter((i) => i.finish && i.finish.kind === kind && i.finish.sequel === sequel).map((i) => i.finish.rate))
    return {
      items,
      typical: { finish: typical("finish", false), finishSeq: typical("finish", true), drop: typical("drop", false), dropSeq: typical("drop", true) },
    }
  }

  // The shows you rated clearly above your average (or, with few scores, the
  // ones you completed), weighted by how much you liked them.
  function recSources(list: any): { id: number, w: number }[] {
    const entries: ListEntry[] = list.entries
    const sd = Math.max(list.sd, 5)
    const scored = entries
      .filter((e) => e.score > 0 && e.status !== "DROPPED" && e.status !== "PLANNING" && (e.score - list.mean) / sd >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SOURCES)
      .map((e) => ({ id: e.id, w: 0.5 + Math.min(2, (e.score - list.mean) / sd) }))
    if (scored.length >= 15) return scored
    const completed = entries
      .filter((e) => e.score === 0 && (e.status === "COMPLETED" || e.status === "REPEATING"))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SOURCES - scored.length)
      .map((e) => ({ id: e.id, w: 0.4 }))
    return scored.concat(completed)
  }

  // Shows recommended on AniList for the ones you liked, that aren't in your
  // list in any status. Strength: how many of your favourites point at it and
  // how strongly people agree with each recommendation.
  function recCandidates(list: any, shows: { [id: string]: Show }): { id: number, strength: number, from: { [id: string]: number } }[] {
    const inList: { [id: string]: boolean } = {}
    for (const e of (list.entries as ListEntry[])) inList[String(e.id)] = true
    const acc: { [id: string]: { id: number, strength: number, from: { [id: string]: number } } } = {}
    for (const src of recSources(list)) {
      const s = shows[String(src.id)]
      if (!s) continue
      for (const r of s.recs) {
        if (r[1] <= 0 || inList[String(r[0])]) continue
        const k = String(r[0])
        const c = acc[k] || (acc[k] = { id: r[0], strength: 0, from: {} })
        const v = src.w * Math.log(1 + r[1])
        c.strength += v
        c.from[String(src.id)] = (c.from[String(src.id)] || 0) + v
      }
    }
    const out: any[] = []
    for (const k in acc) out.push(acc[k])
    out.sort((a, b) => b.strength - a.strength)
    return out.slice(0, MAX_REC_CANDIDATES)
  }

  function buildRecs(list: any, shows: { [id: string]: Show }, candidates: any[]): any[] {
    const pool = candidates.filter((c) => {
      const s = shows[String(c.id)]
      // Sequels of shows you haven't seen are no use; Seanime lists the
      // missed sequels of the ones you have.
      return s && !s.adult && !s.sequel && s.status !== "NOT_YET_RELEASED" && s.format !== "MUSIC" && s.score > 0
    })
    const maxStrength = pool.reduce((m, c) => Math.max(m, c.strength), 0) || 1
    const recs = pool.map((c) => {
      const s = shows[String(c.id)]
      const match = matchOf(s, list.affinity)
      const value = Math.round(100 * (0.45 * (match / 100) + 0.35 * quality(s) + 0.2 * Math.sqrt(c.strength / maxStrength)))
      const because: string[] = []
      const from: any[] = []
      for (const id in c.from) from.push([id, c.from[id]])
      from.sort((a, b) => b[1] - a[1])
      for (const f of from.slice(0, 3)) if (shows[f[0]]) because.push(shows[f[0]].title)
      return {
        id: s.id, title: s.title, cover: s.cover, banner: s.banner, color: s.color,
        format: s.format, episodes: s.episodes, status: s.status, year: s.year,
        genres: s.genres.slice(0, 3), studios: s.studios.slice(0, 2), score: s.score, popularity: s.popularity,
        match, why: explainMatch(s, list.affinity), because, value, gem: isGem(s),
      }
    })
    recs.sort((a, b) => b.value - a.value)
    // The best overall, plus every hidden gem: they have fewer recommendations
    // pointing at them, so they would rarely make the cut on their own.
    return recs.filter((r, i) => i < MAX_RECS || r.gem)
  }

  // ---------------------------------------------------------------------------
  // Episode scores (MyAnimeList)
  // ---------------------------------------------------------------------------

  // [[episode, score 1-5]] from the episode list on MyAnimeList, where people
  // vote on each episode. Jikan (an API over the same data) is the fallback.
  async function malEpisodes(mal: number): Promise<number[][]> {
    const eps: number[][] = []
    for (let offset = 0; offset < 1000; offset += 100) {
      const url = "https://myanimelist.net/anime/" + mal + "/x/episode" + (offset ? "?offset=" + offset : "")
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept": "text/html" } })
      if (!res.ok) throw new Error("MyAnimeList HTTP " + res.status)
      const html: string = await res.text()
      const rows = html.split('class="episode-list-data"').slice(1)
      for (const row of rows) {
        const n = /class="episode-number[^"]*"[^>]*data-raw="(\d+)"/.exec(row)
        const s = /class="episode-poll[^"]*"[^>]*data-raw="([\d.]+)"/.exec(row)
        if (n) eps.push([Number(n[1]), s ? Number(s[1]) : 0])
      }
      if (rows.length < 100) break
    }
    return eps
  }

  async function jikanEpisodes(mal: number): Promise<number[][]> {
    const eps: number[][] = []
    for (let page = 1; page <= 10; page++) {
      const res = await fetch("https://api.jikan.moe/v4/anime/" + mal + "/episodes?page=" + page, { headers: { "Accept": "application/json" } })
      if (!res.ok) throw new Error("Jikan HTTP " + res.status)
      const j: any = await res.json()
      for (const e of (j.data || [])) if (e && e.mal_id) eps.push([e.mal_id, e.score || 0])
      if (!j.pagination || !j.pagination.has_next_page) break
    }
    return eps
  }

  async function episodes(mal: number): Promise<any> {
    const cache: any = $storage.get(EPS_KEY) || {}
    const hit = cache[String(mal)]
    if (hit && Date.now() - hit.at < EPS_TTL) return hit
    let eps: number[][] = []
    let error = ""
    try { eps = await malEpisodes(mal) } catch (e) { error = String(e) }
    if (!eps.some((x) => x[1] > 0)) {
      try {
        const j = await jikanEpisodes(mal)
        if (j.some((x) => x[1] > 0)) eps = j
      } catch (e) { error = error || String(e) }
    }
    eps.sort((a, b) => a[0] - b[0])
    if (!eps.some((x) => x[1] > 0)) {
      // Keep an older answer rather than nothing.
      if (hit) return hit
      return { at: Date.now(), eps: [], error: error ? "MyAnimeList didn't answer, try again later." : "No episode scores on MyAnimeList." }
    }
    const result = { at: Date.now(), eps }
    cache[String(mal)] = result
    const keys = Object.keys(cache).sort((a, b) => cache[a].at - cache[b].at)
    while (keys.length > MAX_EPS_CACHED) delete cache[keys.shift() as string]
    $storage.set(EPS_KEY, cache)
    return result
  }

  // ---------------------------------------------------------------------------
  // Your list: planning
  // ---------------------------------------------------------------------------

  function addToPlanning(mediaId: number): boolean {
    try {
      $anilist.updateEntry(mediaId, "PLANNING" as any, undefined, undefined, undefined, undefined)
      $anilist.refreshAnimeCollection()
      // The next load sees it in your list and stops recommending it.
      const list = $storage.get(LIST_KEY)
      if (list) { list.at = 0; $storage.set(LIST_KEY, list) }
      return true
    } catch (e) {
      console.error("Backlog: add to planning: " + e)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  function cleanPrefs(p: any): any {
    p = p || {}
    const tabs = ["backlog", "recs"]
    const sorts = ["best", "almost", "short", "recent"]
    const recSorts = ["best", "gems", "score"]
    const statuses = Array.isArray(p.statuses) ? p.statuses.filter((s: string) => BACKLOG_STATUSES[s]) : ["CURRENT", "PAUSED", "DROPPED"]
    return {
      tab: tabs.indexOf(p.tab) >= 0 ? p.tab : "backlog",
      sort: sorts.indexOf(p.sort) >= 0 ? p.sort : "best",
      recSort: recSorts.indexOf(p.recSort) >= 0 ? p.recSort : "best",
      statuses,
      gemsOnly: !!p.gemsOnly,
      showDrop: !!p.showDrop,
    }
  }

  function readPrefs(): any {
    try { return cleanPrefs($storage.get(PREFS_KEY)) } catch (e) { return cleanPrefs(null) }
  }

  function savePrefs(p: any): any {
    const prefs = cleanPrefs(Object.assign({}, readPrefs(), p || {}))
    $storage.set(PREFS_KEY, prefs)
    return prefs
  }

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  async function load(force: boolean): Promise<any> {
    const prefs = readPrefs()
    try {
      const token = $database.anilist.getToken()
      if (!token) return { error: "Not logged in to AniList: log in in Seanime.", prefs }
      const list = readList(token, viewerId(token), force)
      const shows: { [id: string]: Show } = $storage.get(SHOWS_KEY) || {}

      const backlogIds = (list.entries as ListEntry[]).filter((e) => BACKLOG_STATUSES[e.status]).map((e) => e.id)
      const sourceIds = recSources(list).map((s) => s.id)
      await fetchShows(token, shows, backlogIds.concat(sourceIds), force)
      const candidates = recCandidates(list, shows)
      await fetchShows(token, shows, candidates.map((c) => c.id), force)

      // Keep only what's still in use.
      const keep: { [id: string]: Show } = {}
      for (const id of backlogIds.concat(sourceIds, candidates.map((c) => c.id))) if (shows[String(id)]) keep[String(id)] = shows[String(id)]
      $storage.set(SHOWS_KEY, keep)

      return buildPayload(list, keep, prefs)
    } catch (e) {
      console.error("Backlog: " + e)
      const stale = cachedPayload()
      if (stale) return Object.assign(stale, { loading: false, warning: "Couldn't refresh: " + e })
      return { error: "Couldn't load your list: " + e, prefs }
    }
  }

  // What the page shows, from cached data only (any age); null before the
  // first load. `fresh` says whether it still needs a refresh.
  function cachedPayload(): any {
    const list = $storage.get(LIST_KEY)
    const shows = $storage.get(SHOWS_KEY)
    if (!list || !list.entries || !shows) return null
    const p = buildPayload(list, shows, readPrefs())
    p.fresh = Date.now() - list.at < LIST_TTL
    return p
  }

  function buildPayload(list: any, shows: { [id: string]: Show }, prefs: any): any {
    const backlog = buildBacklog(list, shows)
    const recs = buildRecs(list, shows, recCandidates(list, shows))
    // Episode scores loaded earlier, for the shows on the page.
    const cache: any = $storage.get(EPS_KEY) || {}
    const eps: any = {}
    for (const i of backlog.items) if (i.idMal && cache[String(i.idMal)]) eps[String(i.idMal)] = cache[String(i.idMal)]
    return {
      backlog: backlog.items,
      typical: backlog.typical,
      recs,
      eps,
      planned: {},
      prefs,
      updatedAt: list.at,
      thresholds: { keep: KEEP_GOING, call: YOUR_CALL },
    }
  }

  // ---------------------------------------------------------------------------
  // Page (runs inside the webview iframe). A plain template literal: no
  // backslashes and no interpolation inside, so nothing to escape.
  // ---------------------------------------------------------------------------

  const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: #0b0b0d; --paper: #131317; --paper2: #1a1a20; --line: #26262e;
    --text: #ececf1; --muted: #8a8a96; --brand: #7c6cf2; --on-brand: #fff;
    --yellow: #e6b422; --green: #3fbf6a; --blue: #5b8def; --red: #ff8a8a; --gem: #4fd1c5;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); color-scheme: dark; }
  html, body { margin: 0; color: var(--text); font: 14px/1.4 Inter, "Segoe UI", system-ui, sans-serif; }
  body { position: relative; overflow-x: hidden; }
  .hero { position: absolute; top: 0; left: 0; right: 0; height: 440px; pointer-events: none;
    background-size: cover; background-position: center 30%; opacity: .5;
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 45%, transparent 100%); }
  .hero.cover { filter: blur(28px) saturate(1.4); transform: scale(1.15); opacity: .6; }
  .wrap { position: relative; padding: 8px 4px 32px; max-width: 1600px; margin: 0 auto; }
  h1 { margin: 0; font-weight: 700; letter-spacing: -.01em; }
  h2 { font-size: 17px; margin: 0; font-weight: 650; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button { font: inherit; color: var(--text); background: var(--paper2); border: 1px solid var(--line);
    border-radius: 10px; padding: 7px 13px; cursor: pointer; }
  button:hover { border-color: #3a3a46; background: #202028; }
  .seg { display: inline-flex; background: var(--paper2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; }
  .seg button { border: 0; background: transparent; padding: 5px 11px; border-radius: 8px; color: var(--muted); }
  .seg button.on { background: var(--brand); color: var(--on-brand); font-weight: 600; }
  .tabs button { padding: 7px 16px; font-size: 15px; }
  .chip-btn { border-radius: 99px; padding: 4px 11px; font-size: 13px; color: var(--muted); }
  .chip-btn.on { border-color: var(--brand); color: var(--text); background: color-mix(in srgb, var(--brand) 20%, var(--paper2)); }
  section { background: rgba(19,19,23,.86); backdrop-filter: blur(6px); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin-top: 16px; }
  .head { min-height: 170px; align-items: flex-end; padding-bottom: 6px; }
  .head h1 { font-size: 34px; text-shadow: 0 2px 12px rgba(0,0,0,.6); }
  .head .sub { font-size: 13px; color: #d4d4dc; text-shadow: 0 1px 6px rgba(0,0,0,.8); margin-top: 2px; }
  .group-head { display: flex; align-items: baseline; gap: 10px; margin: 18px 0 10px; }
  .group-head:first-child { margin-top: 4px; }
  .group-head h2 .dot { display: inline-block; width: 10px; height: 10px; border-radius: 99px; margin-right: 8px; }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 10px; }
  .card { display: flex; flex-direction: column; padding: 10px; background: var(--paper2); border: 1px solid var(--line);
    border-radius: 12px; cursor: pointer; position: relative; overflow: hidden; }
  .card:hover { border-color: var(--brand); }
  .card.wide { grid-column: 1 / -1; }
  .card .top { display: flex; gap: 12px; }
  .card img { width: 84px; height: 120px; object-fit: cover; border-radius: 8px; flex: none; background: #222; }
  .card .body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .t { font-weight: 650; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .meta { font-size: 12px; color: var(--muted); }
  .meta b { color: var(--text); font-weight: 600; }
  .genres { display: flex; flex-wrap: wrap; gap: 4px; }
  .genre { font-size: 11px; background: #23232b; border-radius: 99px; padding: 1px 7px; color: #b9b9c3; }
  .pills { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: auto; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: #23232b; color: #c4c4cc; }
  .pill.match { background: color-mix(in srgb, var(--brand) 22%, transparent); color: var(--text); }
  .pill.gem { background: rgba(79,209,197,.15); color: var(--gem); }
  .pill.v { font-weight: 650; cursor: help; }
  .v-keep { background: rgba(63,191,106,.18) !important; color: var(--green) !important; }
  .v-call { background: rgba(230,180,34,.16) !important; color: var(--yellow) !important; }
  .v-drop { background: rgba(140,140,150,.18) !important; color: #a8a8b2 !important; }
  .card.keep { border-left: 3px solid var(--green); }
  .card.call { border-left: 3px solid var(--yellow); }
  .card.drop { border-left: 3px solid #55555f; }
  .score { font-size: 12px; font-weight: 650; }
  .because { font-size: 12px; color: var(--muted); }
  .because b { color: #cfcfd8; font-weight: 550; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.06); }
  .progress div { height: 100%; background: var(--yellow); }
  .small { padding: 2px 9px; font-size: 12px; border-radius: 8px; }
  .actions { margin-left: auto; display: flex; gap: 6px; }

  /* Episode scores */
  .eps { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; cursor: default; }
  .bars { display: flex; align-items: flex-end; gap: 1px; height: 54px; margin: 6px 0 4px; }
  .bars i { flex: 1; min-width: 1px; background: color-mix(in srgb, var(--brand) 75%, #fff 0%); border-radius: 2px 2px 0 0; opacity: .95; }
  .bars i.seen { background: #4a4a55; }
  .bars i.none { background: transparent; border-bottom: 1px dashed #3a3a44; }
  .eps .sum { font-size: 12px; }
  .eps .sum .good { color: var(--green); }
  .eps .sum .bad { color: var(--red); }
  .axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); }

  #tip { position: absolute; display: none; z-index: 50; max-width: 360px; pointer-events: none;
    background: #1f1f27; border: 1px solid #34343f; border-radius: 10px; padding: 10px 12px; font-size: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  #tip b { font-size: 13px; display: block; margin-bottom: 6px; }
  #tip div { margin-top: 3px; }
  .tip-row { display: flex; gap: 8px; }
  .tip-label { flex: none; width: 96px; color: var(--muted); }
  .tip-label.good { color: var(--green); }
  .tip-label.bad { color: var(--red); }
  .tip-foot { color: var(--muted); font-size: 11px; margin-top: 8px !important; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .error { color: var(--red); }
  .note { font-size: 12px; color: var(--muted); }
  .more { width: 100%; margin-top: 10px; color: var(--muted); }
</style>
</head>
<body>
<div class="hero" id="hero"></div>
<div class="wrap" id="root"><div class="empty">Loading your list…</div></div>
<div id="tip"></div>
<script>
var DATA = null;
var PREFS = { tab: "backlog", sort: "best", recSort: "best", statuses: ["CURRENT", "PAUSED", "DROPPED"], gemsOnly: false, showDrop: false };
var OPEN_EPS = {};
var LOADING_EPS = {};
var FORMAT_NAME = { TV: "TV", TV_SHORT: "TV Short", ONA: "ONA", MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special", MUSIC: "Music" };
var LIST_NAME = { CURRENT: "Watching", PAUSED: "Paused", DROPPED: "Dropped" };
var VERDICT = { keep: "Keep going", call: "Your call", drop: "Let it go" };
var VERDICT_NOTE = {
  keep: "Rated well, most viewers finish it and it fits your taste.",
  call: "Good on some counts, not on others — hover the verdict to see which.",
  drop: "Weak on most counts. Fine to drop for good."
};

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function send(ev, p) { window.webview.send(ev, p || {}); }
function find(id) {
  var all = (DATA.backlog || []).concat(DATA.recs || []);
  for (var k = 0; k < all.length; k++) if (all[k].id === id) return all[k];
  return null;
}
function scoreText(i) { return i.score ? "★ " + (i.score / 10).toFixed(1) : "★ —"; }
function pct(x) { return x > 0 && x < 0.1 ? (Math.round(x * 1000) / 10) + "%" : Math.round(x * 100) + "%"; }

function hexToRgb(h) {
  if (!h || h.charAt(0) !== "#" || h.length !== 7) return null;
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
// Banner and accent colour of the top show on the open tab.
function applyTheme(top) {
  var hero = document.getElementById("hero");
  var img = top && (top.banner || top.cover);
  hero.style.backgroundImage = img ? 'url("' + String(img).replace(/"/g, "%22") + '")' : "none";
  hero.className = "hero" + (top && !top.banner ? " cover" : "");
  var css = document.documentElement.style;
  var rgb = top && hexToRgb(top.color);
  var brand = "#7c6cf2", onBrand = "#fff";
  if (rgb) {
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    var spread = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    if (lum > 0.22 && lum < 0.85 && spread > 40) { brand = top.color; onBrand = lum > 0.6 ? "#111" : "#fff"; }
  }
  css.setProperty("--brand", brand);
  css.setProperty("--on-brand", onBrand);
}

function ago(sec) {
  if (!sec) return "";
  var days = Math.floor((Date.now() / 1000 - sec) / 86400);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return days + " days ago";
  if (days < 365) { var m = Math.round(days / 30); return m + (m === 1 ? " month ago" : " months ago"); }
  var y = Math.round(days / 365); return y + (y === 1 ? " year ago" : " years ago");
}
function hours(min) {
  if (!min) return "";
  if (min < 60) return min + " min";
  var h = min / 60;
  return (h < 10 ? Math.round(h * 2) / 2 : Math.round(h)) + " h";
}

// ---------- tooltips ----------
function qualityWord(s) { return !s ? "no score yet" : s >= 80 ? "great" : s >= 72 ? "good" : s >= 65 ? "mixed" : "weak"; }
function cls(v) { return v >= 60 ? "good" : v <= 35 ? "bad" : ""; }
function row(label, c, text) { return '<div class="tip-row"><span class="tip-label ' + c + '">' + label + '</span><span>' + text + '</span></div>'; }
function finishText(i) {
  var f = i.finish;
  if (!f) return "Too few viewers on AniList to tell.";
  var ty = DATA.typical || {};
  var among = f.sequel ? " for a sequel" : " in your backlog";
  if (f.kind === "finish") {
    var t = f.sequel ? ty.finishSeq : ty.finish;
    return pct(f.rate) + " of those who start it finish it" + (t ? " (" + (f.rate >= t + 0.03 ? "more than" : f.rate <= t - 0.03 ? "fewer than" : "about") + " the usual " + pct(t) + among + ")" : "") + ".";
  }
  var d = f.sequel ? ty.dropSeq : ty.drop;
  return "Still airing: " + pct(f.rate) + " of viewers dropped it" + (d ? " (usual " + pct(d) + among + ")" : "") + ".";
}
function tasteText(w) {
  var out = "";
  if (w.p.length) out += "you like " + esc(w.p.join(", "));
  if (w.n.length) out += (out ? "; " : "") + "not your thing: " + esc(w.n.join(", "));
  return out || "nothing much in common with your list";
}
function verdictTip(i) {
  return '<b>' + VERDICT[i.verdict] + ' · ' + i.value + '/100</b>' +
    row("Rating", cls(i.parts.q), scoreText(i) + " — " + qualityWord(i.score) + ".") +
    row("Finish rate", cls(i.parts.f), esc(finishText(i))) +
    row("Your taste", cls(i.parts.m), i.match + "% match — " + tasteText(i.why) + ".") +
    '<div class="tip-foot">Rating counts 40%, your taste 35%, finish rate 25%. Episode scores (the Episodes button) are extra and don’t change the verdict.</div>';
}
function matchTip(i) {
  var w = i.why || { p: [], n: [] };
  var lines = '<b>' + i.match + '% match</b>';
  if (w.p.length) lines += row("You like", "good", esc(w.p.join(", ")));
  if (w.n.length) lines += row("Not your thing", "bad", esc(w.n.join(", ")));
  if (!w.p.length && !w.n.length) lines += '<div class="muted">Not enough in common with your list to tell — neutral.</div>';
  return lines + '<div class="tip-foot">From genres, studios and tags of what you scored and watched on AniList.</div>';
}
function gemTip() {
  return '<b>Hidden gem</b><div>Rated ★ 7.5 or higher on AniList, but fewer than 50,000 people have it in their list.</div>';
}
function tooltipHtml(el) {
  var kind = el.getAttribute("data-tip"), id = Number(el.getAttribute("data-id"));
  if (kind === "gem") return gemTip();
  var i = find(id);
  if (!i) return "";
  return kind === "verdict" ? verdictTip(i) : matchTip(i);
}
function showTip(el) {
  var tip = document.getElementById("tip");
  var html = tooltipHtml(el);
  if (!html) return hideTip();
  tip.innerHTML = html;
  tip.style.display = "block";
  var r = el.getBoundingClientRect();
  var left = Math.min(r.left + window.scrollX, document.documentElement.clientWidth - tip.offsetWidth - 8);
  var top = r.top + window.scrollY - tip.offsetHeight - 8;
  if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = top + "px";
}
function hideTip() { var tip = document.getElementById("tip"); if (tip) tip.style.display = "none"; }
document.addEventListener("mouseover", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-tip]") : null;
  if (el) showTip(el); else hideTip();
});
document.addEventListener("scroll", hideTip, true);

// ---------- header ----------
function renderHead() {
  var b = DATA.backlog || [];
  var keep = b.filter(function (i) { return i.verdict === "keep"; }).length;
  var sub = DATA.backlog ? b.length + " unfinished · " + keep + " worth continuing" : "";
  if (DATA.updatedAt) sub += (sub ? " · " : "") + "updated " + ago(DATA.updatedAt / 1000).replace("today", "just now");
  var tabs = [["backlog", "Worth continuing"], ["recs", "Recommended"]].map(function (t) {
    return '<button data-act="tab" data-v="' + t[0] + '" class="' + (PREFS.tab === t[0] ? "on" : "") + '">' + t[1] + '</button>';
  }).join("");
  return '<div class="row head"><div><h1>Backlog</h1><div class="sub">' + esc(sub) +
    (DATA.loading ? (sub ? ' · ' : '') + 'loading…' : '') +
    (DATA.warning ? ' · <span class="error">' + esc(DATA.warning) + '</span>' : '') + '</div></div><span class="spacer"></span>' +
    '<span class="seg tabs">' + tabs + '</span>' +
    '<button data-act="refresh" title="Fetch your list and the shows again from AniList">Refresh</button></div>';
}

// ---------- worth continuing ----------
function seg(name, cur, opts) {
  return '<span class="seg">' + opts.map(function (o) {
    return '<button data-act="' + name + '" data-v="' + o[0] + '" class="' + (cur === o[0] ? "on" : "") + '">' + o[1] + '</button>';
  }).join("") + '</span>';
}
function backlogItems() {
  var items = (DATA.backlog || []).filter(function (i) {
    if (PREFS.statuses.indexOf(i.listStatus) < 0) return false;
    if (PREFS.gemsOnly && !i.gem) return false;
    return true;
  });
  var key = PREFS.sort;
  items.sort(function (a, b) {
    if (key === "almost") return ((a.left || 999) - (b.left || 999)) || (b.value - a.value);
    if (key === "short") return ((a.minutes || 99999) - (b.minutes || 99999)) || (b.value - a.value);
    if (key === "recent") return (b.updatedAt - a.updatedAt) || (b.value - a.value);
    return b.value - a.value;
  });
  return items;
}
function epsBlock(i) {
  if (!OPEN_EPS[i.id]) return "";
  var e = (DATA.eps || {})[String(i.idMal)];
  if (!e) return '<div class="eps"><div class="note">Loading episode scores from MyAnimeList…</div></div>';
  if (!e.eps || !e.eps.length || e.error) return '<div class="eps"><div class="note">' + esc(e.error || "No episode scores on MyAnimeList.") + '</div></div>';
  var scored = e.eps.filter(function (x) { return x[1] > 0; });
  var min = 5, max = 1;
  scored.forEach(function (x) { min = Math.min(min, x[1]); max = Math.max(max, x[1]); });
  var lo = Math.max(1, Math.min(min - 0.15, max - 0.6)), hi = Math.max(max, lo + 0.6);
  var bars = e.eps.map(function (x) {
    if (!x[1]) return '<i class="none" title="Ep ' + x[0] + ': no score" style="height:2px"></i>';
    var h = 8 + Math.round((x[1] - lo) / (hi - lo) * 46);
    return '<i class="' + (x[0] <= i.progress ? "seen" : "") + '" title="Ep ' + x[0] + ': ' + x[1].toFixed(2) + '" style="height:' + h + 'px"></i>';
  }).join("");
  return '<div class="eps"><div class="sum">' + trendText(i, scored) + '</div><div class="bars">' + bars + '</div>' +
    '<div class="axis"><span>Ep 1</span><span>Episode scores on MyAnimeList, 1–5 · grey: watched</span><span>Ep ' + e.eps[e.eps.length - 1][0] + '</span></div></div>';
}
// Whether the show gets better or worse after the episode you stopped at.
function trendText(i, scored) {
  var avg = function (xs) { return xs.reduce(function (a, x) { return a + x[1]; }, 0) / xs.length; };
  var best = scored.reduce(function (b, x) { return x[1] > b[1] ? x : b; }, scored[0]);
  var bestText = ' Best: ep ' + best[0] + ' (' + best[1].toFixed(2) + ').';
  var before = scored.filter(function (x) { return x[0] <= Math.max(i.progress, 1); });
  var after = scored.filter(function (x) { return x[0] > Math.max(i.progress, 1); });
  if (!after.length) return 'Average ' + avg(scored).toFixed(2) + '.' + bestText;
  var a = avg(after), b = avg(before), d = a - b;
  var head = i.progress ? 'After your ep ' + i.progress + ': ' : 'After ep 1: ';
  var verdict = d >= 0.1 ? '<span class="good">gets better</span>' : d <= -0.1 ? '<span class="bad">gets worse</span>' : 'about the same';
  return head + verdict + ' — ' + a.toFixed(2) + ' vs ' + b.toFixed(2) + ' so far.' + bestText;
}
function backlogCard(i) {
  var avail = i.aired || i.episodes;
  var prog = 'Ep <b>' + i.progress + '</b> / ' + (i.episodes || "?") + (i.status === "RELEASING" && avail ? ' (' + avail + ' out)' : '');
  var left = i.left ? ' · ' + i.left + ' left' + (i.minutes ? ', ~' + hours(i.minutes) : '') : '';
  var bar = avail ? '<div class="progress"><div style="width:' + Math.min(100, Math.round(i.progress / (i.episodes || avail) * 100)) + '%"></div></div>' : '';
  var epsBtn = i.idMal ? '<button class="small" data-act="eps" data-id="' + i.id + '" data-mal="' + i.idMal + '">' + (OPEN_EPS[i.id] ? "Hide episodes" : "Episodes") + '</button>' : '';
  return '<div class="card ' + i.verdict + (OPEN_EPS[i.id] ? " wide" : "") + '" data-open="' + i.id + '"><div class="top"><img src="' + esc(i.cover) + '" loading="lazy">' +
    '<div class="body"><div class="t">' + esc(i.title) + '</div>' +
    '<div class="meta">' + prog + esc(left) + '</div>' +
    '<div class="meta">' + esc(LIST_NAME[i.listStatus] || i.listStatus) + (i.updatedAt ? ' · last touched ' + esc(ago(i.updatedAt)) : '') + '</div>' +
    '<div class="genres">' + i.genres.map(function (g) { return '<span class="genre">' + esc(g) + '</span>'; }).join("") + '</div>' +
    '<div class="pills"><span class="pill v v-' + i.verdict + '" data-tip="verdict" data-id="' + i.id + '">' + VERDICT[i.verdict] + '</span>' +
    '<span class="score">' + scoreText(i) + '</span>' +
    '<span class="pill match" data-tip="match" data-id="' + i.id + '">' + i.match + '% match</span>' +
    (i.gem ? '<span class="pill gem" data-tip="gem">Hidden gem</span>' : '') +
    '<span class="actions">' + epsBtn + '</span></div></div></div>' +
    epsBlock(i) + bar + '</div>';
}
function renderBacklog() {
  var items = backlogItems();
  var sorts = seg("sort", PREFS.sort, [["best", "Best bets"], ["almost", "Almost done"], ["short", "Least time"], ["recent", "Recent"]]);
  var chips = [["CURRENT", "Watching"], ["PAUSED", "Paused"], ["DROPPED", "Dropped"]].map(function (s) {
    var n = (DATA.backlog || []).filter(function (i) { return i.listStatus === s[0]; }).length;
    return '<button class="chip-btn' + (PREFS.statuses.indexOf(s[0]) >= 0 ? " on" : "") + '" data-act="status" data-v="' + s[0] + '">' + s[1] + ' · ' + n + '</button>';
  }).join("") + '<span style="width:12px"></span><button class="chip-btn' + (PREFS.gemsOnly ? " on" : "") + '" data-act="gems">Hidden gems · ' + (DATA.backlog || []).filter(function (i) { return i.gem; }).length + '</button>';
  var groups = ["keep", "call", "drop"].map(function (v) {
    var g = items.filter(function (i) { return i.verdict === v; });
    if (!g.length) return "";
    var color = v === "keep" ? "var(--green)" : v === "call" ? "var(--yellow)" : "#6b6b76";
    var head = '<div class="group-head"><h2><span class="dot" style="background:' + color + '"></span>' + VERDICT[v] +
      ' <span class="muted">· ' + g.length + '</span></h2><span class="note">' + VERDICT_NOTE[v] + '</span></div>';
    if (v === "drop" && !PREFS.showDrop) return head + '<button class="more" data-act="show-drop">Show ' + g.length + ' more</button>';
    return head + '<div class="cards">' + g.map(backlogCard).join("") + '</div>';
  }).join("");
  return '<section><div class="row" style="margin-bottom:6px">' + chips + '<span class="spacer"></span>' + sorts + '</div>' +
    (items.length ? groups : '<div class="empty">' + (DATA.backlog && DATA.backlog.length ? "Nothing matches the filters." : "Nothing unfinished — you're all caught up.") + '</div>') + '</section>';
}

// ---------- recommended ----------
function renderRecs() {
  var items = (DATA.recs || []).filter(function (i) { return !PREFS.gemsOnly || i.gem; });
  var key = PREFS.recSort;
  items.sort(function (a, b) {
    if (key === "gems") return ((b.gem ? 1 : 0) - (a.gem ? 1 : 0)) || (b.value - a.value);
    if (key === "score") return b.score - a.score;
    return b.value - a.value;
  });
  var cards = items.map(function (i) {
    var planned = (DATA.planned || {})[String(i.id)];
    var plan = '<button class="small" data-act="plan" data-id="' + i.id + '"' + (planned ? ' disabled' : '') + ' title="Add to Planning on AniList">' + (planned ? "Added" : "+ Plan") + '</button>';
    return '<div class="card" data-open="' + i.id + '"><div class="top"><img src="' + esc(i.cover) + '" loading="lazy">' +
      '<div class="body"><div class="t">' + esc(i.title) + '</div>' +
      '<div class="meta">' + esc(FORMAT_NAME[i.format] || i.format) + (i.episodes ? ' · ' + i.episodes + ' eps' : '') + (i.year ? ' · ' + i.year : '') +
      (i.studios.length ? ' · ' + esc(i.studios.join(", ")) : '') + '</div>' +
      '<div class="genres">' + i.genres.map(function (g) { return '<span class="genre">' + esc(g) + '</span>'; }).join("") + '</div>' +
      (i.because.length ? '<div class="because">Because you liked <b>' + i.because.map(esc).join('</b>, <b>') + '</b></div>' : '') +
      '<div class="pills"><span class="score">' + scoreText(i) + '</span>' +
      '<span class="pill match" data-tip="match" data-id="' + i.id + '">' + i.match + '% match</span>' +
      (i.gem ? '<span class="pill gem" data-tip="gem">Hidden gem</span>' : '') +
      '<span class="actions">' + plan + '</span></div></div></div></div>';
  }).join("");
  var gems = (DATA.recs || []).filter(function (i) { return i.gem; }).length;
  return '<section><div class="row" style="margin-bottom:12px"><h2>Recommended <span class="muted">· ' + items.length + '</span></h2>' +
    '<span class="note">From AniList recommendations for the shows you rated above your average. Nothing already in your list.</span>' +
    '<span class="spacer"></span><button class="chip-btn' + (PREFS.gemsOnly ? " on" : "") + '" data-act="gems">Hidden gems · ' + gems + '</button>' +
    seg("rec-sort", PREFS.recSort, [["best", "For you"], ["gems", "Gems first"], ["score", "Top rated"]]) + '</div>' +
    (items.length ? '<div class="cards">' + cards + '</div>' : '<div class="empty">' + (DATA.recs && DATA.recs.length ? "No hidden gems among the recommendations." : "No recommendations yet: rate a few shows on AniList.") + '</div>') + '</section>';
}

function render() {
  var root = document.getElementById("root");
  if (!DATA) { root.innerHTML = '<div class="empty">Loading your list…</div>'; return; }
  var list = PREFS.tab === "recs" ? (DATA.recs || []) : (DATA.backlog || []);
  applyTheme(list[0] || null);
  var body = DATA.error ? '<section><div class="empty error">' + esc(DATA.error) + '</div></section>'
    : !DATA.backlog ? '<section><div class="empty">Loading your list and the shows in it… The first time takes a few seconds.</div></section>'
    : PREFS.tab === "recs" ? renderRecs() : renderBacklog();
  root.innerHTML = renderHead() + body;
}

function setPref(p) {
  for (var k in p) PREFS[k] = p[k];
  send("set-prefs", p);
  render();
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act],[data-open]") : null;
  if (!el || !DATA) return;
  var act = el.getAttribute("data-act"), v = el.getAttribute("data-v");
  if (act === "plan") { send("plan", { id: Number(el.getAttribute("data-id")) }); el.disabled = true; el.textContent = "Added"; return; }
  if (act === "eps") {
    var id = Number(el.getAttribute("data-id")), mal = Number(el.getAttribute("data-mal"));
    OPEN_EPS[id] = !OPEN_EPS[id];
    if (OPEN_EPS[id] && !(DATA.eps || {})[String(mal)] && !LOADING_EPS[mal]) { LOADING_EPS[mal] = true; send("episodes", { mal: mal }); }
    render();
    return;
  }
  if (ev.target.closest(".eps")) return;
  var open = el.getAttribute("data-open");
  if (open) { send("open", { id: Number(open) }); return; }
  if (act === "tab") { setPref({ tab: v }); window.scrollTo(0, 0); }
  else if (act === "refresh") { DATA.loading = true; render(); send("refresh"); }
  else if (act === "sort") setPref({ sort: v });
  else if (act === "rec-sort") setPref({ recSort: v });
  else if (act === "gems") setPref({ gemsOnly: !PREFS.gemsOnly });
  else if (act === "show-drop") setPref({ showDrop: true });
  else if (act === "status") {
    var s = PREFS.statuses.slice(), at = s.indexOf(v);
    if (at >= 0) s.splice(at, 1); else s.push(v);
    setPref({ statuses: s });
  }
});

window.webview.on("data", function (d) {
  DATA = d;
  if (d && d.prefs) PREFS = d.prefs;
  for (var k in (d && d.eps) || {}) LOADING_EPS[k] = false;
  render();
});
render();
</script>
</body>
</html>`

  return { ICON, PAGE_HTML, load, cachedPayload, episodes, addToPlanning, savePrefs, matchOf, buildBacklog }
}
