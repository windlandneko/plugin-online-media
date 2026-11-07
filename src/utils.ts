const { console, mpv } = iina;

const safeProtos = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "rtmp",
  "rtmps",
  "rtmpe",
  "rtmpt",
  "rtmpts",
  "rtmpte",
  "data",
]);

export function ytdlCodecToMpvCodec(codec?: string) {
  if (!codec || codec === 'none') return null
  const aliases: Record<string, string> = {
    vtt: 'webvtt', srt: 'subrip', ssa: 'ass', ttml: 'ttml',
    m4a: 'aac', h265: 'hevc',
  }
  if (aliases[codec]) return aliases[codec]
  if (/^(vp09|vp9)/.test(codec)) return 'vp9'
  if (/^(avc|h264)/.test(codec)) return 'h264'
  if (/^(av01|av1)/.test(codec)) return 'av1'
  if (codec.startsWith('mp4a')) return 'aac'
  if (/^(hev|hvc|dvhe|dvh1)/.test(codec)) return 'hevc'
  if (codec === 'ec-3') return 'eac3'
  if (codec === 'ac-3') return 'ac3'
  return codec
}

export function optionWasSet(name: string) {
  return mpv.getFlag(`option-info/${name}/set-from-commandline`);
}

export function optionWasSetLocally(name: string) {
  return mpv.getFlag(`option-info/${name}/set-locally`);
}

export function setHTTPHeaders(headers?: Record<string, string>) {
  if (!headers) return;

  const mpvHeaders: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) continue
    if (name === 'user-agent') {
      if (value && !optionWasSet('user-agent')) mpv.set('file-local-options/user-agent', value)
    } else if (!['host', 'content-length', 'connection'].includes(name)) {
      mpvHeaders.push(`${name}: ${value}`)
    }
  }

  if (mpvHeaders.length > 0 && !optionWasSet("http-header-fields")) {
    mpv.set("file-local-options/http-header-fields", mpvHeaders);
  }
}

export function edlEscape(url: string) {
  // EDL counts UTF-8 bytes, while JavaScript string.length counts UTF-16 units.
  const bytes = encodeURIComponent(url).replace(/%[A-F\d]{2}/gi, '_').length
  return `%${bytes}%${url}`;
}

export function isSafeURL(url: string) {
  if (typeof url !== "string") return;
  const match = url.match(/^(.+?):\/\//);
  if (match && match[1] && safeProtos.has(match[1])) {
    return true;
  }
  console.warn("Ignoring unsafe stream URL");
  return false;
}

export function getIndexFromYouTubePlaylist(url: string, json: YTDL.Playlist) {
  if (!json.extractor || json.extractor !== "youtube:playlist") return null;

  const index = url.indexOf("?");
  if (index < 0 || index === url.length - 1) return null;
  const query = url
    .substr(index + 1)
    .split("&")
    .map((x) => x.split("="));

  const args: Record<string, string> = {};
  query.forEach(([name, value]) => (args[name] = value));

  const maybeIdx = parseInt(args.index);

  if (maybeIdx && json.entries.length >= maybeIdx && json.entries[maybeIdx].id === args.v) {
    console.log("index matches requested video");
    return maybeIdx;
  }

  const idx = json.entries.findIndex((e) => e.id === args.v);
  if (idx >= 0) return idx;

  console.log("requested video not found in playlist");
  return null;
}

function joinURL(baseURL: string, fragment: YTDL.URLLike) {
  if (baseURL && fragment.path) {
    // make absolute url
    const url = fragment.path;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    const [, proto, domain, rest] = baseURL.match(/(https?:\/\/)([^/]+\/)(.*)\/?/);
    const segs = rest.split("/").concat(url.split("/"));
    const resolved: string[] = [];
    for (const seg of segs) {
      if (seg === "..") {
        resolved.pop();
      } else if (seg !== ".") {
        resolved.push(seg);
      }
    }
    return `${proto}${domain}${resolved.join("/")}`;
  } else {
    return fragment.url || "";
  }
}

export function edlTrackJoined(
  fragments: YTDL.URLLike[],
  protocol?: YTDL.Protocol,
  isLive?: boolean,
  base?: string,
) {
  if (!fragments || fragments.length === 0) {
    console.log("No fragments to join into EDL");
    return null;
  }

  const dash = protocol === 'http_dash_segments' && !isLive
  const parts: string[] = dash ? ['!mp4_dash'] : []
  for (const [index, frag] of fragments.entries()) {
    const url = joinURL(base, frag)
    if (!isSafeURL(url)) return null
    if (dash && index === 0 && !frag.duration) {
      if (fragments.length === 1) return null
      parts[0] += `,init=${edlEscape(url)}`
      continue
    }
    if (dash && !(frag.duration > 0)) return null
    parts.push(edlEscape(url) + (frag.duration ? `,length=${frag.duration}` : ''))
  }

  return `edl://${parts.join(";")};`;
}

export function formatFileSize(bytes: number, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return bytes + " B";
  }

  const units = si
    ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
    : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

  return bytes.toFixed(dp) + " " + units[u];
}

export function formatSeconds(sec: number | null | undefined) {
  if (sec == null || isNaN(sec)) return "-";
  return new Date(sec * 1000).toISOString().substring(sec < 3600 ? 14 : 11, 19);
}

/** Split literal CLI options, without shell expansion or command substitution. */
export function splitArguments(input: string): string[] {
  const args: string[] = []
  let word = ''
  let quote = ''
  let started = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (!quote && /\s/.test(char)) {
      if (started) args.push(word)
      word = ''
      started = false
      continue
    }
    started = true
    if (char === '\\' && quote !== "'" && index + 1 < input.length) {
      word += input[++index]
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else {
      word += char
    }
  }
  if (started) args.push(word)
  return args
}
