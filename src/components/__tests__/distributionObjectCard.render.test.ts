import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DistributionObjectCard } from "@/components/distribution-object-card";
import { LocaleProvider } from "@/context/locale-context";
import type {
  DistributionFile,
  DistributionObjectEntry,
  DistributionObjectLayer,
  DistributionObjectLayerKind,
  DistributionObjectLayerPose,
} from "@/types/distribution.types";
import { parseDistributionJson } from "@/utils/distributionData";

const FIXTURE = fs.readFileSync(
  path.join(
    import.meta.dir,
    "../../utils/__tests__/fixtures/distribution.example.json",
  ),
  "utf-8",
);

function baseFile(): DistributionFile {
  return parseDistributionJson(FIXTURE);
}

function layerPose(
  episode: number,
  x: number,
  y: number,
  foldedYaw: number,
): DistributionObjectLayerPose {
  return {
    episode_index: episode,
    frame: 0,
    arm: "right",
    x_m: x,
    y_m: y,
    z_m: -0.42,
    raw_yaw_deg: foldedYaw + 180,
    folded_yaw_deg: foldedYaw,
    length_m: 0.15,
    width_m: 0.07,
  };
}

function objectLayer(
  poses: DistributionObjectLayerPose[],
  skipped: DistributionObjectLayer["skipped"] = [],
): DistributionObjectLayer {
  return {
    source: "head_mask",
    frame: 0,
    arm: "right",
    plane_z_m: -0.42,
    yaw_period_deg: 180,
    poses,
    skipped,
    coverage: {
      sample_count: poses.length,
      xy_bin_m: 0.05,
      yaw_bin_deg: 30,
      sparse_threshold: 2,
      num_yaw_bins: 6,
      ix_range: null,
      iy_range: null,
      bins: [],
    },
  };
}

function render(
  file: DistributionFile,
  obj: DistributionObjectEntry,
  layer: DistributionObjectLayerKind,
): string {
  const episodes = [0, 1, 2, 3];
  const layerSwitchAvailable = file.objects.some(
    (o) => o.object_layer !== undefined,
  );
  return renderToStaticMarkup(
    React.createElement(
      LocaleProvider,
      { initialLocale: "en" },
      React.createElement(DistributionObjectCard, {
        encodedPath: "x",
        objectEntry: obj,
        layer,
        layerSwitchAvailable,
        coverageConfig: file.coverage_config,
        selectedEpisodes: new Set(episodes),
        selectedEpisodeList: episodes,
        colorResolver: { colorOf: () => "#38bdf8", groupNameOf: () => "g" },
        positionPoint: "tool_point",
        calibrationHead: null,
        recomputing: false,
        onRecompute: () => {},
      }),
    ),
  );
}

/** Pose glyphs: one `<g class="cursor-pointer">` per pose. */
function poseGlyphs(html: string): string[] {
  return html.match(/<g class="cursor-pointer">.*?<\/g>/g) ?? [];
}

function num(attr: string, glyph: string): number[] {
  return [...glyph.matchAll(new RegExp(`${attr}="([-\\d.e]+)"`, "g"))].map(
    (m) => Number(m[1]),
  );
}

