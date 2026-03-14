from __future__ import annotations

import json

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .ai_client import evaluate_by_ai, generate_questions_by_ai, get_ai_status, suggest_followups_by_ai
from .config import get_settings
from .db import db
from .domain import has_meaningful_text, is_placeholder_like, normalize_jd_payload, safe_json_array
from .files import extract_text_from_file

settings = get_settings()
app = FastAPI(title="Studio HR Backend", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def handle_http_exception(_request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "message": str(exc.detail)})


@app.exception_handler(RequestValidationError)
async def handle_validation_exception(_request: Request, exc: RequestValidationError):
    message = exc.errors()[0].get("msg", "request validation failed") if exc.errors() else "request validation failed"
    return JSONResponse(status_code=422, content={"ok": False, "message": message})


@app.exception_handler(Exception)
async def handle_exception(_request: Request, exc: Exception):
    print("Request failed:", exc)
    return JSONResponse(status_code=500, content={"ok": False, "message": str(exc) or "internal error"})


@app.get("/api/health")
def health():
    row = db.fetch_one("SELECT 1 AS ok")
    return {"ok": True, "db": bool(row and row.get("ok") == 1), "ai": get_ai_status()}


@app.get("/api/ai/status")
def ai_status():
    return {"ok": True, "ai": get_ai_status()}


@app.post("/api/files/parse-text")
def parse_text(file: UploadFile = File(...)):
    text = extract_text_from_file(file)
    if not text:
        raise HTTPException(status_code=400, detail="no readable text found in file")
    return {"ok": True, "fileName": file.filename, "text": text[:30000]}


@app.post("/api/jobs")
async def create_job(request: Request):
    payload = await request.json()
    valid, message, jd = normalize_jd_payload(payload or {})
    if not valid or jd is None:
        raise HTTPException(status_code=400, detail=message)

    job_id = db.execute(
        """
        INSERT INTO job_post (title, must_skills, nice_skills, responsibilities)
        VALUES (%s, %s, %s, %s)
        """,
        (
            jd["title"],
            json.dumps(jd["mustSkills"], ensure_ascii=False),
            json.dumps(jd["niceSkills"], ensure_ascii=False),
            jd["responsibilities"],
        ),
    )
    return JSONResponse(status_code=201, content={"ok": True, "jobId": job_id, "jd": jd})


