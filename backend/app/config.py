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
    ai_wire_api: str
    ai_reasoning_effort: str
    ai_disable_response_storage: bool
    ai_timeout_ms: int
    ai_timeout_question_ms: int
    ai_retry_count: int
    ai_force_json: bool
    ai_temperature: float | None
    asr_ws_url: str
    asr_api_key: str
    asr_model: str
    asr_format: str
    asr_sample_rate: int
    asr_vocabulary_id: str
    asr_workspace: str
    asr_language_hints: str
    asr_disfluency_removal_enabled: bool
    asr_connect_timeout_ms: int


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
        ai_api_key=(os.getenv("AI_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip(),
        ai_model_question=os.getenv("AI_MODEL_QUESTION", "").strip(),
        ai_model_eval=os.getenv("AI_MODEL_EVAL", "").strip(),
        ai_wire_api=os.getenv("AI_WIRE_API", "chat_completions").strip().lower(),
        ai_reasoning_effort=os.getenv("AI_REASONING_EFFORT", "").strip().lower(),
        ai_disable_response_storage=_to_bool(os.getenv("AI_DISABLE_RESPONSE_STORAGE"), False),
        ai_timeout_ms=int(os.getenv("AI_TIMEOUT_MS", "20000")),
        ai_timeout_question_ms=int(os.getenv("AI_TIMEOUT_QUESTION_MS", "240000")),
        ai_retry_count=max(int(os.getenv("AI_RETRY_COUNT", "1")), 0),
        ai_force_json=_to_bool(os.getenv("AI_FORCE_JSON"), True),
        ai_temperature=float(os.getenv("AI_TEMPERATURE")) if os.getenv("AI_TEMPERATURE") else None,
        asr_ws_url=os.getenv("ASR_WS_URL", "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/").strip(),
        asr_api_key=os.getenv("ASR_API_KEY", "").strip(),
        asr_model=os.getenv("ASR_MODEL", "fun-asr-realtime").strip(),
        asr_format=os.getenv("ASR_FORMAT", "pcm").strip().lower(),
        asr_sample_rate=int(os.getenv("ASR_SAMPLE_RATE", "16000")),
        asr_vocabulary_id=os.getenv("ASR_VOCABULARY_ID", "").strip(),
        asr_workspace=os.getenv("ASR_WORKSPACE", "").strip(),
        asr_language_hints=os.getenv("ASR_LANGUAGE_HINTS", "zh").strip(),
        asr_disfluency_removal_enabled=_to_bool(os.getenv("ASR_DISFLUENCY_REMOVAL_ENABLED"), False),
        asr_connect_timeout_ms=int(os.getenv("ASR_CONNECT_TIMEOUT_MS", "10000")),
    )