describe("DistributionObjectCard render", () => {
  it("renders an old file's skipped episodes exactly as before (no skip badge or list)", () => {
    const file = baseFile();
    file.objects[0].skipped = [{ episode_index: 2, reason: "no grasp event" }];
    const html = render(file, file.objects[0], "tool");
    expect(html).not.toContain("skip=");
    expect(html).not.toContain("Skipped (");
    expect(html).not.toContain("no grasp event");
    expect(html).toContain("n=2");
    expect(html).toContain(`sym=${file.objects[0].yaw_symmetry_deg}°`);
  });

  it("shows each layer's own skipped list once the file carries an object layer", () => {
    const file = baseFile();
    file.objects[0].skipped = [{ episode_index: 2, reason: "no grasp event" }];
    file.objects[0].object_layer = objectLayer(
      [layerPose(0, 0.9, 0.2, 10)],
      [{ episode_index: 1, reason: "mask touches layout box border" }],
    );
    const objectHtml = render(file, file.objects[0], "object");
    expect(objectHtml).toContain("skip=1");
    expect(objectHtml).toContain("mask touches layout box border");
    expect(objectHtml).not.toContain("no grasp event");
    const toolHtml = render(file, file.objects[0], "tool");
    expect(toolHtml).toContain("no grasp event");
    expect(toolHtml).not.toContain("mask touches layout box border");
  });

  it("draws a 180°-period object yaw as a headless axis through the point", () => {
    const file = baseFile();
    file.objects[0].object_layer = objectLayer([
      layerPose(0, 0.9, 0.2, 10),
      layerPose(1, 1.02, 0.31, 170),
    ]);
    const glyphs = poseGlyphs(render(file, file.objects[0], "object"));
    expect(glyphs).toHaveLength(2);
    for (const g of glyphs) {
      expect(g).not.toContain("<polyline");
      const [cx] = num("cx", g);
      const [cy] = num("cy", g);
      const x2 = num("x2", g);
      const y2 = num("y2", g);
      // The tips sit on both sides of the point: a line through it.
      const meanX = x2.reduce((a, b) => a + b, 0) / x2.length;
      const meanY = y2.reduce((a, b) => a + b, 0) / y2.length;
      expect(meanX).toBeCloseTo(cx, 6);
      expect(meanY).toBeCloseTo(cy, 6);
    }
    // 10° and 170° are 20° apart as axes; drawn as arrows from the point
    // they would read as 160° apart.
    const dirs = glyphs.map((g) => {
      const [x1, x2] = [num("x1", g)[0], num("x2", g)[0]];
      const [y1, y2] = [num("y1", g)[0], num("y2", g)[0]];
      return (Math.atan2(-(y2 - y1), x2 - x1) * 180) / Math.PI;
    });
    const diff = Math.abs((((dirs[0] - dirs[1]) % 180) + 180) % 180);
    expect(Math.min(diff, 180 - diff)).toBeCloseTo(20, 6);
  });

  it("keeps the end-effector layer's arrows from the point", () => {
    const file = baseFile();
    file.objects[0].object_layer = objectLayer([layerPose(0, 0.9, 0.2, 10)]);
    const glyphs = poseGlyphs(render(file, file.objects[0], "tool"));
    expect(glyphs.length).toBe(file.objects[0].poses.length);
    for (const g of glyphs) {
      expect(g).toContain("<polyline");
      expect(num("x1", g)[0]).toBeCloseTo(num("cx", g)[0], 6);
      expect(num("y1", g)[0]).toBeCloseTo(num("cy", g)[0], 6);
    }
  });

  it("falls back per object in a mixed file and says so only on that card", () => {
    const file = baseFile();
    file.objects[0].object_layer = objectLayer([layerPose(0, 0.9, 0.2, 10)]);
    const withLayer = render(file, file.objects[0], "object");
    const without = render(file, file.objects[1], "object");
    expect(withLayer).not.toContain("No object layer for this object");
    expect(withLayer).toContain("sym=180°");
    expect(without).toContain("No object layer for this object");
    expect(without).toContain(`sym=${file.objects[1].yaw_symmetry_deg}°`);
    expect(render(file, file.objects[1], "tool")).not.toContain(
      "No object layer for this object",
    );
  });

  it("renders an object layer whose poses were all skipped", () => {
    const file = baseFile();
    file.objects[0].object_layer = objectLayer(
      [],
      [
        { episode_index: 0, reason: "no mask" },
        { episode_index: 1, reason: "no mask" },
      ],
    );
    const html = render(file, file.objects[0], "object");
    expect(html).toContain("n=0");
    expect(html).toContain("skip=2");
    expect(html).toContain("No poses in selection");
    expect(html).toContain("z=-0.420m");
  });
});
