from flask import Blueprint, jsonify, request

from src.services.yolo_service import infer_image

api = Blueprint("api", __name__)


@api.get("/health")
def health() -> tuple[dict, int]:
    return {"status": "ok"}, 200


@api.post("/infer/hand-gestures")
def infer_hand_gestures() -> tuple[dict, int]:
    if "image" not in request.files:
        return {"error": "Missing image file"}, 400
    image_bytes = request.files["image"].read()
    result = infer_image(model_key="hand", image_bytes=image_bytes, params=request.args)
    return jsonify(result), 200


@api.post("/infer/people")
def infer_people() -> tuple[dict, int]:
    if "image" not in request.files:
        return {"error": "Missing image file"}, 400
    image_bytes = request.files["image"].read()
    result = infer_image(model_key="people", image_bytes=image_bytes, params=request.args)
    return jsonify(result), 200
