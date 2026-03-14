import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { pool } from "./db.js";
import { normalizeJdPayload } from "./domain.js";
import { generateQuestionsByAI, evaluateByAI, getAiStatus } from "./aiClient.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function runSingleFileUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single("file")(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function extractTextFromFile(file) {
  const fileName = String(file.originalname || "");
  const ext = path.extname(fileName).toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();

  if (ext === ".pdf" || mime.includes("pdf")) {
    const data = await pdfParse(file.buffer);
    return normalizeText(data.text);
  }

  if (ext === ".docx" || mime.includes("officedocument.wordprocessingml.document")) {
    const data = await mammoth.extractRawText({ buffer: file.buffer });
    return normalizeText(data.value);
  }

  const textLike = [".txt", ".md", ".json", ".csv", ".log"];
  if (mime.startsWith("text/") || textLike.includes(ext) || !ext) {
    return normalizeText(file.buffer.toString("utf8"));
  }

  return normalizeText(file.buffer.toString("utf8"));
}

function safeJsonArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return text
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  return [];
}

function isPlaceholderLike(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (/^(1|11|111|123|1234|test|测试|aaa|xxx|null|none|n\/a)$/i.test(value)) return true;
  if (/^[\d\W_]+$/.test(value) && value.length <= 4) return true;
  return false;
}

function hasMeaningfulText(text, minLength = 8) {
  const value = String(text || "").trim();
  if (!value || isPlaceholderLike(value)) return false;

  const compact = value.replace(/\s+/g, "");
  if (compact.length >= minLength) return true;
  if (/[\u4e00-\u9fa5]{4,}/.test(compact)) return true;
  if (/[A-Za-z]{6,}/.test(compact)) return true;

  return false;
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows[0].ok === 1, ai: getAiStatus() });
  }),
);

app.get(
  "/api/ai/status",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, ai: getAiStatus() });
  }),
);

app.post(
  "/api/files/parse-text",
  asyncHandler(async (req, res) => {
    await runSingleFileUpload(req, res);

    if (!req.file) {
      res.status(400).json({ ok: false, message: "file is required" });
      return;
    }

    const text = await extractTextFromFile(req.file);
    if (!text) {
      res.status(400).json({ ok: false, message: "no readable text found in file" });
      return;
    }

    res.json({
      ok: true,
      fileName: req.file.originalname,
      text: text.slice(0, 30000),
    });
  }),
);

app.post(
  "/api/jobs",
  asyncHandler(async (req, res) => {
    const normalized = normalizeJdPayload(req.body || {});
    if (!normalized.ok) {
      res.status(400).json({ ok: false, message: normalized.message });
      return;
    }

    const jd = normalized.value;
    const [result] = await pool.execute(
      `INSERT INTO job_post (title, must_skills, nice_skills, responsibilities)
       VALUES (?, ?, ?, ?)`,
      [jd.title, JSON.stringify(jd.mustSkills), JSON.stringify(jd.niceSkills), jd.responsibilities],
    );

    res.status(201).json({ ok: true, jobId: result.insertId, jd });
  }),
);

