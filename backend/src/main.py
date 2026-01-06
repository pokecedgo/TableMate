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
    CORS(app)
    app.register_blueprint(api)
    return app


if __name__ == "__main__":
    app = create_app()
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=False)
