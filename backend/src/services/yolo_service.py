import os
from io import BytesIO
from pathlib import Path
from typing import Mapping, Optional

import numpy as np
from PIL import Image
from ultralytics import YOLO

_HAND_MODEL: Optional[YOLO] = None
_PEOPLE_MODEL: Optional[YOLO] = None
_PEOPLE_TRACKER_STATE = {
    "last_y": {},
    "counts": {"up": 0, "down": 0},
    "line_y": None,
}


def _get_hand_model() -> Optional[YOLO]:
    global _HAND_MODEL
    if _HAND_MODEL is not None:
        return _HAND_MODEL

    model_path = os.getenv("LOCAL_HAND_MODEL_PATH")
    if not model_path:
        repo_root = Path(__file__).resolve().parents[3]
        model_path = str(repo_root / "weights" / "YOLOv10n_gestures.pt")

    if not Path(model_path).exists():
        return None

    _HAND_MODEL = YOLO(model_path)
    return _HAND_MODEL


def _get_people_model() -> Optional[YOLO]:
    global _PEOPLE_MODEL
    if _PEOPLE_MODEL is not None:
        return _PEOPLE_MODEL

    model_path = os.getenv("LOCAL_PEOPLE_MODEL_PATH")
    if not model_path:
        repo_root = Path(__file__).resolve().parents[3]
        model_path = str(repo_root / "yolo11n.pt")

    if not Path(model_path).exists():
        return None

    _PEOPLE_MODEL = YOLO(model_path)
    return _PEOPLE_MODEL


def _parse_threshold(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    try:
        numeric = float(value)
    except ValueError:
        return None
    if numeric > 1:
        numeric /= 100.0
    return max(0.0, min(1.0, numeric))


def _infer_hand_local(image_bytes: bytes, params: Mapping[str, str]) -> dict:
    model = _get_hand_model()
    if model is None:
        raise RuntimeError("Local hand model not found.")

    confidence = _parse_threshold(params.get("confidence")) or 0.25
    overlap = _parse_threshold(params.get("overlap"))
    iou = overlap if overlap is not None else 0.45

    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image_np = np.array(image)
    results = model.predict(image_np, conf=confidence, iou=iou, verbose=False)

    predictions = []
    if results:
        result = results[0]
        names = result.names or {}
        boxes = result.boxes
        if boxes is not None and len(boxes) > 0:
            for box in boxes:
                xyxy = box.xyxy[0].tolist()
                x1, y1, x2, y2 = xyxy
                w = max(0.0, x2 - x1)
                h = max(0.0, y2 - y1)
                x = x1 + w / 2
                y = y1 + h / 2
                cls_id = int(box.cls[0]) if box.cls is not None else 0
                label = names.get(cls_id, str(cls_id))
                predictions.append(
                    {
                        "x": x,
                        "y": y,
                        "width": w,
                        "height": h,
                        "confidence": float(box.conf[0]) if box.conf is not None else 0.0,
                        "class": label,
                        "class_id": cls_id,
                        "class_name": label,
                    }
                )

    return {
        "predictions": predictions,
        "image": {"width": image.width, "height": image.height},
    }


def _infer_people_local(image_bytes: bytes, params: Mapping[str, str]) -> dict:
    model = _get_people_model()
    if model is None:
        raise RuntimeError("Local people model not found.")

    confidence = _parse_threshold(params.get("confidence")) or 0.25
    overlap = _parse_threshold(params.get("overlap"))
    iou = overlap if overlap is not None else 0.45
    line_y = _parse_threshold(params.get("line_y"))
    line_y = line_y if line_y is not None else 0.6
    reset = str(params.get("reset", "")).lower() in {"1", "true", "yes"}

    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image_np = np.array(image)
    results = model.track(
        image_np, conf=confidence, iou=iou, persist=True, verbose=False
    )

    predictions = []
    if results:
        result = results[0]
        boxes = result.boxes
        if boxes is not None and len(boxes) > 0:
            ids = boxes.id
            line_px = line_y * image.height

            if reset or _PEOPLE_TRACKER_STATE["line_y"] != line_y:
                _PEOPLE_TRACKER_STATE["last_y"] = {}
                _PEOPLE_TRACKER_STATE["counts"] = {"up": 0, "down": 0}
                _PEOPLE_TRACKER_STATE["line_y"] = line_y

            for idx, box in enumerate(boxes):
                cls_id = int(box.cls[0]) if box.cls is not None else -1
                if cls_id != 0:
                    continue
                xyxy = box.xyxy[0].tolist()
                x1, y1, x2, y2 = xyxy
                w = max(0.0, x2 - x1)
                h = max(0.0, y2 - y1)
                x = x1 + w / 2
                y = y1 + h / 2
                track_id = None
                if ids is not None:
                    track_id = int(ids[idx])
                if track_id is None:
                    track_id = idx + 1
                last_y = _PEOPLE_TRACKER_STATE["last_y"].get(track_id)
                if last_y is not None:
                    if last_y < line_px and y >= line_px:
                        _PEOPLE_TRACKER_STATE["counts"]["down"] += 1
                    elif last_y > line_px and y <= line_px:
                        _PEOPLE_TRACKER_STATE["counts"]["up"] += 1
                _PEOPLE_TRACKER_STATE["last_y"][track_id] = y
                predictions.append(
                    {
                        "id": track_id,
                        "x": x,
                        "y": y,
                        "width": w,
                        "height": h,
                        "confidence": float(box.conf[0]) if box.conf is not None else 0.0,
                        "class_id": cls_id,
                        "class_name": "person",
                    }
                )

    return {
        "predictions": predictions,
        "count": len(predictions),
        "counts": _PEOPLE_TRACKER_STATE["counts"],
        "line": {"y": line_y},
        "image": {"width": image.width, "height": image.height},
    }


def infer_image(model_key: str, image_bytes: bytes, params: Mapping[str, str]) -> dict:
    if model_key == "hand":
        local_model = _get_hand_model()
        if local_model is not None:
            return _infer_hand_local(image_bytes, params)
    if model_key == "people":
        return _infer_people_local(image_bytes, params)
    raise ValueError(f"Unknown model key: {model_key}")
