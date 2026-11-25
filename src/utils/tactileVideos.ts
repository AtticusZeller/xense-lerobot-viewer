import type { VideoInfo } from "@/types";
import { videoNameTokens } from "@/utils/urdfReplayVideos";

/** A camera whose feature key carries a whole `tactile` token. */
export function isTactileVideo(filename: string): boolean {
  return videoNameTokens(filename).includes("tactile");
}

/**
 * Cameras the episode player starts with hidden: every tactile stream, so the
 * page opens on the scene cameras. A dataset recorded only with tactile
 * cameras keeps them all, since a player with nothing visible offers no way
 * to restore one.
 */
export function defaultHiddenVideoFilenames(videos: VideoInfo[]): string[] {
  const tactile = videos
    .map((video) => video.filename)
    .filter((filename) => isTactileVideo(filename));
  return tactile.length < videos.length ? tactile : [];
}
