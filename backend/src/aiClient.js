import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const promptDir = path.resolve(__dirname, "..", "prompts");

const PROVIDER_PRESETS = {
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    modelQuestion: "kimi-k2.5",
    modelEval: "kimi-k2.5",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    modelQuestion: "deepseek-reasoner",
    modelEval: "deepseek-reasoner",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelQuestion: "qwen-plus",
    modelEval: "qwen-plus",
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelQuestion: "glm-4-plus",
    modelEval: "glm-4-plus",
  },
};

const promptCache = new Map();

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

const SENSITIVE_PATTERNS = [
  /\b1[3-9]\d{9}\b/g,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /微信号?\s*[:：]?\s*[A-Za-z0-9_-]{5,}/gi,
  /\b(wx|vx|wechat)\s*[:：]?\s*[A-Za-z0-9_-]{5,}/gi,
  /\bqq\s*[:：]?\s*\d{5,12}\b/gi,
  /联系方式\s*[:：]?\s*[^\n]*/gi,
];

function redactSensitive(text) {
  let output = String(text || "");
  for (const pattern of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, "[隐私信息]");
  }

  return output.replace(/\s{2,}/g, " ").trim();
}

function sanitizeResumeText(text) {
  const raw = redactSensitive(text);

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(联系方式|联系电话|手机号|手机|电话|微信|wx|vx|邮箱|mail|qq)/i.test(line));

  return lines.join("\n").slice(0, 12000);
}

function uniqueQuestions(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const category = String(item.category || "").trim();
    const questionText = redactSensitive(item.questionText || "");
    const focus = redactSensitive(item.focus || "");
    const rubric = redactSensitive(item.rubric || "");

    if (!category || !questionText || !focus || !rubric) continue;
    if (questionText.includes("[隐私信息]")) continue;

    const key = `${category}::${questionText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ category, questionText, focus, rubric });
  }

  return result;
}

function parseJsonFromModelText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) throw new Error("empty model response");

  try {
    return JSON.parse(text);
  } catch {
    // pass
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1]);
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybeJson = text.slice(firstBrace, lastBrace + 1);
    return JSON.parse(maybeJson);
  }

  throw new Error("failed to parse model JSON");
}

function resolveAiConfig() {
  const provider = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  const preset = PROVIDER_PRESETS[provider] || null;

  const baseUrl = String(process.env.AI_BASE_URL || preset?.baseUrl || "").trim().replace(/\/$/, "");
  const apiKey = String(process.env.AI_API_KEY || "").trim();

  const modelQuestion =
    String(process.env.AI_MODEL_QUESTION || "").trim() ||
    String(process.env.AI_MODEL || "").trim() ||
    preset?.modelQuestion ||
    "";

  const modelEval =
    String(process.env.AI_MODEL_EVAL || "").trim() ||
    String(process.env.AI_MODEL || "").trim() ||
    preset?.modelEval ||
    "";

  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 20000);
  const forceJson = String(process.env.AI_FORCE_JSON || "true").toLowerCase() !== "false";
  const requestedTemperature = process.env.AI_TEMPERATURE;
  const temperature =
    requestedTemperature !== undefined
      ? Number(requestedTemperature)
      : provider === "kimi" || String(modelQuestion).toLowerCase().includes("kimi-k2.5")
        ? 1
        : 0.2;

  return {
    enabled: Boolean(baseUrl && apiKey),
    provider,
    baseUrl,
    apiKey,
    modelQuestion,
    modelEval,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 20000,
    forceJson,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
  };
}

async function loadPrompt(fileName) {
  if (promptCache.has(fileName)) {
    return promptCache.get(fileName);
  }

  const fullPath = path.join(promptDir, fileName);
  const text = await fs.readFile(fullPath, "utf8");
  promptCache.set(fileName, text);
  return text;
}

async function callChatCompletion({ model, systemPrompt, userPrompt }) {
  const cfg = resolveAiConfig();
  if (!cfg.enabled) {
    throw new Error("AI config missing");
  }

  if (!model) {
    throw new Error("AI model missing");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const body = {
    model,
    temperature: cfg.temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  if (cfg.forceJson) {
    body.response_format = { type: "json_object" };
  }

  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`AI HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AI empty content");
    }

    return parseJsonFromModelText(content);
  } finally {
    clearTimeout(timer);
  }
}

