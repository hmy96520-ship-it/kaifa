from __future__ import annotations

import json
import re
import time
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

VALID_QUESTION_CATEGORIES = {"基础题", "专业题", "行为题", "情景题", "综合题"}
GENERIC_RESUME_HEADINGS = {
    "工作经历",
    "工作经验",
    "项目经历",
    "项目经验",
    "实习经历",
    "实践经历",
    "教育背景",
    "教育经历",
    "校园经历",
    "自我评价",
    "个人评价",
    "个人优势",
    "专业技能",
    "技能证书",
    "资格证书",
    "获奖经历",
    "荣誉奖项",
    "求职意向",
    "个人信息",
    "基本信息",
}
GENERIC_ANCHOR_TOKENS = {
    "负责",
    "参与",
    "协助",
    "支持",
    "执行",
    "工作",
    "经历",
    "经验",
    "项目",
    "岗位",
    "简历",
    "候选人",
    "能力",
    "技能",
    "相关",
    "内容",
    "具体",
    "工作内容",
    "项目经历",
    "工作经历",
    "项目经验",
    "自我评价",
    "教育背景",
}
DATE_RANGE_PATTERN = re.compile(r"^\d{4}(?:[./-]\d{1,2})?(?:\s*[~-]\s*\d{4}(?:[./-]\d{1,2})?)?$")
RESUME_ACTION_PATTERN = re.compile(
    r"(项目|岗位|实习|工作|负责|参与|协助|支持|对接|沟通|协调|管理|服务|客户|招聘|拍摄|销售|运营|活动|数据|Excel|表格|儿童|幼师|教培|家长|培训|引导)",
    re.I,
)


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


def normalize_lookup_text(text: str) -> str:
    return re.sub(r"[\s\-—_./,，。！？；;：:、()（）【】\\|]+", "", str(text or "").lower())


def normalize_question_category(value: str) -> str:
    category = str(value or "").strip()
    if category in VALID_QUESTION_CATEGORIES:
        return category
    if "行为" in category:
        return "行为题"
    if "情景" in category or "场景" in category:
        return "情景题"
    if "综合" in category:
        return "综合题"
    if any(token in category for token in ("基础", "核实", "补证据", "真实性", "追问")):
        return "基础题"
    return "专业题"


def is_generic_resume_heading(text: str) -> bool:
    compact = normalize_lookup_text(text)
    return compact in {normalize_lookup_text(item) for item in GENERIC_RESUME_HEADINGS}


def score_resume_anchor_candidate(text: str) -> int:
    value = str(text or "").strip()
    if not value:
        return -99

    score = 0
    if len(value) >= 10:
        score += 1
    if 12 <= len(value) <= 70:
        score += 2
    if DATE_RANGE_PATTERN.search(value):
        score -= 1
    if re.search(r"\d{4}[./-]\d{1,2}", value):
        score += 1
    if RESUME_ACTION_PATTERN.search(value):
        score += 3
    if re.search(r"(SOP|ROI|GMV|Excel|PPT|SQL|PS|拍摄|引导|招聘|面试|客户|销售|培训|活动)", value, re.I):
        score += 2
    if is_generic_resume_heading(value):
        score -= 10
    return score


def extract_resume_anchors(text: str, *, limit: int = 8) -> list[str]:
    cleaned = sanitize_resume_text(text)
    if not cleaned:
        return []

    lines = [line.strip(" -•\t\r\n") for line in cleaned.splitlines() if line.strip()]
    candidates: list[tuple[int, int, str]] = []
    seen: set[str] = set()

    for index, line in enumerate(lines):
        candidate = line
        if DATE_RANGE_PATTERN.search(line) and index + 1 < len(lines):
            next_line = lines[index + 1]
            if next_line and not is_generic_resume_heading(next_line):
                candidate = f"{line} {next_line}"
        normalized = normalize_lookup_text(candidate)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        candidates.append((score_resume_anchor_candidate(candidate), index, candidate[:120]))

    for index, chunk in enumerate(extract_evidence_segments(cleaned, limit=24, min_length=6)):
        normalized = normalize_lookup_text(chunk)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        candidates.append((score_resume_anchor_candidate(chunk), len(lines) + index, chunk[:120]))

    anchors: list[str] = []
    for score, _index, value in sorted(candidates, key=lambda item: (-item[0], item[1])):
        if score < 1:
            continue
        if is_generic_resume_heading(value):
            continue
        anchors.append(value)
        if len(anchors) >= limit:
            break

    return anchors