app.post(
  "/api/jobs/:jobId/questions/generate",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ ok: false, message: "invalid jobId" });
      return;
    }

    const resumeText = String(req.body?.resumeText || "").trim();
    const jdText = String(req.body?.jdText || "").trim();

    if (!hasMeaningfulText(jdText, 12)) {
      res.status(400).json({ ok: false, message: "jdText is too short or looks like placeholder data" });
      return;
    }

    if (resumeText && !hasMeaningfulText(resumeText, 12)) {
      res.status(400).json({
        ok: false,
        message: "resumeText is too short or looks like placeholder data",
      });
      return;
    }

    const [rows] = await pool.execute("SELECT * FROM job_post WHERE id = ?", [jobId]);
    if (!rows.length) {
      res.status(404).json({ ok: false, message: "job not found" });
      return;
    }

    const job = rows[0];
    const jd = {
      title: String(job.title || "").trim(),
      responsibilities: String(job.responsibilities || "").trim(),
      mustSkills: safeJsonArray(job.must_skills),
      niceSkills: safeJsonArray(job.nice_skills),
      jdText,
    };

    const ai = getAiStatus();
    if (!ai.enabled) {
      res.status(503).json({
        ok: false,
        message: "AI is disabled. Please configure AI_PROVIDER, AI_BASE_URL and AI_API_KEY.",
      });
      return;
    }

    let questions = [];
    try {
      questions = await generateQuestionsByAI({ jd, resumeText });
    } catch (error) {
      res.status(502).json({
        ok: false,
        message: `AI question generation failed: ${error.message}`,
      });
      return;
    }

    await pool.execute("DELETE FROM question_bank WHERE job_post_id = ?", [jobId]);
    for (const item of questions) {
      await pool.execute(
        `INSERT INTO question_bank (job_post_id, category, question_text, focus, rubric)
         VALUES (?, ?, ?, ?, ?)`,
        [jobId, item.category, item.questionText, item.focus, item.rubric],
      );
    }

    res.json({ ok: true, source: "ai", count: questions.length, questions });
  }),
);

app.get(
  "/api/jobs/:jobId/questions",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.params.jobId);
    if (!jobId) {
      res.status(400).json({ ok: false, message: "invalid jobId" });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT id, category, question_text AS questionText, focus, rubric, created_at AS createdAt
       FROM question_bank
       WHERE job_post_id = ?
       ORDER BY id ASC`,
      [jobId],
    );

    res.json({ ok: true, questions: rows });
  }),
);

app.post(
  "/api/interviews",
  asyncHandler(async (req, res) => {
    const jobId = Number(req.body?.jobId);
    const candidateName = String(req.body?.candidateName || "").trim();
    const interviewerName = String(req.body?.interviewerName || "").trim();

    if (!jobId || !candidateName) {
      res.status(400).json({ ok: false, message: "jobId and candidateName are required" });
      return;
    }

    if (isPlaceholderLike(candidateName) || candidateName.length < 2) {
      res.status(400).json({ ok: false, message: "candidateName is too short or looks like placeholder data" });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO interview_session (job_post_id, candidate_name, interviewer_name)
       VALUES (?, ?, ?)`,
      [jobId, candidateName, interviewerName || null],
    );

    res.status(201).json({ ok: true, interviewId: result.insertId });
  }),
);

app.post(
  "/api/interviews/:interviewId/transcripts",
  asyncHandler(async (req, res) => {
    const interviewId = Number(req.params.interviewId);
    const speaker = String(req.body?.speaker || "candidate").trim();
    const content = String(req.body?.content || "").trim();

    if (!interviewId || !content) {
      res.status(400).json({ ok: false, message: "interviewId and content are required" });
      return;
    }

    if (!hasMeaningfulText(content, 12)) {
      res.status(400).json({ ok: false, message: "transcript content is too short or looks like placeholder data" });
      return;
    }

    await pool.execute(
      `INSERT INTO transcript_segment (interview_session_id, speaker, content)
       VALUES (?, ?, ?)`,
      [interviewId, speaker, content],
    );

    res.status(201).json({ ok: true });
  }),
);

