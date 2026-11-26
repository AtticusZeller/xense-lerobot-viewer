# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["opencv-python==4.12.0.88"]
# ///

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from typing import Any

import cv2
import numpy as np

WINDOW = "Collection mask preview"
CYAN = (238, 211, 34)
TEST_PREFIX = {"dense": "D", "edge": "E", "empty": "X"}


def target_label(target: dict[str, Any]) -> str:
    code = target["index"]
    if target["kind"] == "placement":
        return f"{target['object']} {code}  |  placement"
    tier = target["tier"]
    return f"{target['object']} {TEST_PREFIX[tier]}{code}  |  test_point / {tier}"


def pixel(point: list[float]) -> tuple[int, int]:
    return round(point[0]), round(point[1])


def render(
    frame: np.ndarray, size: tuple[int, int], target: dict[str, Any]
) -> np.ndarray:
    actual = (frame.shape[1], frame.shape[0])
    if actual != size:
        raise ValueError(
            f"Source image is {actual[0]}x{actual[1]}; expected {size[0]}x{size[1]}"
        )
    image = frame.copy()
    if target["outline"] is not None:
        points = np.rint(target["outline"]).astype(np.int32)
        shade = image.copy()
        cv2.fillPoly(shade, [points], CYAN)
        image = cv2.addWeighted(shade, 0.28, image, 0.72, 0)
        cv2.polylines(image, [points], True, CYAN, 2, cv2.LINE_AA)
    if target["pixel"] is not None and target["arrow_end_pixel"] is not None:
        start, end = pixel(target["pixel"]), pixel(target["arrow_end_pixel"])
        cv2.arrowedLine(image, start, end, CYAN, 2, cv2.LINE_AA, tipLength=0.24)
    image = cv2.copyMakeBorder(
        image, 0, 72, 0, 0, cv2.BORDER_CONSTANT, value=(18, 25, 36)
    )
    for y, text in (
        (21, target_label(target)),
        (42, "A / D: previous / next target    Q / Esc: quit"),
        (62, target["reason"] or "Match the object to the outline by eye."),
    ):
        cv2.putText(
            image,
            text,
            (8, size[1] + y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.46,
            (242, 248, 252),
            1,
            cv2.LINE_AA,
        )
    return image


@contextmanager
def frames(
    args: argparse.Namespace, size: tuple[int, int]
) -> Generator[tuple[Iterator[np.ndarray], float]]:
    if args.realsense:
        try:
            rs = import_module("pyrealsense2")
        except ModuleNotFoundError as exc:
            raise ValueError(
                "Install the RealSense adapter with: uv run --with pyrealsense2 ..."
            ) from exc
        pipeline = rs.pipeline()
        config = rs.config()
        config.enable_device(args.realsense)
        config.enable_stream(rs.stream.color, *size, rs.format.rgb8, args.fps)
        pipeline.start(config)
        try:

            def read() -> Iterator[np.ndarray]:
                while True:
                    color = pipeline.wait_for_frames(1000).get_color_frame()
                    if color:
                        yield cv2.cvtColor(
                            np.asanyarray(color.get_data()), cv2.COLOR_RGB2BGR
                        )

            yield read(), 0.0
        finally:
            pipeline.stop()
        return

    capture = (
        cv2.VideoCapture(str(args.video))
        if args.video
        else cv2.VideoCapture(args.webcam, cv2.CAP_V4L2)
    )
    try:
        if not capture.isOpened():
            raise ValueError("Cannot open the video source")
        if not args.video:
            width, height = size
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            capture.set(cv2.CAP_PROP_FPS, args.fps)
        fps = capture.get(cv2.CAP_PROP_FPS) if args.video else 0.0
        if args.video and not fps > 0:
            raise ValueError("Video has no valid frame rate")

        def read() -> Iterator[np.ndarray]:
            while True:
                ok, frame = capture.read()
                if not ok and args.video:
                    capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ok, frame = capture.read()
                if not ok:
                    raise ValueError("Cannot read a frame from the video source")
                yield frame

        yield read(), fps
    finally:
        capture.release()


def load_bundle(path: Path) -> tuple[tuple[int, int], list[dict[str, Any]]]:
    try:
        bundle = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read mask bundle {path}: {exc}") from exc
    if (
        not isinstance(bundle, dict)
        or bundle.get("version") != 1
        or not bundle.get("targets")
    ):
        raise ValueError("Expected a nonempty v1 collection mask bundle")
    width, height = bundle["image_size"]
    return (width, height), bundle["targets"]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Preview one calibrated placement or test target at a time."
    )
    parser.add_argument("bundle", type=Path)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--video", type=Path, help="Loop a local MP4 at its recorded frame rate."
    )
    source.add_argument(
        "--webcam", type=int, help="V4L2 device number (camera-path smoke testing)."
    )
    source.add_argument(
        "--realsense",
        metavar="SERIAL",
        help="Open the calibrated RealSense color sensor.",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Live color capture rate (bundle supplies width/height).",
    )
    args = parser.parse_args()
    if args.fps < 1:
        parser.error("--fps must be positive")
    try:
        size, targets = load_bundle(args.bundle)
        index = 0
        with frames(args, size) as (source_frames, fps):
            cv2.namedWindow(
                WINDOW, cv2.WINDOW_NORMAL | cv2.WINDOW_KEEPRATIO | cv2.WINDOW_GUI_NORMAL
            )
            cv2.resizeWindow(WINDOW, size[0], size[1] + 72)
            deadline = time.monotonic()
            for frame in source_frames:
                cv2.imshow(WINDOW, render(frame, size, targets[index]))
                delay = 1
                if fps:
                    deadline = max(deadline + 1 / fps, time.monotonic())
                    delay = max(1, round((deadline - time.monotonic()) * 1000))
                key = cv2.waitKey(delay) & 0xFF
                if (
                    key in (27, ord("q"))
                    or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1
                ):
                    break
                if key in (ord("a"), ord("d")):
                    index = (index + (1 if key == ord("d") else -1)) % len(targets)
    except (OSError, ValueError, RuntimeError, TypeError, KeyError) as exc:
        print(f"Collection preview: {exc}", file=sys.stderr)
        return 1
    finally:
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
