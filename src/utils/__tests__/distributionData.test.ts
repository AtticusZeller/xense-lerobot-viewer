import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  parseDistributionJson,
  parseEpisodeSelection,
} from "../distributionData";

const FIXTURE_PATH = path.join(
  import.meta.dir,
  "fixtures",
  "distribution.example.json",
);

describe("distributionData", () => {
  it("parses the synthetic lerobot-check distribution.example.json fixture", () => {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    const parsed = parseDistributionJson(raw);

    expect(parsed.version).toBe(1);
    expect(parsed.provenance.repo_id).toBe("Synthetic/demo");
    expect(parsed.provenance.position_point).toBe("tool_point");
    expect(parsed.provenance.annotated_episodes).toEqual([0, 2]);
    expect(parsed.coverage_config).toEqual({
      xy_bin_m: 0.05,
      yaw_bin_deg: 30,
      sparse_threshold: 2,
    });
    expect(parsed.frame_shares.total_frames).toBe(110);
    expect(parsed.objects).toHaveLength(2);
    expect(parsed.subtasks).toHaveLength(2);
    expect(parsed.subtasks[1].participating_arms).toEqual(["right", "left"]);
  });

  it("rejects malformed JSON and unsupported schema versions", () => {
    expect(() => parseDistributionJson("{bad")).toThrow(
      /Malformed distribution\.json/,
    );
    expect(() => parseDistributionJson(JSON.stringify({ version: 2 }))).toThrow(
      /Unsupported distribution\.json version/,
    );
  });

  it("parses episode ranges and lists matching lerobot-check syntax", () => {
    expect(parseEpisodeSelection("")).toEqual({ episodes: null, error: null });
    expect(parseEpisodeSelection("   ")).toEqual({
      episodes: null,
      error: null,
    });
    expect(parseEpisodeSelection("40")).toEqual({
      episodes: [40],
      error: null,
    });
    expect(parseEpisodeSelection("0-3, 10, 6:9", 100)).toEqual({
      episodes: [0, 1, 2, 3, 6, 7, 8, 10],
      error: null,
    });
    expect(parseEpisodeSelection(":3 8:", 10)).toEqual({
      episodes: [0, 1, 2, 8, 9],
      error: null,
    });
    // Deduplicates overlapping ranges and sorts ascending.
    expect(parseEpisodeSelection("5-7, 6-8, 5")).toEqual({
      episodes: [5, 6, 7, 8],
      error: null,
    });
  });

  it("rejects invalid episode range expressions", () => {
    expect(parseEpisodeSelection("abc").error).not.toBeNull();
    expect(parseEpisodeSelection("-5").error).not.toBeNull();
    expect(parseEpisodeSelection("10-5").error).not.toBeNull();
    expect(parseEpisodeSelection("10:10").error).not.toBeNull();
    expect(parseEpisodeSelection("10:5").error).not.toBeNull();
    expect(parseEpisodeSelection("1-2-3").error).not.toBeNull();
    expect(parseEpisodeSelection("1:2:3").error).not.toBeNull();
    expect(parseEpisodeSelection("50", 20).error).not.toBeNull();
    expect(parseEpisodeSelection("0-20", 20).error).not.toBeNull();
    expect(parseEpisodeSelection("0:21", 20).error).not.toBeNull();
  });
});
