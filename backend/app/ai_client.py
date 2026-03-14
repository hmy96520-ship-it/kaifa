from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from .config import Settings, get_settings

PROVIDER_PRESETS = {
    "kimi": {
        "base_url": "https://api.moonshot.cn/v1",
        "model_question": "kimi-k2.5",
        "model_eval": "kimi-k2.5",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "model_question": "deepseek-reasoner",
        "model_eval": "deepseek-reasoner",
    },
    "qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model_question": "qwen-plus",
        "model_eval": "qwen-plus",
    },
    "glm": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model_question": "glm-4-plus",
        "model_eval": "glm-4-plus",
    },
}

SENSITIVE_PATTERNS = [
    re.compile(r"\b1[3-9]\d{9}\b"),
    re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I),
    re.compile(r"微信号?\s*[:：]?\s*[A-Za-z0-9_-]{5,}", re.I),
    re.compile(r"\b(wx|vx|wechat)\s*[:：]?\s*[A-Za-z0-9_-]{5,}\b", re.I),
    re.compile(r"\bqq\s*[:：]?\s*\d{5,12}\b", re.I),
    re.compile(r"联系方式\s*[:：]?\s*[^\n]*", re.I),
]


def clamp(value: int | float, min_value: int, max_value: int) -> int:
    return max(min_value, min(max_value, int(round(float(value or 0)))))


def redact_sensitive(text: str) -> str:
    output = str(text or "")
    for pattern in SENSITIVE_PATTERNS:
        output = pattern.sub("[隐私信息]", output)
    return re.sub(r"\s{2,}", " ", output).strip()


def sanitize_resume_text(text: str) -> str:
    raw = redact_sensitive(text)
    lines = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if re.search(r"(联系方式|联系电话|手机号|手机|电话|微信|wx|vx|邮箱|mail|qq)", line, re.I):
            continue
        lines.append(line)
    return "\n".join(lines)[:12000]


def extract_evidence_segments(text: str, *, limit: int = 10, min_length: int = 8) -> list[str]:
    raw = redact_sensitive(text)
    if not raw:
        return []

    chunks = re.split(r"[\r\n]+|(?<=[。！？；;])", raw)
    seen: set[str] = set()
    result: list[str] = []

    for chunk in chunks:
        value = re.sub(r"\s+", " ", chunk or "").strip(" -•\t\r\n")
        if not value or len(value) < min_length:
            continue
        if re.search(r"(联系方式|联系电话|手机号|手机|电话|微信|wx|vx|邮箱|mail|qq)", value, re.I):
            continue
        if value in seen:
            continue
        seen.add(value)
        result.append(value[:180])
        if len(result) >= limit:
            break

    return result


def parse_json_from_model_text(raw_text: str) -> Any:
    text = str(raw_text or "").strip()
    if not text:
        raise RuntimeError("empty model response")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    fenced_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.I)
    if fenced_match and fenced_match.group(1):
        return json.loads(fenced_match.group(1))

    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace >= 0 and last_brace > first_brace:
        return json.loads(text[first_brace : last_brace + 1])

    raise RuntimeError("failed to parse model JSON")


def unique_questions(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    result: list[dict[str, str]] = []
    for item in items:
        category = str(item.get("category") or "").strip()
        question_text = redact_sensitive(str(item.get("questionText") or ""))
        focus = redact_sensitive(str(item.get("focus") or ""))
        rubric = redact_sensitive(str(item.get("rubric") or ""))
        if not all([category, question_text, focus, rubric]):
            continue
        if "[隐私信息]" in question_text:
            continue
        key = f"{category}::{question_text}"
        if key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "category": category,
                "questionText": question_text,
                "focus": focus,
                "rubric": rubric,
            }
        )
    return result


@lru_cache(maxsize=8)
def load_prompt(file_name: str) -> str:
    settings = get_settings()
    return (Path(settings.prompt_dir) / file_name).read_text(encoding="utf-8")