def collect_resume_anchor_tokens(anchors: list[str], jd_text: str) -> list[str]:
    jd_lookup = normalize_lookup_text(jd_text)
    primary: list[str] = []
    secondary: list[str] = []
    seen: set[str] = set()

    for anchor in anchors:
        anchor_norm = normalize_lookup_text(anchor)
        if anchor_norm and anchor_norm not in seen and anchor_norm not in jd_lookup and len(anchor_norm) >= 4:
            primary.append(anchor_norm)
            seen.add(anchor_norm)

        pieces = re.split(r"[，,。；;：:、/\\|()\[\]（）\s]+", anchor)
        for piece in pieces:
            token = str(piece or "").strip()
            token_norm = normalize_lookup_text(token)
            if len(token_norm) < 2 or token_norm in seen:
                continue
            if token_norm in {normalize_lookup_text(item) for item in GENERIC_ANCHOR_TOKENS}:
                continue
            if DATE_RANGE_PATTERN.search(token):
                continue
            if token_norm not in jd_lookup:
                primary.append(token_norm)
            else:
                secondary.append(token_norm)
            seen.add(token_norm)

    tokens = primary or secondary
    return sorted(tokens, key=len, reverse=True)


def collect_jd_gap_clues(jd: dict[str, Any], jd_evidence: list[str], resume_text: str, *, limit: int = 6) -> list[str]:
    resume_lookup = normalize_lookup_text(resume_text)
    candidates = [
        str(jd.get("title") or "").strip(),
        *(str(item).strip() for item in (jd.get("mustSkills") or [])),
        *(str(item).strip() for item in (jd.get("niceSkills") or [])),
        *jd_evidence,
    ]
    result: list[str] = []
    seen: set[str] = set()

    for item in candidates:
        value = str(item or "").strip()
        norm = normalize_lookup_text(value)
        if len(norm) < 2 or norm in seen:
            continue
        seen.add(norm)
        if norm in resume_lookup:
            continue
        result.append(value[:60])
        if len(result) >= limit:
            break

    return result


def question_references_resume_anchor(question: dict[str, Any], anchor_tokens: list[str]) -> bool:
    question_text = normalize_lookup_text(question.get("questionText") or "")
    if not question_text or not anchor_tokens:
        return False
    return any(token and token in question_text for token in anchor_tokens)


def count_resume_grounded_questions(questions: list[dict[str, Any]], anchor_tokens: list[str]) -> int:
    return sum(1 for item in questions if question_references_resume_anchor(item, anchor_tokens))


def match_resume_anchors_in_questions(questions: list[dict[str, Any]], resume_anchors: list[str]) -> list[str]:
    matched: list[str] = []
    for anchor in resume_anchors:
        tokens = collect_resume_anchor_tokens([anchor], "")
        if any(question_references_resume_anchor(question, tokens) for question in questions):
            matched.append(anchor)
    return matched


def build_question_generation_meta(
    *,
    cleaned_resume: str,
    resume_anchors: list[str],
    jd_gap_clues: list[str],
    questions: list[dict[str, Any]],
    required_resume_questions: int,
    retry_used: bool,
) -> dict[str, Any]:
    matched_resume_anchors = match_resume_anchors_in_questions(questions, resume_anchors)
    resume_anchor_tokens = collect_resume_anchor_tokens(resume_anchors, "")
    resume_grounded_count = count_resume_grounded_questions(questions, resume_anchor_tokens)
    summary_parts: list[str] = []

    if not cleaned_resume:
        summary_parts.append("未提供简历，本次题库主要基于 JD 出题。")
    elif matched_resume_anchors:
        summary_parts.append(
            f"题干已直接挂钩 {resume_grounded_count} 道简历题，命中的简历锚点包括：{', '.join(matched_resume_anchors[:3])}。"
        )
    elif resume_anchors:
        summary_parts.append("已提取到简历锚点，但题干引用仍偏弱，本次以真实性核验和补证据追问为主。")
    else:
        summary_parts.append("简历中可直接引用的经历事实较少，本次题库以补证据和真实性核验题为主。")

    if jd_gap_clues:
        summary_parts.append(
            f"对简历未直接覆盖的 JD 要求，已按“迁移能力/补证据”方式处理，例如：{', '.join(jd_gap_clues[:3])}。"
        )

    if retry_used:
        summary_parts.append("系统检测到初版简历挂钩度不足，已自动重生成一版以提高题干对简历的引用。")

    return {
        "resumeProvided": bool(cleaned_resume),
        "resumeAnchors": resume_anchors[:6],
        "matchedResumeAnchors": matched_resume_anchors[:6],
        "jdGapClues": jd_gap_clues[:6],
        "resumeGroundedCount": resume_grounded_count,
        "requiredResumeQuestions": required_resume_questions,
        "retryUsed": retry_used,
        "summary": " ".join(summary_parts).strip(),
    }


