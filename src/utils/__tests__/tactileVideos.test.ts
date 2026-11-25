import { describe, expect, test } from "bun:test";
import type { VideoInfo } from "@/types";
import {
  defaultHiddenVideoFilenames,
  isTactileVideo,
} from "@/utils/tactileVideos";

const video = (filename: string): VideoInfo => ({
  filename,
  url: `/${filename}.mp4`,
});

describe("tactile cameras", () => {
  test("matches a whole tactile token only", () => {
    expect(isTactileVideo("observation.images.left_tactile_left")).toBe(true);
    expect(isTactileVideo("observation.images.tactile-0")).toBe(true);
    expect(isTactileVideo("observation.images.left_wrist")).toBe(false);
    expect(isTactileVideo("observation.images.tactiles")).toBe(false);
  });

  test("hides every tactile stream by default", () => {
    const videos = [
      "observation.images.head",
      "observation.images.left_wrist",
      "observation.images.left_tactile_left",
      "observation.images.right_tactile_right",
    ].map(video);
    expect(defaultHiddenVideoFilenames(videos)).toEqual([
      "observation.images.left_tactile_left",
      "observation.images.right_tactile_right",
    ]);
  });

  test("keeps tactile streams when nothing else would be visible", () => {
    const videos = [
      "observation.images.left_tactile_left",
      "observation.images.left_tactile_right",
    ].map(video);
    expect(defaultHiddenVideoFilenames(videos)).toEqual([]);
  });
});