export function getAiStatus() {
  const cfg = resolveAiConfig();
  return {
    enabled: cfg.enabled,
    provider: cfg.provider || "custom",
    modelQuestion: cfg.modelQuestion || null,
    modelEval: cfg.modelEval || null,
    baseUrl: cfg.baseUrl || null,
  };
}

export async function generateQuestionsByAI({ jd, resumeText }) {
  const cfg = resolveAiConfig();
  if (!cfg.enabled) {
    throw new Error("AI is not enabled");
  }

  const systemPrompt = await loadPrompt("question.system.txt");
  const cleanedResumeText = sanitizeResumeText(resumeText);
  const cleanedJdText = redactSensitive(jd.jdText || "").slice(0, 12000);
  const userPrompt = [
    "请基于以下输入生成结构化面试题：",
    "",
    `岗位名称: ${jd.title}`,
    `岗位必备技能: ${JSON.stringify(jd.mustSkills, null, 2)}`,
    `岗位加分技能: ${JSON.stringify(jd.niceSkills, null, 2)}`,
    `岗位职责: ${jd.responsibilities}`,
    "",
    "原始JD全文:",
    cleanedJdText || "(未提供原始JD全文)",
    "",
    "候选人简历文本:",
    cleanedResumeText || "(未提供简历文本)",
  ].join("\n");

  const json = await callChatCompletion({
    model: cfg.modelQuestion,
    systemPrompt,
    userPrompt,
  });

  const questions = uniqueQuestions(Array.isArray(json?.questions) ? json.questions : []);
  if (!questions.length) {
    throw new Error("AI returned empty questions");
  }

  return questions.slice(0, 8);
}

export async function evaluateByAI({ jd, transcript, resumeText, questionCount }) {
  const cfg = resolveAiConfig();
  if (!cfg.enabled) {
    throw new Error("AI is not enabled");
  }

  const systemPrompt = await loadPrompt("evaluate.system.txt");
  const cleanedResumeText = sanitizeResumeText(resumeText);
  const cleanedTranscript = redactSensitive(transcript).slice(0, 18000);
  const cleanedJdText = redactSensitive(jd.jdText || "").slice(0, 12000);
  const userPrompt = [
    "请基于以下信息输出面试评估 JSON：",
    "",
    `岗位名称: ${jd.title}`,
    `岗位必备技能: ${JSON.stringify(jd.mustSkills, null, 2)}`,
    `岗位加分技能: ${JSON.stringify(jd.niceSkills, null, 2)}`,
    `岗位职责: ${jd.responsibilities}`,
    "原始JD全文:",
    cleanedJdText || "(未提供原始JD全文)",
    `结构化题数量: ${questionCount}`,
    "",
    "候选人简历文本:",
    cleanedResumeText || "(未提供简历文本)",
    "",
    "面试转写:",
    cleanedTranscript,
  ].join("\n");

  const json = await callChatCompletion({
    model: cfg.modelEval,
    systemPrompt,
    userPrompt,
  });

  const totalScore = clamp(Number(json?.totalScore || 0), 0, 100);
  const coverageScore = clamp(Number(json?.coverageScore || 0), 0, 100);
  const depthScore = clamp(Number(json?.depthScore || 0), 0, 100);
  const communicationScore = clamp(Number(json?.communicationScore || 0), 0, 100);
  const riskScore = clamp(Number(json?.riskScore || 0), 0, 100);
  const resumeAlignmentScore = clamp(Number(json?.resumeAlignmentScore || 0), 0, 100);

  const suggestionRaw = String(json?.suggestion || "").trim();
  const allowed = new Set(["建议录用", "建议复试", "不建议录用"]);
  const suggestion = allowed.has(suggestionRaw) ? suggestionRaw : "建议复试";

  const summary = redactSensitive(String(json?.summary || "").trim()).slice(0, 260) || "基于JD、简历与面试转写完成综合评估。";

  return {
    totalScore: Math.round(totalScore),
    suggestion,
    coverageScore: Math.round(coverageScore),
    depthScore: Math.round(depthScore),
    communicationScore: Math.round(communicationScore),
    riskScore: Math.round(riskScore),
    resumeAlignmentScore: Math.round(resumeAlignmentScore),
    summary,
  };
}