def build_question_user_prompt(
    *,
    jd: dict[str, Any],
    cleaned_jd_text: str,
    cleaned_resume: str,
    jd_evidence: list[str],
    resume_evidence: list[str],
    resume_anchors: list[str],
    jd_gap_clues: list[str],
    required_resume_questions: int,
    strict_resume_grounding: bool,
) -> str:
    requirements = [
        "每道题都必须能在上面的JD证据片段、简历证据片段或结构化字段中找到依据。",
        "不得使用输入中没有出现的岗位类别、业务制度、旺淡季、薪酬、渠道、组织背景。",
        "如果简历证据不足，不要脑补经历；改为围绕JD要求做真实性核验、补证据或迁移能力追问。",
        "优先使用输入中的原词或近义复述，不要泛化成通用HR/管理题。",
    ]

    if resume_anchors:
        requirements.append(
            f"优先直接引用这些简历锚点：{json.dumps(resume_anchors[:6], ensure_ascii=False)}。"
        )
        if required_resume_questions > 0:
            requirements.append(
                f"至少 {required_resume_questions} 道题的 questionText 必须直接点名一个简历锚点或其中的关键动作，不能只在 focus/rubric 里提简历。"
            )

    if jd_gap_clues:
        requirements.append(
            f"这些JD要求在简历中未直接出现：{json.dumps(jd_gap_clues[:6], ensure_ascii=False)}。"
        )
        requirements.append(
            "针对上述缺口，只能使用“迁移能力/补证据/真实性核验”措辞，禁止默认候选人已经做过该岗位或该职责。"
        )
        requirements.append(
            "例如，若简历未出现“幼师/儿童引导”等词，就不能问“请描述你在幼师岗位上的具体工作内容”，必须改问最接近经历如何迁移。"
        )

    if strict_resume_grounding:
        requirements.append("这是重生成：上一版题目对简历锚点引用不足，请显著提高题干中的简历引用密度。")
        requirements.append("如果简历中已经有明确项目名、岗位名、时间段或关键动作，题干必须优先点名这些事实再追问。")

    enumerated_requirements = [f"{index}. {item}" for index, item in enumerate(requirements, start=1)]
    return "\n".join(
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
            "简历可直接引用锚点（优先用于题干点名）:",
            json.dumps(resume_anchors or ["(未提取到可直接引用的简历锚点)"], ensure_ascii=False, indent=2),
            "",
            "候选人简历文本:",
            cleaned_resume or "(未提供简历文本)",
            "",
            "硬性生成要求:",
            *enumerated_requirements,
        ]
    )


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
        category = normalize_question_category(item.get("category") or "")
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
        "question_timeout_s": max(settings.ai_timeout_question_ms, settings.ai_timeout_ms, 1000) / 1000,
        "retry_count": max(settings.ai_retry_count, 0),
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


