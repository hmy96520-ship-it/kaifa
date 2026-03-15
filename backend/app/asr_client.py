from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed

from .config import Settings, get_settings


class AsrProtocolError(RuntimeError):
    pass


def _split_language_hints(raw: str) -> list[str]:
    return [item.strip() for item in str(raw or "").split(",") if item.strip()]


def resolve_asr_config(settings: Settings) -> dict[str, Any]:
    ws_url = (settings.asr_ws_url or "").strip()
    if ws_url and not ws_url.endswith("/"):
        ws_url = f"{ws_url}/"

    return {
        "enabled": bool(ws_url and settings.asr_api_key and settings.asr_model),
        "provider": "aliyun-realtime",
        "ws_url": ws_url,
        "api_key": settings.asr_api_key,
        "model": settings.asr_model,
        "format": settings.asr_format or "pcm",
        "sample_rate": max(int(settings.asr_sample_rate or 16000), 8000),
        "vocabulary_id": settings.asr_vocabulary_id or "",
        "workspace": settings.asr_workspace or "",
        "language_hints": _split_language_hints(settings.asr_language_hints),
        "disfluency_removal_enabled": bool(settings.asr_disfluency_removal_enabled),
        "connect_timeout_s": max(int(settings.asr_connect_timeout_ms or 10000), 1000) / 1000,
    }


def get_asr_status() -> dict[str, Any]:
    cfg = resolve_asr_config(get_settings())
    return {
        "enabled": cfg["enabled"],
        "provider": cfg["provider"],
        "model": cfg["model"] or None,
        "format": cfg["format"] or None,
        "sampleRate": cfg["sample_rate"] or None,
    }


def _decode_event(raw_message: str | bytes) -> dict[str, Any]:
    if isinstance(raw_message, bytes):
        raw_message = raw_message.decode("utf-8", errors="ignore")

    try:
        payload = json.loads(raw_message)
    except json.JSONDecodeError as exc:
        raise AsrProtocolError("ASR returned invalid JSON event") from exc

    if not isinstance(payload, dict):
        raise AsrProtocolError("ASR returned unexpected event payload")

    return payload


def _build_run_task_message(cfg: dict[str, Any], task_id: str) -> str:
    model_name = str(cfg["model"] or "").strip().lower()
    is_paraformer = model_name.startswith("paraformer")
    is_fun_asr = model_name.startswith("fun-asr")

    parameters: dict[str, Any] = {
        "format": cfg["format"],
        "sample_rate": cfg["sample_rate"],
    }
    resources: list[dict[str, Any]] = []

    if cfg["vocabulary_id"]:
        parameters["vocabulary_id"] = cfg["vocabulary_id"]
        resources.append(
            {
                "resource_id": cfg["vocabulary_id"],
                "resource_type": "asr_phrase",
            }
        )
    if (is_paraformer or is_fun_asr) and cfg["language_hints"]:
        parameters["language_hints"] = cfg["language_hints"]
    if is_paraformer or is_fun_asr:
        parameters["disfluency_removal_enabled"] = cfg["disfluency_removal_enabled"]
    if is_fun_asr:
        parameters["semantic_punctuation_enabled"] = True

    payload: dict[str, Any] = {
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex",
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": cfg["model"],
            "parameters": parameters,
            "input": {},
        },
    }

    if resources:
        payload["payload"]["resources"] = resources

    return json.dumps(payload, ensure_ascii=False)


def _build_finish_task_message(task_id: str) -> str:
    return json.dumps(
        {
            "header": {
                "action": "finish-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": {
                "input": {},
            },
        },
        ensure_ascii=False,
    )


def _normalize_result_event(payload: dict[str, Any]) -> dict[str, Any] | None:
    header = payload.get("header") or {}
    event_name = str(header.get("event") or header.get("action") or "").strip()

    if event_name == "task-started":
        return {"type": "started"}

    if event_name == "task-finished":
        return {"type": "finished"}

    if event_name == "task-failed":
        code = str(header.get("error_code") or "").strip()
        message = str(header.get("error_message") or "Unknown ASR error").strip()
        raise RuntimeError(f"{code}: {message}" if code else message)

    if event_name != "result-generated":
        return None

    sentence = ((payload.get("payload") or {}).get("output") or {}).get("sentence") or {}
    text = str(sentence.get("text") or "").strip()
    begin_time = sentence.get("begin_time")
    end_time = sentence.get("end_time")
    sentence_end = bool(sentence.get("sentence_end"))

    return {
        "type": "result",
        "text": text,
        "beginTime": int(begin_time) if isinstance(begin_time, (int, float)) else None,
        "endTime": int(end_time) if isinstance(end_time, (int, float)) else None,
        "sentenceEnd": sentence_end,
    }


@dataclass(slots=True)
class AliyunRealtimeAsrSession:
    connection: Any
    task_id: str
    cfg: dict[str, Any]
    finished: bool = False

    @classmethod
    async def connect(cls) -> "AliyunRealtimeAsrSession":
        cfg = resolve_asr_config(get_settings())
        if not cfg["enabled"]:
            raise RuntimeError("ASR is disabled. Please configure ASR_API_KEY and ASR_MODEL.")

        headers = {
            "Authorization": f"Bearer {cfg['api_key']}",
            "user-agent": "studio-hr-asr/1.0",
        }
        if cfg["workspace"]:
            headers["X-DashScope-WorkSpace"] = cfg["workspace"]

        try:
            connection = await websockets.connect(
                cfg["ws_url"],
                additional_headers=headers,
                open_timeout=cfg["connect_timeout_s"],
                close_timeout=cfg["connect_timeout_s"],
                max_size=None,
                ping_interval=20,
                ping_timeout=20,
            )
        except Exception as exc:
            raise RuntimeError(f"Failed to connect to Aliyun ASR: {exc}") from exc

        session = cls(connection=connection, task_id=str(uuid.uuid4()), cfg=cfg)
        await session._start_task()
        return session

    async def _start_task(self) -> None:
        await self.connection.send(_build_run_task_message(self.cfg, self.task_id))

        try:
            raw_message = await asyncio.wait_for(self.connection.recv(), timeout=self.cfg["connect_timeout_s"])
        except asyncio.TimeoutError as exc:
            raise RuntimeError("Aliyun ASR did not return task-started in time") from exc
        except ConnectionClosed as exc:
            raise RuntimeError(f"Aliyun ASR connection closed before start: {exc}") from exc

        event = _normalize_result_event(_decode_event(raw_message))
        if not event or event["type"] != "started":
            raise AsrProtocolError("Aliyun ASR did not acknowledge task startup")

    async def send_audio(self, pcm_chunk: bytes) -> None:
        if self.finished or not pcm_chunk:
            return
        try:
            await self.connection.send(pcm_chunk)
        except ConnectionClosed as exc:
            raise RuntimeError(f"Aliyun ASR audio stream closed: {exc}") from exc

    async def finish(self) -> None:
        if self.finished:
            return
        self.finished = True
        try:
            await self.connection.send(_build_finish_task_message(self.task_id))
        except ConnectionClosed:
            return

    async def next_event(self) -> dict[str, Any] | None:
        try:
            raw_message = await self.connection.recv()
        except ConnectionClosed as exc:
            raise RuntimeError(f"Aliyun ASR connection closed: {exc}") from exc

        return _normalize_result_event(_decode_event(raw_message))

    async def close(self) -> None:
        try:
            await self.connection.close()
        except Exception:
            return
