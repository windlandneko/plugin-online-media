import { setHTTPHeaders, optionWasSet, optionWasSetLocally } from "./utils";
import { opt } from "./options";
import { currentURL, subtitleFormat } from "./ytdl-hook";
import { nativeMedia, appendSubtitles } from "./native-tracks";

import { subtitleTracks } from './subtitles'

const { core, console, global, mpv, menu } = iina;

interface Chapter {
  time: number;
  title: string;
}

export let chapterList: Chapter[] = [];

function matchTime(line: string): number | null {
  const match = line.match(/((\d+):)?(\d\d?):(\d\d)/);
  if (!match) return null;
  const [, , a, b, c] = match;
  return (a ? parseInt(a) : 0) * 3600 + parseInt(b) * 60 + parseInt(c);
}

function extractChapters(data: string, videoLength: number) {
  const lines = data.split(/\r|\n/);
  const result: Chapter[] = [];
  for (const line of lines) {
    if (!line) continue;
    const time = matchTime(line);
    if (time && time < videoLength) {
      result.push({ time: time, title: line });
    }
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

export function addVideo(json: YTDL.Entity) {
  const media = nativeMedia(json);
  const streamURL = opt.includeSubs
    ? appendSubtitles(media.url, subtitleTracks(json, opt.includeAutoSubs, subtitleFormat), media.duration)
    : media.url;
  for (const [kind, option] of [
    ["video", "vid"],
    ["audio", "aid"],
  ] as const) {
    if (
      !media.selectedKinds.includes(kind) &&
      !optionWasSet(option) &&
      !optionWasSetLocally(option)
    ) {
      mpv.set(`file-local-options/${option}`, "no");
    }
  }
  setHTTPHeaders(media.headers);
  mpv.set("stream-open-filename", streamURL);
  mpv.set("file-local-options/force-media-title", json.title);
  // add chapters
  if (json.chapters) {
    console.log("Adding pre-parsed chapters");
    for (let i = 0; i < json.chapters.length; i++) {
      const chapter = json.chapters[i];
      const title = chapter.title || `Chapter ${i}`;
      chapterList.push({ time: chapter.start_time, title: title });
    }
  } else if (json.description && json.duration) {
    chapterList = extractChapters(json.description, json.duration);
  }

  // set start time
  if (json.start_time && !optionWasSet("start") && !optionWasSetLocally("start")) {
    console.log(`Setting start to: ${json.start_time} secs`);
    mpv.set("file-local-options/start", json.start_time);
  }

  // set aspect ratio for anamorphic video
  if (json.stretched_ratio && !optionWasSet("video-aspect")) {
    mpv.set("file-local-options/video-aspect", json.stretched_ratio);
  }

  let streamOpts = mpv.getNative<Record<string, string>>("file-local-options/stream-lavf-o") || {};

  // for rtmp
  if (json.protocol == "rtmp") {
    streamOpts = {
      rtmp_tcurl: json.url,
      rtmp_pageurl: json.page_url,
      rtmp_playpath: json.play_path,
      rtmp_swfverify: json.player_url,
      rtmp_swfurl: json.player_url,
      rtmp_app: json.app,
      ...streamOpts,
    };
  }
  if (json.proxy) {
    Object.assign(streamOpts, { http_proxy: json.proxy });
  }

  mpv.set("file-local-options/stream-lavf-o", streamOpts);
  menu.removeAllItems();
  menu.addItem(
    menu.item(
      "Download this video",
      () => {
        core.osd("Preparing for download");
        global.postMessage("downloadVideo", currentURL);
      },
      { keyBinding: "Meta+d" },
    ),
  );
  menu.forceUpdate();
}