def call_chat_completion(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    timeout_s: float | None = None,
    retry_count: int | None = None,
) -> Any:
    settings = get_settings()
    cfg = resolve_ai_config(settings)
    if not cfg["enabled"]:
        raise RuntimeError("AI config missing")
    if not model:
        raise RuntimeError("AI model missing")
    request_timeout_s = max(float(timeout_s or cfg["timeout_s"]), 1.0)
    retries = max(int(cfg["retry_count"] if retry_count is None else retry_count), 0)

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

    transport_timeout = httpx.Timeout(
        connect=min(request_timeout_s, 20.0),
        read=request_timeout_s,
        write=min(request_timeout_s, 60.0),
        pool=min(request_timeout_s, 60.0),
    )

    for attempt in range(retries + 1):
        try:
            response = httpx.post(
                f"{cfg['base_url']}/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {cfg['api_key']}",
                },
                json=payload,
                timeout=transport_timeout,
            )
            response.raise_for_status()
            raw = response.json()
            content = (((raw.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
            if not content:
                raise RuntimeError("AI empty content")
            return parse_json_from_model_text(content)
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if attempt < retries and status_code in {408, 429, 500, 502, 503, 504}:
                time.sleep(min(2 * (attempt + 1), 4))
                continue
            compact = re.sub(r"\s+", " ", exc.response.text or "")[:300]
            raise RuntimeError(f"AI HTTP {status_code}: {compact}") from exc
        except httpx.TimeoutException as exc:
            if attempt < retries:
                time.sleep(min(2 * (attempt + 1), 4))
                continue
            raise RuntimeError(f"AI request timed out after {int(request_timeout_s)}s") from exc
        except httpx.RequestError as exc:
            if attempt < retries:
                time.sleep(min(2 * (attempt + 1), 4))
                continue
            raise RuntimeError(str(exc) or exc.__class__.__name__) from exc


def generate_question_bundle_by_ai(*, jd: dict[str, Any], resume_text: str) -> dict[str, Any]:
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
    resume_anchors = extract_resume_anchors(cleaned_resume, limit=8)
    resume_anchor_tokens = collect_resume_anchor_tokens(
        resume_anchors,
        "\n".join(
            [
                str(jd.get("title") or "").strip(),
                str(jd.get("responsibilities") or "").strip(),
                json.dumps(jd.get("mustSkills") or [], ensure_ascii=False),
                json.dumps(jd.get("niceSkills") or [], ensure_ascii=False),
                cleaned_jd_text,
            ]
        ),
    )
    jd_gap_clues = collect_jd_gap_clues(jd, jd_evidence, cleaned_resume, limit=6)
    required_resume_questions = 0
    if cleaned_resume and resume_anchors:
        required_resume_questions = 4 if len(resume_anchors) >= 2 else 2

    user_prompt = build_question_user_prompt(
        jd=jd,
        cleaned_jd_text=cleaned_jd_text,
        cleaned_resume=cleaned_resume,
        jd_evidence=jd_evidence,
        resume_evidence=resume_evidence,
        resume_anchors=resume_anchors,
        jd_gap_clues=jd_gap_clues,
        required_resume_questions=required_resume_questions,
        strict_resume_grounding=False,
    )
    raw = call_chat_completion(
        model=cfg["model_question"],
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        timeout_s=cfg["question_timeout_s"],
        retry_count=cfg["retry_count"],
    )
    questions = unique_questions(list(raw.get("questions") or []))
    resume_grounded_count = count_resume_grounded_questions(questions, resume_anchor_tokens)
    retry_used = False
    print(
        "Question generation grounding:",
        json.dumps(
            {
                "resumeEvidenceCount": len(resume_evidence),
                "resumeAnchorCount": len(resume_anchors),
                "requiredResumeQuestions": required_resume_questions,
                "resumeGroundedCount": resume_grounded_count,
            },
            ensure_ascii=False,
        ),
    )

    if required_resume_questions > 0 and resume_grounded_count < required_resume_questions:
        strict_prompt = build_question_user_prompt(
            jd=jd,
            cleaned_jd_text=cleaned_jd_text,
            cleaned_resume=cleaned_resume,
            jd_evidence=jd_evidence,
            resume_evidence=resume_evidence,
            resume_anchors=resume_anchors,
            jd_gap_clues=jd_gap_clues,
            required_resume_questions=required_resume_questions,
            strict_resume_grounding=True,
        )
        strict_raw = call_chat_completion(
            model=cfg["model_question"],
            system_prompt=system_prompt,
            user_prompt=strict_prompt,
            timeout_s=cfg["question_timeout_s"],
            retry_count=cfg["retry_count"],
        )
        strict_questions = unique_questions(list(strict_raw.get("questions") or []))
        strict_resume_grounded_count = count_resume_grounded_questions(strict_questions, resume_anchor_tokens)
        print(
            "Question generation grounding retry:",
            json.dumps(
                {
                    "resumeGroundedCount": strict_resume_grounded_count,
                    "questionCount": len(strict_questions),
                },
                ensure_ascii=False,
            ),
        )
        if strict_questions and strict_resume_grounded_count >= resume_grounded_count:
            questions = strict_questions
            retry_used = True

    if not questions:
        raise RuntimeError("AI returned empty questions")
    final_questions = questions[:8]
    generation_meta = build_question_generation_meta(
        cleaned_resume=cleaned_resume,
        resume_anchors=resume_anchors,
        jd_gap_clues=jd_gap_clues,
        questions=final_questions,
        required_resume_questions=required_resume_questions,
        retry_used=retry_used,
    )
    return {"questions": final_questions, "meta": generation_meta}


def generate_questions_by_ai(*, jd: dict[str, Any], resume_text: str) -> list[dict[str, str]]:
    bundle = generate_question_bundle_by_ai(jd=jd, resume_text=resume_text)
    return list(bundle.get("questions") or [])


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
