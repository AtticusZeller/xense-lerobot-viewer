import type {
  CalibrationArmResult,
  CalibrationIntrinsics,
  CalibrationResidual,
  CalibrationTcpPose,
  Matrix4RowMajor,
} from "@/types/calibration.types";
import {
  rotation6dToMatrix,
  type RotationMatrix3,
} from "@/utils/poseTrajectory3d";

export { rotation6dToMatrix, type RotationMatrix3 };

export interface ProjectedPixel {
  u: number;
  v: number;
  depth: number;
}

export type ArmTcpColumnIndices = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const TCP_SUFFIXES = [
  "x",
  "y",
  "z",
  "r1",
  "r2",
  "r3",
  "r4",
  "r5",
  "r6",
] as const;

/**
 * Transform a TCP pose `[x, y, z, r1..r6]` plus body-fixed `toolOffset` into
 * the head camera frame: `X_cam = T_cam_base @ [p_tcp + R_tcp @ tool_offset, 1]`.
 */
export function projectToolPointToCamera(
  tcp: readonly number[],
  tCamBase: Matrix4RowMajor,
  toolOffset: readonly [number, number, number],
): [number, number, number] | null {
  if (tcp.length < 9 || tcp.slice(0, 9).some((v) => !Number.isFinite(v))) {
    return null;
  }
  if (toolOffset.some((v) => !Number.isFinite(v))) {
    return null;
  }

  const rot = rotation6dToMatrix(tcp.slice(3, 9));
  if (!rot) return null;

  const [ox, oy, oz] = toolOffset;
  const px = tcp[0] + rot[0] * ox + rot[1] * oy + rot[2] * oz;
  const py = tcp[1] + rot[3] * ox + rot[4] * oy + rot[5] * oz;
  const pz = tcp[2] + rot[6] * ox + rot[7] * oy + rot[8] * oz;

  const x =
    tCamBase[0][0] * px +
    tCamBase[0][1] * py +
    tCamBase[0][2] * pz +
    tCamBase[0][3];
  const y =
    tCamBase[1][0] * px +
    tCamBase[1][1] * py +
    tCamBase[1][2] * pz +
    tCamBase[1][3];
  const z =
    tCamBase[2][0] * px +
    tCamBase[2][1] * py +
    tCamBase[2][2] * pz +
    tCamBase[2][3];

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

/**
 * Project a TCP pose to pinhole pixel coordinates `(u, v)` using calibrated
 * arm extrinsics, tool offset, and camera intrinsics. Returns null when the
 * point lies behind or on the camera plane (`Z <= 1e-6`).
 */
export function projectTcpToPixel(
  tcp: readonly number[],
  arm: Pick<CalibrationArmResult, "T_cam_base" | "tool_offset">,
  intrinsics: Pick<CalibrationIntrinsics, "fx" | "fy" | "cx" | "cy">,
): ProjectedPixel | null {
  const camPoint = projectToolPointToCamera(
    tcp,
    arm.T_cam_base,
    arm.tool_offset,
  );
  if (!camPoint) return null;
  const [x, y, z] = camPoint;
  if (z <= 1e-6) return null;

  const u = intrinsics.fx * (x / z) + intrinsics.cx;
  const v = intrinsics.fy * (y / z) + intrinsics.cy;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { u, v, depth: z };
}

export function hasNonZeroDistortion(
  intrinsics: Pick<CalibrationIntrinsics, "distortion"> | null | undefined,
): boolean {
  if (!intrinsics || !Array.isArray(intrinsics.distortion)) return false;
  return intrinsics.distortion.some(
    (coeff) => Number.isFinite(coeff) && Math.abs(coeff) > 1e-12,
  );
}

export function residualNormPx(
  residual: Pick<CalibrationResidual, "du" | "dv">,
): number {
  return Math.hypot(residual.du, residual.dv);
}

/**
 * Map each `<arm>_tcp.{x,y,z,r1..r6}` feature group in `observation.state` to
 * its 9 column indices. Handles arbitrary channel order (e.g. grippers at end).
 */
export function extractArmTcpIndices(
  featureNames: readonly string[],
): Record<string, ArmTcpColumnIndices> {
  const byArm = new Map<string, Map<string, number>>();
  for (let i = 0; i < featureNames.length; i += 1) {
    const match = /^(.+)_tcp\.(x|y|z|r[1-6])$/.exec(featureNames[i]);
    if (!match) continue;
    const arm = match[1];
    const suffix = match[2];
    let fields = byArm.get(arm);
    if (!fields) {
      fields = new Map<string, number>();
      byArm.set(arm, fields);
    }
    fields.set(suffix, i);
  }

  const result: Record<string, ArmTcpColumnIndices> = {};
  for (const [arm, fields] of byArm.entries()) {
    const indices: number[] = [];
    let complete = true;
    for (const suffix of TCP_SUFFIXES) {
      const idx = fields.get(suffix);
      if (idx === undefined) {
        complete = false;
        break;
      }
      indices.push(idx);
    }
    if (complete) {
      result[arm] = indices as ArmTcpColumnIndices;
    }
  }
  return result;
}

export function readTcpFromStateVector(
  stateRow: unknown,
  indices: ArmTcpColumnIndices,
): CalibrationTcpPose | null {
  if (!Array.isArray(stateRow) && !ArrayBuffer.isView(stateRow)) {
    return null;
  }
  const values = stateRow as ArrayLike<unknown>;
  const pose = new Array<number>(9);
  for (let i = 0; i < 9; i += 1) {
    const raw = Number(values[indices[i]]);
    if (!Number.isFinite(raw)) return null;
    pose[i] = raw;
  }
  return pose as CalibrationTcpPose;
}
