import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask
from flask_cors import CORS

from api.routes import api


def create_app() -> Flask:
    repo_root = Path(__file__).resolve().parents[2]
    load_dotenv(repo_root / ".env")

    app = Flask(__name__)
    allowed_origins = os.environ.get(
        "FRONTEND_ORIGINS",
        "https://tablemate-64d1d.web.app,https://tablemate.work,https://www.tablemate.work,http://localhost:5173",
    )
    origins = [origin.strip() for origin in allowed_origins.split(",") if origin.strip()]
    CORS(app, resources={r"/*": {"origins": origins}})
    app.register_blueprint(api)
    return app


if __name__ == "__main__":
    app = create_app()
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=False)
