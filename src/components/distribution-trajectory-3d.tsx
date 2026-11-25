"use client";

import React, { useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  AxisGuide,
  CameraFit,
  type ControlsHandle,
} from "@/components/scene3d-guides";
import type { DistributionSubtaskArmEpisode } from "@/types/distribution.types";
import {
  niceGridStep,
  sceneBoundsFromPointArrays,
  toScenePoint,
} from "@/utils/scene3d";

export interface ColoredSubtaskEpisode {
  episode: DistributionSubtaskArmEpisode;
  color: string;
  groupName: string;
}

interface DistributionTrajectory3DProps {
  items: readonly ColoredSubtaskEpisode[];
  showTrajectories: boolean;
}

function yawArrowEndScene(
  x: number,
  y: number,
  z: number,
  yawDeg: number,
  lengthM: number,
): [number, number, number] {
  const rad = (yawDeg * Math.PI) / 180;
  return toScenePoint(
    x + lengthM * Math.cos(rad),
    y + lengthM * Math.sin(rad),
    z,
  );
}

export default function DistributionTrajectory3D({
  items,
  showTrajectories,
}: DistributionTrajectory3DProps) {
  const controlsRef = useRef<ControlsHandle | null>(null);

  const bounds = useMemo(() => {
    const pointArrays: number[][] = [];
    for (const { episode } of items) {
      const flat: number[] = [
        episode.start_pose.x_m,
        episode.start_pose.y_m,
        episode.start_pose.z_m,
      ];
      if (episode.end_pose) {
        flat.push(
          episode.end_pose.x_m,
          episode.end_pose.y_m,
          episode.end_pose.z_m,
        );
      }
      if (showTrajectories) {
        for (const pt of episode.trajectory) {
          flat.push(pt.x_m, pt.y_m, pt.z_m);
        }
      }
      pointArrays.push(flat);
    }
    return sceneBoundsFromPointArrays(pointArrays);
  }, [items, showTrajectories]);

  const gridStep = niceGridStep(bounds.extent);
  const markerRadius = Math.max(bounds.extent * 0.018, 0.004);
  const arrowLen = Math.max(bounds.extent * 0.09, 0.025);

  return (
    <div className="h-[290px] w-full overflow-hidden rounded border border-white/10 bg-slate-950">
      <Canvas camera={{ fov: 42, near: 0.001, far: 100 }} dpr={[1, 2]}>
        <color attach="background" args={["#020617"]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[2, 4, 2]} intensity={0.7} />

        <CameraFit
          bounds={bounds}
          controlsRef={controlsRef}
          offset={[0.85, 0.65, 0.85]}
        />
        <OrbitControls
          ref={controlsRef}
          enableDamping
          dampingFactor={0.08}
          makeDefault
        />

        <Grid
          position={[bounds.center.x, bounds.min.y, bounds.center.z]}
          args={[bounds.extent * 2.5, bounds.extent * 2.5]}
          cellSize={gridStep}
          sectionSize={gridStep * 5}
          cellColor="#1e293b"
          sectionColor="#334155"
          fadeDistance={bounds.extent * 6}
        />
        <AxisGuide bounds={bounds} />

        {items.map(({ episode, color }) => {
          const startScene = toScenePoint(
            episode.start_pose.x_m,
            episode.start_pose.y_m,
            episode.start_pose.z_m,
          );
          const endPose = episode.end_pose;
          const endScene = endPose
            ? toScenePoint(endPose.x_m, endPose.y_m, endPose.z_m)
            : null;
          const startArrowEnd = yawArrowEndScene(
            episode.start_pose.x_m,
            episode.start_pose.y_m,
            episode.start_pose.z_m,
            episode.start_pose.yaw_deg,
            arrowLen,
          );
          const endArrowEnd = endPose
            ? yawArrowEndScene(
                endPose.x_m,
                endPose.y_m,
                endPose.z_m,
                endPose.yaw_deg,
                arrowLen,
              )
            : null;

          const trajPoints = showTrajectories
            ? episode.trajectory.map(
                (pt) =>
                  new THREE.Vector3(...toScenePoint(pt.x_m, pt.y_m, pt.z_m)),
              )
            : [];
          const arrowStep = Math.max(
            1,
            Math.floor(episode.trajectory.length / 8),
          );

          return (
            <group key={episode.episode_index}>
              {/* Start marker (sphere) + yaw arrow */}
              <mesh position={startScene}>
                <sphereGeometry args={[markerRadius, 12, 12]} />
                <meshStandardMaterial color={color} />
              </mesh>
              <Line
                points={[startScene, startArrowEnd]}
                color={color}
                lineWidth={1.8}
              />

              {/* End marker (box) + yaw arrow; absent for the last subtask */}
              {endScene && endArrowEnd && (
                <>
                  <mesh position={endScene}>
                    <boxGeometry
                      args={[
                        markerRadius * 1.8,
                        markerRadius * 1.8,
                        markerRadius * 1.8,
                      ]}
                    />
                    <meshStandardMaterial
                      color={color}
                      emissive={color}
                      emissiveIntensity={0.35}
                    />
                  </mesh>
                  <Line
                    points={[endScene, endArrowEnd]}
                    color="#f8fafc"
                    lineWidth={1.6}
                  />
                </>
              )}

              {/* Optional full trajectory + periodic yaw ticks */}
              {showTrajectories && trajPoints.length >= 2 && (
                <>
                  <Line
                    points={trajPoints}
                    color={color}
                    lineWidth={1.8}
                    transparent
                    opacity={0.78}
                  />
                  {episode.trajectory.map((pt, idx) => {
                    if (
                      idx === 0 ||
                      idx === episode.trajectory.length - 1 ||
                      idx % arrowStep !== 0
                    ) {
                      return null;
                    }
                    const p0 = toScenePoint(pt.x_m, pt.y_m, pt.z_m);
                    const p1 = yawArrowEndScene(
                      pt.x_m,
                      pt.y_m,
                      pt.z_m,
                      pt.yaw_deg,
                      arrowLen * 0.65,
                    );
                    return (
                      <Line
                        key={idx}
                        points={[p0, p1]}
                        color={color}
                        lineWidth={1.1}
                        transparent
                        opacity={0.7}
                      />
                    );
                  })}
                </>
              )}
            </group>
          );
        })}
      </Canvas>
    </div>
  );
}
