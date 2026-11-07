import { isSafeURL } from './utils'

const languageTag = '(?:ai-)?[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?(?:-orig)?'

const canonicalLanguage = new RegExp(`^${languageTag}$`)

function locale(language: string) {
  return new Intl.Locale(language.replace(/^ai-/, '').replace(/-orig$/, '')).maximize()
}

export function preferredSubtitleLanguages(): string[] {
  const languages = (iina.mpv.getNative<string[]>('options/slang') || [])
    .map((language) => language.trim())
    .filter(Boolean)
  return languages.length ? languages : iina.utils.preferredLocalizations()
}

export function subtitleLanguagePattern(languages: string[]): string {
  return (
    [...new Set(languages.map((language) => locale(language).language))]
      .map((language) => `(?-i:${languageTag.replace('[a-z]{2,3}', language)})`)
      .join(',') || '(?!)'
  )
}

export function subtitleLanguageMatcher(preferences: string[]) {
  const key = (language: string) => {
    const tag = locale(language)
    return `${tag.language}-${tag.script}`
  }
  const preferred = new Set(preferences.map(key))
  return (language: string) => canonicalLanguage.test(language) && preferred.has(key(language))
}

export interface SubtitleTrack {
  language: string
  title: string
  source: YTDL.Subtitle
}

// Preserve --sub-format order, choosing the last source for each encoding.
function subtitleFormatSelector(format: string) {
  const priority = new Map(
    format
      .split('/')
      .map((ext, index) => [ext, index] as const)
      .reverse(),
  )
  const best = priority.get('best') ?? Infinity
  return (sources: YTDL.Subtitle[]) => {
    let selected: YTDL.Subtitle
    let rank = Infinity
    for (const source of sources) {
      const candidate = Math.min(priority.get(source.ext) ?? Infinity, best)
      if (candidate <= rank) {
        selected = source
        rank = candidate
      }
    }
    return selected
  }
}

export function subtitleTracks(json: YTDL.Entity, auto: boolean, format: string): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = []
  const selectFormat = subtitleFormatSelector(format)
  const seen = new Set<string>()
  const requestedSubtitles = { ...json.requested_subtitles }
  const original =
    json.language ||
    Object.keys(json.automatic_captions || {}).find((language) => language.endsWith('-orig'))
  if (original && original !== 'und') {
    const matchesOriginal = subtitleLanguageMatcher([original])
    const available = { ...(auto ? json.automatic_captions : {}), ...json.subtitles }
    for (const [language, sources] of Object.entries(available)) {
      if (matchesOriginal(language) && sources.length) {
        requestedSubtitles[language] ||= selectFormat(sources)
      }
    }
  }
  for (const [language, requested] of Object.entries(requestedSubtitles)) {
    const manual = json.subtitles?.[language] || []
    const requestedAuto = requested._auto ?? !manual.length
    for (const automatic of auto ? [false, true] : [false]) {
      const source =
        automatic === requestedAuto
          ? requested
          : selectFormat((automatic ? json.automatic_captions : json.subtitles)?.[language] || [])
      if (!source || (!source.data && !isSafeURL(source.url))) continue
      const key = source.data || source.url
      if (seen.has(key)) continue
      seen.add(key)
      tracks.push({
        language: language.replace(/^ai-/, '').replace(/-orig$/, ''),
        title: `${source.name || language}${automatic ? ' · Auto' : ''}`,
        source,
      })
    }
  }
  return tracks
}