@app.post("/api/jobs/{job_id}/questions/generate")
async def generate_questions(job_id: int, request: Request):
    if job_id <= 0:
        raise HTTPException(status_code=400, detail="invalid jobId")

    body = await request.json()
    resume_text = str(body.get("resumeText") or "").strip()
    jd_text = str(body.get("jdText") or "").strip()

    if not has_meaningful_text(jd_text, 12):
        raise HTTPException(status_code=400, detail="jdText is too short or looks like placeholder data")
    if resume_text and not has_meaningful_text(resume_text, 12):
        raise HTTPException(status_code=400, detail="resumeText is too short or looks like placeholder data")

    job = db.fetch_one("SELECT * FROM job_post WHERE id = %s", (job_id,))
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    jd = {
        "title": str(job.get("title") or "").strip(),
        "responsibilities": str(job.get("responsibilities") or "").strip(),
        "mustSkills": safe_json_array(job.get("must_skills")),
        "niceSkills": safe_json_array(job.get("nice_skills")),
        "jdText": jd_text,
    }

    ai = get_ai_status()
    if not ai["enabled"]:
        raise HTTPException(
            status_code=503,
            detail="AI is disabled. Please configure AI_PROVIDER, AI_BASE_URL and AI_API_KEY.",
        )

    try:
        questions = generate_questions_by_ai(jd=jd, resume_text=resume_text)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI question generation failed: {exc}") from exc

    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM question_bank WHERE job_post_id = %s", (job_id,))
            for item in questions:
                cur.execute(
                    """
                    INSERT INTO question_bank (job_post_id, category, question_text, focus, rubric)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (job_id, item["category"], item["questionText"], item["focus"], item["rubric"]),
                )

    return {"ok": True, "source": "ai", "count": len(questions), "questions": questions}


@app.get("/api/jobs/{job_id}/questions")
def get_questions(job_id: int):
    if job_id <= 0:
        raise HTTPException(status_code=400, detail="invalid jobId")
    rows = db.fetch_all(
        """
        SELECT id, category, question_text AS questionText, focus, rubric, created_at AS createdAt
        FROM question_bank
        WHERE job_post_id = %s
        ORDER BY id ASC
        """,
        (job_id,),
    )
    return {"ok": True, "questions": rows}


@app.post("/api/interviews")
async def create_interview(request: Request):
    body = await request.json()
    job_id = int(body.get("jobId") or 0)
    candidate_name = str(body.get("candidateName") or "").strip()
    interviewer_name = str(body.get("interviewerName") or "").strip()

    if not job_id or not candidate_name:
        raise HTTPException(status_code=400, detail="jobId and candidateName are required")
    if is_placeholder_like(candidate_name) or len(candidate_name) < 2:
        raise HTTPException(status_code=400, detail="candidateName is too short or looks like placeholder data")

    interview_id = db.execute(
        """
        INSERT INTO interview_session (job_post_id, candidate_name, interviewer_name)
        VALUES (%s, %s, %s)
        """,
        (job_id, candidate_name, interviewer_name or None),
    )
    return JSONResponse(status_code=201, content={"ok": True, "interviewId": interview_id})


@app.post("/api/interviews/{interview_id}/transcripts")
async def add_transcript(interview_id: int, request: Request):
    body = await request.json()
    speaker = str(body.get("speaker") or "candidate").strip()
    content = str(body.get("content") or "").strip()

    if not interview_id or not content:
        raise HTTPException(status_code=400, detail="interviewId and content are required")
    if not has_meaningful_text(content, 12):
        raise HTTPException(status_code=400, detail="transcript content is too short or looks like placeholder data")

    db.execute(
        """
        INSERT INTO transcript_segment (interview_session_id, speaker, content)
        VALUES (%s, %s, %s)
        """,
        (interview_id, speaker, content),
    )
    return JSONResponse(status_code=201, content={"ok": True})


@app.post("/api/interviews/{interview_id}/evaluate")
async def evaluate_interview(interview_id: int, request: Request):
    if interview_id <= 0:
        raise HTTPException(status_code=400, detail="invalid interviewId")

    body = await request.json()
    resume_text = str(body.get("resumeText") or "").strip()
    jd_text = str(body.get("jdText") or "").strip()

    if not has_meaningful_text(jd_text, 12):
        raise HTTPException(status_code=400, detail="jdText is too short or looks like placeholder data")
    if resume_text and not has_meaningful_text(resume_text, 12):
        raise HTTPException(status_code=400, detail="resumeText is too short or looks like placeholder data")

    interview = db.fetch_one(
        """
        SELECT i.id, i.job_post_id AS jobPostId
        FROM interview_session i
        WHERE i.id = %s
        """,
        (interview_id,),
    )
    if not interview:
        raise HTTPException(status_code=404, detail="interview not found")

    job = db.fetch_one("SELECT * FROM job_post WHERE id = %s", (interview["jobPostId"],))
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    jd = {
        "title": str(job.get("title") or "").strip(),
        "responsibilities": str(job.get("responsibilities") or "").strip(),
        "mustSkills": safe_json_array(job.get("must_skills")),
        "niceSkills": safe_json_array(job.get("nice_skills")),
        "jdText": jd_text,
    }

    question_row = db.fetch_one("SELECT COUNT(1) AS count FROM question_bank WHERE job_post_id = %s", (interview["jobPostId"],))
    transcript_rows = db.fetch_all(
        """
        SELECT content FROM transcript_segment
        WHERE interview_session_id = %s
        ORDER BY id ASC
        """,
        (interview_id,),
    )
    transcript = " ".join(str(row.get("content") or "") for row in transcript_rows).strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="transcript is empty")
    if not has_meaningful_text(transcript, 12):
        raise HTTPException(status_code=400, detail="transcript is too short or looks like placeholder data")

    ai = get_ai_status()
    if not ai["enabled"]:
        raise HTTPException(
            status_code=503,
            detail="AI is disabled. Please configure AI_PROVIDER, AI_BASE_URL and AI_API_KEY.",
        )

    try:
        result = evaluate_by_ai(
            jd=jd,
            transcript=transcript,
            resume_text=resume_text,
            question_count=int((question_row or {}).get("count") or 0),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI evaluation failed: {exc}") from exc

    db.execute(
        """
        INSERT INTO ai_assessment
          (interview_session_id, total_score, suggestion, coverage_score, depth_score, communication_score, risk_score, summary, raw_json)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
          total_score = VALUES(total_score),
          suggestion = VALUES(suggestion),
          coverage_score = VALUES(coverage_score),
          depth_score = VALUES(depth_score),
          communication_score = VALUES(communication_score),
          risk_score = VALUES(risk_score),
          summary = VALUES(summary),
          raw_json = VALUES(raw_json)
        """,
        (
            interview_id,
            result["totalScore"],
            result["suggestion"],
            result["coverageScore"],
            result["depthScore"],
            result["communicationScore"],
            result["riskScore"],
            result["summary"],
            json.dumps({**result, "source": "ai"}, ensure_ascii=False),
        ),
    )
    db.execute(
        "UPDATE interview_session SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = %s",
        (interview_id,),
    )
    return {"ok": True, "source": "ai", "assessment": result}


@app.get("/api/interviews/{interview_id}/report")
def interview_report(interview_id: int):
    if interview_id <= 0:
        raise HTTPException(status_code=400, detail="invalid interviewId")
    row = db.fetch_one(
        """
        SELECT
          i.id AS interviewId,
          i.candidate_name AS candidateName,
          i.interviewer_name AS interviewerName,
          i.status,
          i.started_at AS startedAt,
          i.ended_at AS endedAt,
          j.id AS jobId,
          j.title AS jobTitle,
          a.total_score AS totalScore,
          a.suggestion,
          a.summary
        FROM interview_session i
        JOIN job_post j ON j.id = i.job_post_id
        LEFT JOIN ai_assessment a ON a.interview_session_id = i.id
        WHERE i.id = %s
        """,
        (interview_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="interview not found")
    return {"ok": True, "report": row}


@app.post("/api/interviews/{interview_id}/followups/suggest")
async def suggest_followups(interview_id: int, request: Request):
    if interview_id <= 0:
        raise HTTPException(status_code=400, detail="invalid interviewId")

    body = await request.json()
    current_question = str(body.get("currentQuestion") or "").strip()
    focus = str(body.get("focus") or "").strip()
    rubric = str(body.get("rubric") or "").strip()
    transcript = str(body.get("transcript") or "").strip()
    resume_text = str(body.get("resumeText") or "").strip()
    jd_text = str(body.get("jdText") or "").strip()
    asked_followups = body.get("askedFollowups") or []
    if not isinstance(asked_followups, list):
        asked_followups = []

    if not current_question:
        raise HTTPException(status_code=400, detail="currentQuestion is required")
    if not transcript:
        rows = db.fetch_all(
            "SELECT content FROM transcript_segment WHERE interview_session_id = %s ORDER BY id ASC",
            (interview_id,),
        )
        transcript = "\n".join(str(row.get("content") or "") for row in rows).strip()
    if not has_meaningful_text(transcript, 12):
        raise HTTPException(status_code=400, detail="transcript is too short or looks like placeholder data")

    interview = db.fetch_one(
        "SELECT id, job_post_id AS jobPostId FROM interview_session WHERE id = %s",
        (interview_id,),
    )
    if not interview:
        raise HTTPException(status_code=404, detail="interview not found")
    job = db.fetch_one("SELECT * FROM job_post WHERE id = %s", (interview["jobPostId"],))
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    jd = {
        "title": str(job.get("title") or "").strip(),
        "responsibilities": str(job.get("responsibilities") or "").strip(),
        "mustSkills": safe_json_array(job.get("must_skills")),
        "niceSkills": safe_json_array(job.get("nice_skills")),
        "jdText": jd_text,
    }

    try:
        analysis = suggest_followups_by_ai(
            jd=jd,
            resume_text=resume_text,
            transcript=transcript,
            current_question=current_question,
            focus=focus,
            rubric=rubric,
            asked_followups=[str(item).strip() for item in asked_followups if str(item).strip()],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI follow-up suggestion failed: {exc}") from exc

    return {"ok": True, "analysis": analysis}


app.mount("/", StaticFiles(directory=str(settings.public_dir), html=True), name="public")