app.post(
  "/api/interviews/:interviewId/evaluate",
  asyncHandler(async (req, res) => {
    const interviewId = Number(req.params.interviewId);
    if (!interviewId) {
      res.status(400).json({ ok: false, message: "invalid interviewId" });
      return;
    }

    const resumeText = String(req.body?.resumeText || "").trim();
    const jdText = String(req.body?.jdText || "").trim();

    if (!hasMeaningfulText(jdText, 12)) {
      res.status(400).json({ ok: false, message: "jdText is too short or looks like placeholder data" });
      return;
    }

    if (resumeText && !hasMeaningfulText(resumeText, 12)) {
      res.status(400).json({
        ok: false,
        message: "resumeText is too short or looks like placeholder data",
      });
      return;
    }

    const [interviewRows] = await pool.execute(
      `SELECT i.id, i.job_post_id AS jobPostId
       FROM interview_session i
       WHERE i.id = ?`,
      [interviewId],
    );

    if (!interviewRows.length) {
      res.status(404).json({ ok: false, message: "interview not found" });
      return;
    }

    const interview = interviewRows[0];

    const [jobRows] = await pool.execute("SELECT * FROM job_post WHERE id = ?", [interview.jobPostId]);
    if (!jobRows.length) {
      res.status(404).json({ ok: false, message: "job not found" });
      return;
    }

    const job = jobRows[0];
    const jd = {
      title: String(job.title || "").trim(),
      responsibilities: String(job.responsibilities || "").trim(),
      mustSkills: safeJsonArray(job.must_skills),
      niceSkills: safeJsonArray(job.nice_skills),
      jdText,
    };

    const [questionRows] = await pool.execute(
      "SELECT COUNT(1) AS count FROM question_bank WHERE job_post_id = ?",
      [interview.jobPostId],
    );

    const [transcriptRows] = await pool.execute(
      `SELECT content FROM transcript_segment
       WHERE interview_session_id = ?
       ORDER BY id ASC`,
      [interviewId],
    );

    const transcript = transcriptRows.map((row) => row.content).join(" ").trim();
    if (!transcript) {
      res.status(400).json({ ok: false, message: "transcript is empty" });
      return;
    }

    if (!hasMeaningfulText(transcript, 12)) {
      res.status(400).json({ ok: false, message: "transcript is too short or looks like placeholder data" });
      return;
    }

    const questionCount = Number(questionRows[0].count || 0);

    const ai = getAiStatus();
    if (!ai.enabled) {
      res.status(503).json({
        ok: false,
        message: "AI is disabled. Please configure AI_PROVIDER, AI_BASE_URL and AI_API_KEY.",
      });
      return;
    }

    let result;
    try {
      result = await evaluateByAI({
        transcript,
        jd,
        questionCount,
        resumeText,
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        message: `AI evaluation failed: ${error.message}`,
      });
      return;
    }

    await pool.execute(
      `INSERT INTO ai_assessment
        (interview_session_id, total_score, suggestion, coverage_score, depth_score, communication_score, risk_score, summary, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        total_score = VALUES(total_score),
        suggestion = VALUES(suggestion),
        coverage_score = VALUES(coverage_score),
        depth_score = VALUES(depth_score),
        communication_score = VALUES(communication_score),
        risk_score = VALUES(risk_score),
        summary = VALUES(summary),
        raw_json = VALUES(raw_json)`,
      [
        interviewId,
        result.totalScore,
        result.suggestion,
        result.coverageScore,
        result.depthScore,
        result.communicationScore,
        result.riskScore,
        result.summary,
        JSON.stringify({ ...result, source: "ai" }),
      ],
    );

    await pool.execute(
      "UPDATE interview_session SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = ?",
      [interviewId],
    );

    res.json({ ok: true, source: "ai", assessment: result });
  }),
);

app.get(
  "/api/interviews/:interviewId/report",
  asyncHandler(async (req, res) => {
    const interviewId = Number(req.params.interviewId);
    if (!interviewId) {
      res.status(400).json({ ok: false, message: "invalid interviewId" });
      return;
    }

    const [rows] = await pool.execute(
      `SELECT
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
       WHERE i.id = ?`,
      [interviewId],
    );

    if (!rows.length) {
      res.status(404).json({ ok: false, message: "interview not found" });
      return;
    }

    res.json({ ok: true, report: rows[0] });
  }),
);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }

  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error("Request failed:", err);
  res.status(500).json({ ok: false, message: err.message || "internal error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

app.listen(port, () => {
  console.log(`Studio HR backend listening at http://localhost:${port}`);
});