def resolve_ai_config(settings: Settings) -> dict[str, Any]:
    provider = settings.ai_provider
    preset = PROVIDER_PRESETS.get(provider) or {}
    base_url = (settings.ai_base_url or preset.get("base_url") or "").rstrip("/")
    model_question = settings.ai_model_question or preset.get("model_question") or ""
    model_eval = settings.ai_model_eval or preset.get("model_eval") or ""
    if settings.ai_temperature is not None:
        temperature = settings.ai_temperature
    elif provider == "kimi" or "kimi-k2.5" in model_question.lower():
        temperature = 1
    else:
        temperature = 0.2

    return {
        "enabled": bool(base_url and settings.ai_api_key),
        "provider": provider or "custom",
        "base_url": base_url,
        "api_key": settings.ai_api_key,
        "model_question": model_question,
        "model_eval": model_eval,
        "timeout_s": max(settings.ai_timeout_ms, 1000) / 1000,
        "force_json": settings.ai_force_json,
        "temperature": temperature,
    }


def get_ai_status() -> dict[str, Any]:
    settings = get_settings()
    cfg = resolve_ai_config(settings)
    return {
        "enabled": cfg["enabled"],
        "provider": cfg["provider"],
        "modelQuestion": cfg["model_question"] or None,
        "modelEval": cfg["model_eval"] or None,
        "baseUrl": cfg["base_url"] or None,
    }


