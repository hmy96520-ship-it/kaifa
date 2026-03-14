from __future__ import annotations

import json
import re
from typing import Any

COMMON_SKILLS = [
    "摄影",
    "儿童摄影",
    "人像摄影",
    "布光",
    "修图",
    "后期",
    "客片",
    "选片",
    "客户沟通",
    "销售转化",
    "门店接待",
    "流程管理",
    "排期",
    "短视频",
    "直播",
    "团队协同",
    "服务意识",
    "审美",
    "构图",
    "灯光",
    "妆造协同",
    "引导拍摄",
]


def unique_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(key)
    return result


def split_comma_text(text: str = "") -> list[str]:
    return [item.strip() for item in re.split(r"[，,]", str(text or "")) if item.strip()]


def parse_text_array(value: Any) -> list[str]:
    if isinstance(value, list):
        return unique_keep_order([str(item).strip() for item in value])
    return unique_keep_order(split_comma_text(str(value or "")))


def safe_json_array(value: Any) -> list[str]:
    if isinstance(value, list):
        return unique_keep_order([str(item).strip() for item in value])
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return unique_keep_order(split_comma_text(text))
        if isinstance(parsed, list):
            return unique_keep_order([str(item).strip() for item in parsed])
    return []


def infer_title_from_text(text: str) -> str:
    source = str(text or "").strip()
    if not source:
        return ""
    match = re.search(r"(?:岗位|职位|招聘岗位|招聘职位)\s*[：:]\s*([^\n\r]+)", source)
    if match and match.group(1):
        return match.group(1).strip()[:60]
    for line in source.splitlines():
        line = line.strip()
        if line:
            return line[:60]
    return ""


def infer_skills_from_text(text: str, limit: int = 8) -> list[str]:
    source = str(text or "")
    return [skill for skill in COMMON_SKILLS if skill in source][:limit]


def normalize_jd_payload(payload: dict[str, Any]) -> tuple[bool, str, dict[str, Any] | None]:
    jd_text = str(payload.get("jdText") or "").strip()
    title = str(payload.get("title") or "").strip()
    responsibilities = str(payload.get("responsibilities") or "").strip()
    must_skills = parse_text_array(payload.get("mustSkills"))
    nice_skills = parse_text_array(payload.get("niceSkills"))

    if not title and jd_text:
        title = infer_title_from_text(jd_text) or "未命名岗位"
    if not responsibilities and jd_text:
        responsibilities = jd_text[:2000]
    if not must_skills and jd_text:
        must_skills = infer_skills_from_text(jd_text, 6)
    if not nice_skills and jd_text:
        inferred = infer_skills_from_text(jd_text, 12)
        nice_skills = [item for item in inferred if item not in must_skills][:6]

    if not title:
        return False, "title is required", None
    if not responsibilities:
        return False, "responsibilities or jdText is required", None

    return True, "", {
        "title": title,
        "responsibilities": responsibilities,
        "mustSkills": must_skills,
        "niceSkills": nice_skills,
        "jdText": jd_text,
    }


def is_placeholder_like(text: str) -> bool:
    value = str(text or "").strip()
    if not value:
        return True
    if re.fullmatch(r"(1|11|111|123|1234|test|测试|aaa|xxx|null|none|n/a)", value, re.I):
        return True
    if re.fullmatch(r"[\d\W_]+", value) and len(value) <= 4:
        return True
    return False


def has_meaningful_text(text: str, min_length: int = 8) -> bool:
    value = str(text or "").strip()
    if not value or is_placeholder_like(value):
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) >= min_length:
        return True
    if re.search(r"[\u4e00-\u9fa5]{4,}", compact):
        return True
    if re.search(r"[A-Za-z]{6,}", compact):
        return True
    return False
