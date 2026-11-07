import { edlEscape, edlTrackJoined, isSafeURL, ytdlCodecToMpvCodec } from './utils'
import type { SubtitleTrack } from './subtitles'

function videoLabel(f: YTDL.Video): string {
  const height = Math.round(f.height || 0)
  const resolution =
    ({ 1440: '2K', 2160: '4K', 4320: '8K' } as Record<number, string>)[height] ||
    (height ? `${height}P` : f.format_note || 'Video')
  const range = f.dynamic_range === 'DV' ? 'Dolby Vision' : f.dynamic_range
  return [resolution, range && range !== 'SDR' ? range : ''].filter(Boolean).join(' · ')
}

function audioLabel(f: YTDL.Video): string {
  const bitrate = f.abr || (f.vcodec === 'none' ? f.tbr : 0)
  const note = f.format_note || ''
  const special = /atmos/i.test(note) ? 'Dolby Atmos' : ''
  return (
    [
      special,
      bitrate ? `${Math.round(bitrate)}kbps` : '',
      /descriptive|description|original|dub/i.test(note) ? note : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Audio'
  )
}

function effectiveHeaders(json: YTDL.Entity, f: YTDL.Video) {
  return { ...json.http_headers, ...f.http_headers }
}

function headerKey(headers: Record<string, string>) {
  const entries = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)))
}

type MediaKind = 'video' | 'audio'
const mediaKinds = (f: YTDL.Video) =>
  (['video', 'audio'] as MediaKind[]).filter(
    (kind) =>
      f[kind === 'video' ? 'vcodec' : 'acodec'] &&
      f[kind === 'video' ? 'vcodec' : 'acodec'] !== 'none',
  )

function stream(url: string, metadata: string[], duration?: number) {
  return [
    '!new_stream',
    '!no_clip',
    '!no_chapters',
    ...metadata,
    edlEscape(url) + (duration > 0 ? `,length=${duration}` : ''),
    '',
  ].join(';')
}

function describeTracks(f: YTDL.Video) {
  return mediaKinds(f).map((kind) => {
    const codec = ytdlCodecToMpvCodec(kind === 'video' ? f.vcodec : f.acodec)
    const props =
      kind === 'video'
        ? `,w=${Math.round(f.width || 0)},h=${Math.round(f.height || 0)},fps=${Math.round(f.fps || 0)}`
        : f.asr
          ? `,samplerate=${Math.round(f.asr)}`
          : ''
    const title = kind === 'video' ? videoLabel(f) : audioLabel(f)
    const identity = JSON.stringify([kind, title, codec, props, f.language, f.audio_channels])
    return { title, codec, props, kind, identity }
  })
}

function selectFormats(
  json: YTDL.Entity,
  requested: YTDL.Video[],
  formats: YTDL.Video[],
  signature: string,
) {
  const seen = new Set<string>()
  const entries = []
  for (const f of [...formats].reverse()) {
    if (f.has_drm || f.protocol === 'mhtml') continue
    // mpv's HTTP headers apply to the whole file, including alternate tracks.
    if (headerKey(effectiveHeaders(json, f)) !== signature) continue
    const url =
      f.protocol === 'http_dash_segments'
        ? edlTrackJoined(f.fragments, f.protocol, json.is_live, f.fragment_base_url)
        : isSafeURL(f.url) && f.url
    const key = `${f.format_id}:${url}`
    if (!url || seen.has(key)) continue
    seen.add(key)
    entries.push({ f, url, tracks: describeTracks(f) })
  }
  const available = new Set(entries.map(({ f }) => f.format_id))
  if (requested.some((f) => !available.has(f.format_id))) {
    throw new Error('Selected formats have unsupported streams or incompatible HTTP headers')
  }
  return entries
}

export function nativeMedia(json: YTDL.Entity) {
  const requested = [json.requested_formats, json.requested_downloads].find(
    (formats) => formats?.length,
  ) || [json as YTDL.Video]
  const selected = new Set(requested.map((f) => f.format_id))
  const headers = effectiveHeaders(json, requested[0])
  const signature = headerKey(headers)
  const duration = !json.is_live && json.duration > 0 ? json.duration : undefined
  const formats = duration && json.formats?.length ? json.formats : requested
  const entries = selectFormats(json, requested, formats, signature)
  const counts = new Map<string, number>()
  for (const { tracks } of entries) {
    for (const { identity } of tracks) counts.set(identity, (counts.get(identity) || 0) + 1)
  }
  const url =
    'edl://' +
    entries
      .map(({ f, url, tracks }) => {
        const metadata = tracks.flatMap(({ title, codec, props, kind, identity }) => {
          if (counts.get(identity) > 1) title += ` · ${f.format_id}`
          return duration
            ? [
                `!delay_open,media_type=${kind}${codec ? `,codec=${edlEscape(codec)}` : ''}${props}`,
                `!track_meta,title=${edlEscape(title)}${f.language ? `,lang=${edlEscape(f.language)}` : ''}${selected.has(f.format_id) ? ',flags=default' : ''}`,
              ]
            : []
        })
        return stream(url, metadata, duration)
      })
      .join('')
  return {
    url,
    headers,
    selectedKinds: (['video', 'audio'] as MediaKind[]).filter((kind) =>
      requested.some((f) => f[kind === 'video' ? 'vcodec' : 'acodec'] !== 'none'),
    ),
    duration,
  }
}

// Batch captions to avoid thousands of track-list updates.
export function appendSubtitles(url: string, tracks: SubtitleTrack[], duration?: number): string {
  for (const { language, title, source } of tracks) {
    const resource = source.data ? `memory://${source.data}` : source.url
    const codec = ytdlCodecToMpvCodec(source.ext)
    url += stream(
      resource,
      [
        `!delay_open,media_type=sub${codec ? `,codec=${codec}` : ''}`,
        `!track_meta,title=${edlEscape(title)},lang=${edlEscape(language)}`,
      ],
      duration,
    )
  }
  return url
}
