from __future__ import annotations

import tempfile
from io import BytesIO
from pathlib import Path

import docx2txt
from pypdf import PdfReader
from starlette.datastructures import UploadFile


def normalize_text(text: str) -> str:
    return str(text or "").replace("\x00", "").replace("\r\n", "\n").strip()


def decode_text_bytes(payload: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "gbk"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("utf-8", errors="ignore")


def extract_text_from_file(upload: UploadFile) -> str:
    file_name = str(upload.filename or "")
    ext = Path(file_name).suffix.lower()
    mime = str(upload.content_type or "").lower()
    payload = upload.file.read()

    if ext == ".pdf" or "pdf" in mime:
        reader = PdfReader(BytesIO(payload))
        return normalize_text("\n".join(page.extract_text() or "" for page in reader.pages))

    if ext == ".docx" or "officedocument.wordprocessingml.document" in mime:
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
            tmp.write(payload)
            temp_path = Path(tmp.name)
        try:
            return normalize_text(docx2txt.process(str(temp_path)))
        finally:
            temp_path.unlink(missing_ok=True)

    return normalize_text(decode_text_bytes(payload))