def call_chat_completion(*, model: str, system_prompt: str, user_prompt: str) -> Any:
    settings = get_settings()
    cfg = resolve_ai_config(settings)
    if not cfg["enabled"]:
        raise RuntimeError("AI config missing")
    if not model:
        raise RuntimeError("AI model missing")

    payload: dict[str, Any] = {
        "model": model,
        "temperature": cfg["temperature"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if cfg["force_json"]:
        payload["response_format"] = {"type": "json_object"}

    try:
        response = httpx.post(
            f"{cfg['base_url']}/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {cfg['api_key']}",
            },
            json=payload,
            timeout=cfg["timeout_s"],
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        compact = re.sub(r"\s+", " ", exc.response.text or "")[:300]
        raise RuntimeError(f"AI HTTP {exc.response.status_code}: {compact}") from exc
    except httpx.RequestError as exc:
        raise RuntimeError(str(exc) or exc.__class__.__name__) from exc

    raw = response.json()
    content = (((raw.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    if not content:
        raise RuntimeError("AI empty content")
    return parse_json_from_model_text(content)


def generate_questions_by_ai(*, jd: dict[str, Any], resume_text: str) -> list[dict[str, str]]:
    cfg = resolve_ai_config(get_settings())
    if not cfg["enabled"]:
        raise RuntimeError("AI is not enabled")

    system_prompt = load_prompt("question.system.txt")
    cleaned_resume = sanitize_resume_text(resume_text)
    cleaned_jd_text = redact_sensitive(jd.get("jdText") or "")[:12000]
    jd_evidence = extract_evidence_segments(
        "\n".join(
            [
                str(jd.get("title") or "").strip(),
                str(jd.get("responsibilities") or "").strip(),
                cleaned_jd_text,
            ]
        ),
        limit=12,
    )
    resume_evidence = extract_evidence_segments(cleaned_resume, limit=12, min_length=10)
    user_prompt = "\n".join(
        [
            "请基于以下输入生成结构化面试题：",
            "",
            f"岗位名称: {jd.get('title', '')}",
            f"岗位必备技能: {json.dumps(jd.get('mustSkills', []), ensure_ascii=False, indent=2)}",
            f"岗位加分技能: {json.dumps(jd.get('niceSkills', []), ensure_ascii=False, indent=2)}",
            f"岗位职责: {jd.get('responsibilities', '')}",
            "",
            "JD关键证据片段（只能基于这些片段和结构化字段出题）:",
            json.dumps(jd_evidence or ["(未提取到明确JD证据片段)"], ensure_ascii=False, indent=2),
            "",
            "原始JD全文:",
            cleaned_jd_text or "(未提供原始JD全文)",
            "",
            "简历关键证据片段（只能基于这些片段追问候选人经历或真实性）:",
            json.dumps(resume_evidence or ["(未提取到明确简历证据片段)"], ensure_ascii=False, indent=2),
            "",
            "候选人简历文本:",
            cleaned_resume or "(未提供简历文本)",
            "",
            "硬性生成要求:",
            "1. 每道题都必须能在上面的JD证据片段、简历证据片段或结构化字段中找到依据。",
            "2. 不得使用输入中没有出现的岗位类别、业务制度、旺淡季、薪酬、渠道、组织背景。",
            "3. 如果简历证据不足，不要脑补经历；改为围绕JD要求做真实性核验或补证据追问。",
            "4. 优先使用输入中的原词或近义复述，不要泛化成通用HR/管理题。",
        ]
    )
    raw = call_chat_completion(model=cfg["model_question"], system_prompt=system_prompt, user_prompt=user_prompt)
    questions = unique_questions(list(raw.get("questions") or []))
    if not questions:
        raise RuntimeError("AI returned empty questions")
    return questions[:8]


def evaluate_by_ai(*, jd: dict[str, Any], transcript: str, resume_text: str, question_count: int) -> dict[str, Any]:
    cfg = resolve_ai_config(get_settings())
    if not cfg["enabled"]:
        raise RuntimeError("AI is not enabled")

    system_prompt = load_prompt("evaluate.system.txt")
    cleaned_resume = sanitize_resume_text(resume_text)
    cleaned_transcript = redact_sensitive(transcript)[:18000]
    cleaned_jd_text = redact_sensitive(jd.get("jdText") or "")[:12000]
    jd_evidence = extract_evidence_segments(
        "\n".join(
            [
                str(jd.get("title") or "").strip(),
                str(jd.get("responsibilities") or "").strip(),
                cleaned_jd_text,
            ]
        ),
        limit=10,
    )
    resume_evidence = extract_evidence_segments(cleaned_resume, limit=10, min_length=10)
    transcript_evidence = extract_evidence_segments(cleaned_transcript, limit=14, min_length=12)
    user_prompt = "\n".join(
        [
            "请基于以下信息输出面试评估 JSON：",
            "",
            f"岗位名称: {jd.get('title', '')}",
            f"岗位必备技能: {json.dumps(jd.get('mustSkills', []), ensure_ascii=False, indent=2)}",
            f"岗位加分技能: {json.dumps(jd.get('niceSkills', []), ensure_ascii=False, indent=2)}",
            f"岗位职责: {jd.get('responsibilities', '')}",
            "JD关键证据片段:",
            json.dumps(jd_evidence or ["(未提取到明确JD证据片段)"], ensure_ascii=False, indent=2),
            "原始JD全文:",
            cleaned_jd_text or "(未提供原始JD全文)",
            f"结构化题数量: {question_count}",
            "",
            "简历关键证据片段:",
            json.dumps(resume_evidence or ["(未提取到明确简历证据片段)"], ensure_ascii=False, indent=2),
            "",
            "候选人简历文本:",
            cleaned_resume or "(未提供简历文本)",
            "",
            "面试转写关键证据片段:",
            json.dumps(transcript_evidence or ["(未提取到明确回答证据片段)"], ensure_ascii=False, indent=2),
            "",
            "面试转写:",
            cleaned_transcript,
            "",
            "打分硬约束:",
            "1. JD关键要求未被回答覆盖时，coverageScore 不得高于 45。",
            "2. 回答没有明确案例、动作、结果或复盘时，depthScore 不得高于 45。",
            "3. 简历与回答无法相互印证时，resumeAlignmentScore 不得高于 45。",
            "4. 回答明显含糊、回避细节或真实性待核验时，riskScore 不得高于 45。",
            "5. 证据不足时，总分应保守，summary 必须明确写出“证据不足/需复核”的具体原因。",
        ]
    )
    raw = call_chat_completion(model=cfg["model_eval"], system_prompt=system_prompt, user_prompt=user_prompt)

    suggestion = str(raw.get("suggestion") or "").strip()
    if suggestion not in {"建议录用", "建议复试", "不建议录用"}:
        suggestion = "建议复试"

    summary = redact_sensitive(str(raw.get("summary") or "").strip())[:260] or "基于JD、简历与面试转写完成综合评估。"
    return {
        "totalScore": clamp(raw.get("totalScore", 0), 0, 100),
        "suggestion": suggestion,
        "coverageScore": clamp(raw.get("coverageScore", 0), 0, 100),
        "depthScore": clamp(raw.get("depthScore", 0), 0, 100),
        "communicationScore": clamp(raw.get("communicationScore", 0), 0, 100),
        "riskScore": clamp(raw.get("riskScore", 0), 0, 100),
        "resumeAlignmentScore": clamp(raw.get("resumeAlignmentScore", 0), 0, 100),
        "summary": summary,
    }


def suggest_followups_by_ai(
    *,
    jd: dict[str, Any],
    resume_text: str,
    transcript: str,
    current_question: str,
    focus: str,
    rubric: str,
    asked_followups: list[str],
) -> dict[str, Any]:
    cfg = resolve_ai_config(get_settings())
    if not cfg["enabled"]:
        raise RuntimeError("AI is not enabled")

    system_prompt = load_prompt("followup.system.txt")
    jd_evidence = extract_evidence_segments(
        "\n".join(
            [
                str(jd.get("title") or "").strip(),
                str(jd.get("responsibilities") or "").strip(),
                redact_sensitive(jd.get("jdText") or "")[:12000],
            ]
        ),
        limit=10,
    )
    resume_clean = sanitize_resume_text(resume_text)
    transcript_clean = redact_sensitive(transcript)[:12000]
    user_prompt = "\n".join(
        [
            "请基于当前面试轮次给出追问建议：",
            "",
            f"岗位名称: {jd.get('title', '')}",
            f"岗位职责: {jd.get('responsibilities', '')}",
            f"岗位必备技能: {json.dumps(jd.get('mustSkills', []), ensure_ascii=False)}",
            f"岗位加分技能: {json.dumps(jd.get('niceSkills', []), ensure_ascii=False)}",
            "JD关键证据片段:",
            json.dumps(jd_evidence or ["(未提取到明确JD证据片段)"], ensure_ascii=False, indent=2),
            "原始JD全文:",
            redact_sensitive(jd.get("jdText") or "")[:12000] or "(未提供原始JD全文)",
            "",
            "简历关键证据片段:",
            json.dumps(extract_evidence_segments(resume_clean, limit=10, min_length=10) or ["(未提取到明确简历证据片段)"], ensure_ascii=False, indent=2),
            "",
            "候选人简历文本:",
            resume_clean or "(未提供简历文本)",
            "",
            f"当前主问题: {redact_sensitive(current_question)}",
            f"当前问题考察点: {redact_sensitive(focus)}",
            f"当前问题评分标准: {redact_sensitive(rubric)}",
            f"已经追问过的问题: {json.dumps([redact_sensitive(item) for item in asked_followups], ensure_ascii=False)}",
            "",
            "当前回答关键证据片段:",
            json.dumps(extract_evidence_segments(transcript_clean, limit=10, min_length=10) or ["(未提取到明确回答证据片段)"], ensure_ascii=False, indent=2),
            "",
            "候选人当前回答转写:",
            transcript_clean,
            "",
            "追问硬要求:",
            "1. 追问必须直接服务于当前主问题，不要跳到新的业务话题。",
            "2. 优先追问角色边界、关键动作、结果指标、判断依据、复盘动作、真实性核验。",
            "3. 如果回答已经完整，只返回空的 followupQuestions，不要硬造追问。",
        ]
    )
    raw = call_chat_completion(model=cfg["model_eval"], system_prompt=system_prompt, user_prompt=user_prompt)
    return {
        "answerComplete": bool(raw.get("answerComplete")),
        "riskPoints": [redact_sensitive(str(item).strip()) for item in list(raw.get("riskPoints") or []) if str(item).strip()][:4],
        "missingInfo": [redact_sensitive(str(item).strip()) for item in list(raw.get("missingInfo") or []) if str(item).strip()][:4],
        "followupQuestions": [redact_sensitive(str(item).strip()) for item in list(raw.get("followupQuestions") or []) if str(item).strip()][:3],
    }
