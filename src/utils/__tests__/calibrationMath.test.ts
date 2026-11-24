import { describe, expect, it } from "bun:test";
import type {
  CalibrationArmResult,
  CalibrationIntrinsics,
  Matrix4RowMajor,
} from "@/types/calibration.types";
import {
  extractArmTcpIndices,
  hasNonZeroDistortion,
  projectTcpToPixel,
  projectToolPointToCamera,
  readTcpFromStateVector,
  residualNormPx,
  rotation6dToMatrix,
} from "../calibrationMath";

describe("calibrationMath", () => {
  it("reconstructs SO(3) from 6D rotation using Gram-Schmidt on the first two columns", () => {
    // Column 0 = (2, 0, 0) -> normalized (1, 0, 0).
    // Column 1 input = (3, 4, 0) -> subtract projection (3, 0, 0) -> (0, 4, 0) -> normalized (0, 1, 0).
    // Column 2 = cross(c0, c1) = (0, 0, 1).
    const identity = rotation6dToMatrix([2, 0, 0, 3, 4, 0]);
    expect(identity).not.toBeNull();
    expect(identity!).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // 90 deg rotation around +Z: c0 = (0, 1, 0), c1 = (-1, 0, 0), c2 = (0, 0, 1).
    // Row-major: [[0, -1, 0], [1, 0, 0], [0, 0, 1]].
    const rotZ90 = rotation6dToMatrix([0, 1, 0, -1, 0, 0]);
    expect(rotZ90).not.toBeNull();
    const expectedRotZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    expectedRotZ90.forEach((expected, i) => {
      expect(rotZ90![i]).toBeCloseTo(expected, 10);
    });

    // Degenerate (collinear columns) returns null.
    expect(rotation6dToMatrix([1, 0, 0, 2, 0, 0])).toBeNull();
    expect(rotation6dToMatrix([0, 0, 0, 0, 1, 0])).toBeNull();
  });

  it("projects a TCP pose + tool_offset through T_cam_base and intrinsics (hand-computed example)", () => {
    // Hand-computed verification:
    //   p_tcp = [0.2, -0.1, 0.3]
    //   6D rot = [0, 1, 0, -1, 0, 0] -> R_tcp = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
    //   tool_offset = [0.1, 0.05, -0.02]
    //   R_tcp @ tool_offset = [-0.05, 0.1, -0.02]
    //   p_tool_base = p_tcp + R_tcp @ tool_offset = [0.15, 0.0, 0.28]
    //
    //   T_cam_base =
    //     [[1,  0,  0, 0.05],
    //      [0,  0, -1, 0.48],
    //      [0,  1,  0, 1.00],
    //      [0,  0,  0, 1.00]]
    //   X_cam = [0.15 + 0.05, -0.28 + 0.48, 0.0 + 1.00] = [0.20, 0.20, 1.00]
    //
    //   intrinsics: fx = 600, fy = 600, cx = 320, cy = 240
    //   u = 600 * (0.20 / 1.00) + 320 = 440
    //   v = 600 * (0.20 / 1.00) + 240 = 360
    const tcp = [0.2, -0.1, 0.3, 0, 1, 0, -1, 0, 0];
    const tCamBase: Matrix4RowMajor = [
      [1, 0, 0, 0.05],
      [0, 0, -1, 0.48],
      [0, 1, 0, 1.0],
      [0, 0, 0, 1.0],
    ];
    const toolOffset: [number, number, number] = [0.1, 0.05, -0.02];
    const intrinsics: CalibrationIntrinsics = {
      fx: 600,
      fy: 600,
      cx: 320,
      cy: 240,
      distortion: [0, 0, 0, 0, 0],
    };

    const camPt = projectToolPointToCamera(tcp, tCamBase, toolOffset);
    expect(camPt).not.toBeNull();
    expect(camPt![0]).toBeCloseTo(0.2, 10);
    expect(camPt![1]).toBeCloseTo(0.2, 10);
    expect(camPt![2]).toBeCloseTo(1.0, 10);

    const arm: Pick<CalibrationArmResult, "T_cam_base" | "tool_offset"> = {
      T_cam_base: tCamBase,
      tool_offset: toolOffset,
    };
    const pixel = projectTcpToPixel(tcp, arm, intrinsics);
    expect(pixel).not.toBeNull();
    expect(pixel!.u).toBeCloseTo(440, 10);
    expect(pixel!.v).toBeCloseTo(360, 10);
    expect(pixel!.depth).toBeCloseTo(1.0, 10);

    // Non-unit depth check: shift p_tcp.y by -0.2 -> Z = 0.8, X = 0.20, Y = 0.20:
    //   u = 600 * (0.20 / 0.80) + 320 = 470
    //   v = 600 * (0.20 / 0.80) + 240 = 390
    const closer = projectTcpToPixel(
      [0.2, -0.3, 0.3, 0, 1, 0, -1, 0, 0],
      arm,
      intrinsics,
    );
    expect(closer).not.toBeNull();
    expect(closer!.u).toBeCloseTo(470, 10);
    expect(closer!.v).toBeCloseTo(390, 10);
    expect(closer!.depth).toBeCloseTo(0.8, 10);

    // Behind camera (Z <= 0) returns null.
    const behind = projectTcpToPixel(
      [0.2, -1.5, 0.3, 0, 1, 0, -1, 0, 0],
      arm,
      intrinsics,
    );
    expect(behind).toBeNull();
  });

  it("detects non-zero distortion arrays and computes residual norms", () => {
    expect(hasNonZeroDistortion({ distortion: [0, 0, 0, 0, 0] })).toBe(false);
    expect(hasNonZeroDistortion({ distortion: [] })).toBe(false);
    expect(hasNonZeroDistortion({ distortion: [0, -0.012, 0, 0, 0] })).toBe(
      true,
    );
    expect(residualNormPx({ du: 3, dv: -4 })).toBeCloseTo(5, 10);
  });

  it("extracts arm TCP channel indices regardless of gripper column placement", () => {
    const flexivStateNames = [
      "left_tcp.x",
      "left_tcp.y",
      "left_tcp.z",
      "left_tcp.r1",
      "left_tcp.r2",
      "left_tcp.r3",
      "left_tcp.r4",
      "left_tcp.r5",
      "left_tcp.r6",
      "right_tcp.x",
      "right_tcp.y",
      "right_tcp.z",
      "right_tcp.r1",
      "right_tcp.r2",
      "right_tcp.r3",
      "right_tcp.r4",
      "right_tcp.r5",
      "right_tcp.r6",
      "left_gripper.pos",
      "right_gripper.pos",
    ];
    const indices = extractArmTcpIndices(flexivStateNames);
    expect(indices.left).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(indices.right).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);

    const row = Array.from({ length: 20 }, (_, i) => i);
    expect(readTcpFromStateVector(row, indices.right)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });
});
