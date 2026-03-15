from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / ".env")


@dataclass(slots=True)
class Settings:
    port: int
    db_host: str
    db_port: int
    db_user: str
    db_password: str
    db_name: str
    public_dir: Path
    prompt_dir: Path
    ai_provider: str
    ai_base_url: str
    ai_api_key: str
    ai_model_question: str
    ai_model_eval: str
    ai_timeout_ms: int
    ai_timeout_question_ms: int
    ai_retry_count: int
    ai_force_json: bool
    ai_temperature: float | None


def _to_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    port = int(os.getenv("PORT", "3001"))
    return Settings(
        port=port,
        db_host=os.getenv("DB_HOST", "127.0.0.1"),
        db_port=int(os.getenv("DB_PORT", "3306")),
        db_user=os.getenv("DB_USER", ""),
        db_password=os.getenv("DB_PASSWORD", ""),
        db_name=os.getenv("DB_NAME", ""),
        public_dir=BASE_DIR / "public",
        prompt_dir=BASE_DIR / "prompts",
        ai_provider=os.getenv("AI_PROVIDER", "").strip().lower(),
        ai_base_url=os.getenv("AI_BASE_URL", "").strip(),
        ai_api_key=os.getenv("AI_API_KEY", "").strip(),
        ai_model_question=os.getenv("AI_MODEL_QUESTION", "").strip(),
        ai_model_eval=os.getenv("AI_MODEL_EVAL", "").strip(),
        ai_timeout_ms=int(os.getenv("AI_TIMEOUT_MS", "20000")),
        ai_timeout_question_ms=int(os.getenv("AI_TIMEOUT_QUESTION_MS", "240000")),
        ai_retry_count=max(int(os.getenv("AI_RETRY_COUNT", "1")), 0),
        ai_force_json=_to_bool(os.getenv("AI_FORCE_JSON"), True),
        ai_temperature=float(os.getenv("AI_TEMPERATURE")) if os.getenv("AI_TEMPERATURE") else None,
    )
