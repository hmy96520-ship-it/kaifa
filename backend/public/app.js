const IS_FILE_MODE = window.location.protocol === "file:";
const HAS_EXPLICIT_PORT = window.location.port && window.location.port.length > 0;
const IS_BACKEND_PORT = window.location.port === "3001";
const API_BASE = IS_FILE_MODE
  ? "http://localhost:3001"
  : HAS_EXPLICIT_PORT && !IS_BACKEND_PORT
    ? `http://${window.location.hostname}:3001`
    : "";
const ARCHIVE_KEY = "studio_hr_records";
const FOLLOWUP_DEBOUNCE_MS = 6000;

const COMMON_SKILLS = [
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
];

const state = {
  jd: null,
  jobId: null,
  questions: [],
  transcript: "",
  assessment: null,
  assessmentSource: "rule",
  lastInterviewId: null,
  interviewContextKey: "",
  recognition: null,
  currentQuestionIndex: null,
  followupAnalysis: null,
  followupAsked: [],
  followupTimer: null,
  followupRequestSeq: 0,
  lastFollowupKey: "",
};

const el = {
  backendStatus: document.getElementById("backendStatus"),
  recheckBtn: document.getElementById("recheckBtn"),
  jdFile: document.getElementById("jdFile"),
  jdUploadStatus: document.getElementById("jdUploadStatus"),
  resumeFile: document.getElementById("resumeFile"),
  resumeUploadStatus: document.getElementById("resumeUploadStatus"),
  jobTitle: document.getElementById("jobTitle"),
  mustSkills: document.getElementById("mustSkills"),
  niceSkills: document.getElementById("niceSkills"),
  responsibilities: document.getElementById("responsibilities"),
  jdText: document.getElementById("jdText"),
  resumeText: document.getElementById("resumeText"),
  generateBtn: document.getElementById("generateBtn"),
  questionEmpty: document.getElementById("questionEmpty"),
  questionTable: document.getElementById("questionTable"),
  questionBody: document.getElementById("questionBody"),
  candidateName: document.getElementById("candidateName"),
  startRecBtn: document.getElementById("startRecBtn"),
  stopRecBtn: document.getElementById("stopRecBtn"),
  recStatus: document.getElementById("recStatus"),
  transcript: document.getElementById("transcript"),
  manualAppend: document.getElementById("manualAppend"),
  appendBtn: document.getElementById("appendBtn"),
  currentQuestionPreview: document.getElementById("currentQuestionPreview"),
  suggestFollowupBtn: document.getElementById("suggestFollowupBtn"),
  followupStatus: document.getElementById("followupStatus"),
  followupEmpty: document.getElementById("followupEmpty"),
  followupPanel: document.getElementById("followupPanel"),
  followupCompleteness: document.getElementById("followupCompleteness"),
  followupRiskList: document.getElementById("followupRiskList"),
  followupMissingList: document.getElementById("followupMissingList"),
  followupQuestionList: document.getElementById("followupQuestionList"),
  evaluateBtn: document.getElementById("evaluateBtn"),
  saveBtn: document.getElementById("saveBtn"),
  downloadReportBtn: document.getElementById("downloadReportBtn"),
  assessmentEmpty: document.getElementById("assessmentEmpty"),
  assessmentPanel: document.getElementById("assessmentPanel"),
  totalScore: document.getElementById("totalScore"),
  hiringSuggestion: document.getElementById("hiringSuggestion"),
  dimensionScores: document.getElementById("dimensionScores"),
  assessmentSummary: document.getElementById("assessmentSummary"),
  archiveEmpty: document.getElementById("archiveEmpty"),
  archiveList: document.getElementById("archiveList"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
};

function splitByComma(text) {
  return String(text)
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueKeepOrder(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = String(item || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }

  return result;
}

function inferTitleFromText(text) {
  const source = String(text || "").trim();
  if (!source) return "";

  const match = source.match(/(?:岗位|职位|招聘岗位|招聘职位)\s*[：:]\s*([^\n\r]+)/);
  if (match && match[1]) return match[1].trim().slice(0, 60);

  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return (firstLine || "").slice(0, 60);
}

function inferSkillsFromText(text, limit = 6) {
  const source = String(text || "");
  return COMMON_SKILLS.filter((skill) => source.includes(skill)).slice(0, limit);
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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCurrentQuestion() {
  if (state.currentQuestionIndex === null || state.currentQuestionIndex < 0) return null;
  return state.questions[state.currentQuestionIndex] || null;
}

function clearScheduledFollowup() {
  if (state.followupTimer) {
    window.clearTimeout(state.followupTimer);
    state.followupTimer = null;
  }
}

function resetAssessmentView() {
  state.assessment = null;
  state.assessmentSource = "rule";
  el.assessmentEmpty.classList.remove("hidden");
  el.assessmentPanel.classList.add("hidden");
  el.totalScore.textContent = "0";
  el.hiringSuggestion.textContent = "-";
  el.dimensionScores.innerHTML = "";
  el.assessmentSummary.textContent = "";
}

function updateFollowupStatus(text, warn = false) {
  el.followupStatus.textContent = text;
  el.followupStatus.classList.toggle("warn", warn);
}

function renderPlainList(node, items, emptyText) {
  node.innerHTML = "";

  const values = Array.isArray(items) && items.length ? items : [emptyText];
  values.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    node.appendChild(li);
  });
}

function renderFollowupQuestions(items) {
  el.followupQuestionList.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const li = document.createElement("li");
    li.textContent = "当前回答已经比较完整，暂无新增追问。";
    el.followupQuestionList.appendChild(li);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "followup-question-item";

    const asked = state.followupAsked.includes(item);
    const text = document.createElement("div");
    text.className = "followup-question-text";
    text.textContent = item;

    const actions = document.createElement("div");
    actions.className = "followup-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ghost-btn";
    copyBtn.dataset.action = "copy-followup";
    copyBtn.dataset.index = String(index);
    copyBtn.textContent = "复制";

    const markBtn = document.createElement("button");
    markBtn.type = "button";
    markBtn.className = "ghost-btn";
    markBtn.dataset.action = "mark-followup";
    markBtn.dataset.index = String(index);
    markBtn.textContent = asked ? "已追问" : "标记已问";
    markBtn.disabled = asked;

    actions.append(copyBtn, markBtn);
    li.append(text, actions);
    el.followupQuestionList.appendChild(li);
  });
}

function renderFollowupState() {
  const currentQuestion = getCurrentQuestion();
  el.suggestFollowupBtn.disabled = !currentQuestion || !state.jobId;

  if (!currentQuestion) {
    el.currentQuestionPreview.textContent = "请先在题库中选择“设为当前题”";
    el.followupEmpty.classList.remove("hidden");
    el.followupPanel.classList.add("hidden");
    el.followupCompleteness.textContent = "回答完整度：待分析";
    updateFollowupStatus("状态：待选择题目");
    return;
  }

  el.currentQuestionPreview.textContent = `${currentQuestion.type}｜${currentQuestion.question}`;

  if (!state.followupAnalysis) {
    el.followupEmpty.classList.remove("hidden");
    el.followupPanel.classList.add("hidden");
    el.followupEmpty.textContent = "当前题已选。开始转写或手工补充记录后，系统会自动识别风险点和建议追问。";
    el.followupCompleteness.textContent = "回答完整度：待分析";
    if (!/分析|刷新|失败|已更新|待填写/.test(el.followupStatus.textContent)) {
      updateFollowupStatus("状态：待分析");
    }
    return;
  }

  el.followupEmpty.classList.add("hidden");
  el.followupPanel.classList.remove("hidden");
  el.followupCompleteness.textContent = state.followupAnalysis.answerComplete
    ? "回答完整度：较完整"
    : "回答完整度：仍需追问";

  renderPlainList(el.followupRiskList, state.followupAnalysis.riskPoints, "暂无明显风险点");
  renderPlainList(el.followupMissingList, state.followupAnalysis.missingInfo, "暂无明显信息缺口");
  renderFollowupQuestions(state.followupAnalysis.followupQuestions);
}

function resetFollowupState({ keepQuestion = false } = {}) {
  clearScheduledFollowup();
  state.followupAnalysis = null;
  state.followupAsked = [];
  state.lastFollowupKey = "";
  if (!keepQuestion) {
    state.currentQuestionIndex = null;
  }
  renderFollowupState();
}

function collectJd() {
  const jdText = el.jdText.value.trim();
  const resumeText = el.resumeText.value.trim();

  let jobTitle = el.jobTitle.value.trim();
  let responsibilities = el.responsibilities.value.trim();

  if (!jobTitle && jdText) {
    jobTitle = inferTitleFromText(jdText) || "未命名岗位";
    el.jobTitle.value = jobTitle;
  }

  if (!responsibilities && jdText) {
    responsibilities = jdText.slice(0, 1200);
    el.responsibilities.value = responsibilities;
  }

  let mustSkills = splitByComma(el.mustSkills.value);
  let niceSkills = splitByComma(el.niceSkills.value);

  if (!mustSkills.length && jdText) {
    mustSkills = inferSkillsFromText(jdText, 6);
    el.mustSkills.value = mustSkills.join(",");
  }

  if (!niceSkills.length && jdText) {
    const inferred = inferSkillsFromText(jdText, 12);
    niceSkills = inferred.filter((item) => !mustSkills.includes(item)).slice(0, 6);
    el.niceSkills.value = niceSkills.join(",");
  }

  if (!jobTitle) {
    alert("请先填写岗位名称，或上传包含岗位信息的 JD 文件");
    return null;
  }

  if (isPlaceholderLike(jobTitle) || String(jobTitle).trim().length < 2) {
    alert("岗位名称过短或像占位值，请填写真实岗位名称");
    return null;
  }

  if (!responsibilities && !jdText) {
    alert("请先填写核心职责，或上传/粘贴 JD 原文");
    return null;
  }

  if (!hasMeaningfulText(responsibilities, 8) && !hasMeaningfulText(jdText, 12)) {
    alert("核心职责或岗位画像原文内容过短/像占位值，请补充真实 JD 信息");
    return null;
  }

  if (resumeText && !hasMeaningfulText(resumeText, 12)) {
    alert("候选人简历文本内容过短或像占位值，请上传/粘贴真实简历内容");
    return null;
  }

  return {
    jobTitle,
    mustSkills,
    niceSkills,
    responsibilities,
    jdText,
    resumeText,
  };
}

function setBackendStatus(ok, text) {
  el.backendStatus.textContent = text;
  el.backendStatus.classList.remove("good", "bad");
  el.backendStatus.classList.add(ok ? "good" : "bad");
}

function setPillStatus(node, text, good = false, bad = false) {
  node.textContent = text;
  node.classList.remove("good", "bad");
  if (good) node.classList.add("good");
  if (bad) node.classList.add("bad");
}

async function apiFetch(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  const init = { method, headers };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${path}`, init);
  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }

  return data;
}

async function uploadFileForText(file) {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch(`${API_BASE}/api/files/parse-text`, {
    method: "POST",
    body: form,
  });

  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }

  return data;
}

async function checkBackend() {
  try {
    const health = await apiFetch("/api/health");
    if (health.ok && health.db) {
      const aiLabel = health.ai?.enabled ? "AI:开" : "AI:关";
      setBackendStatus(true, `后端：已连接 (${aiLabel})`);
      return true;
    }

    setBackendStatus(false, "后端：未就绪");
    return false;
  } catch {
    setBackendStatus(false, "后端：连接失败，请先启动 backend");
    return false;
  }
}

function renderQuestions(questions) {
  el.questionBody.innerHTML = "";

  questions.forEach((q, index) => {
    const tr = document.createElement("tr");
    tr.className = index === state.currentQuestionIndex ? "question-row-active" : "";
    tr.innerHTML = `
      <td>${escapeHtml(q.type)}</td>
      <td>${escapeHtml(q.question)}</td>
      <td>${escapeHtml(q.focus)}</td>
      <td>${escapeHtml(q.rubric)}</td>
      <td>
        <button
          type="button"
          class="table-action-btn${index === state.currentQuestionIndex ? " is-active" : ""}"
          data-action="select-question"
          data-index="${index}"
        >
          ${index === state.currentQuestionIndex ? "当前题" : "设为当前题"}
        </button>
      </td>
    `;
    el.questionBody.appendChild(tr);
  });

  el.questionEmpty.classList.add("hidden");
  el.questionTable.classList.remove("hidden");
}

function setActiveQuestion(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.questions.length) {
    return;
  }

  state.currentQuestionIndex = index;
  state.followupAnalysis = null;
  state.followupAsked = [];
  state.lastFollowupKey = "";
  updateFollowupStatus(`状态：已切换到第 ${index + 1} 题`);
  renderQuestions(state.questions);
  renderFollowupState();
  scheduleFollowupAnalysis({ manual: false });
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    el.recStatus.textContent = "状态：转写中";
    el.recStatus.classList.remove("warn");
    el.startRecBtn.disabled = true;
    el.stopRecBtn.disabled = false;
  };

  recognition.onresult = (event) => {
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        state.transcript += `${piece} `;
      } else {
        interimText += piece;
      }
    }

    el.transcript.value = `${state.transcript}${interimText}`.trim();
    scheduleFollowupAnalysis({ manual: false });
  };

  recognition.onerror = () => {
    el.recStatus.textContent = "状态：语音识别异常，请改为手工记录";
    el.recStatus.classList.add("warn");
  };

  recognition.onend = () => {
    el.startRecBtn.disabled = false;
    el.stopRecBtn.disabled = true;
    if (!el.recStatus.classList.contains("warn")) {
      el.recStatus.textContent = "状态：已停止";
    }
    scheduleFollowupAnalysis({ manual: false });
  };

  return recognition;
}

function normalizeAssessment(apiResult) {
  const dimension = [
    { name: "JD覆盖", score: apiResult.coverageScore },
    { name: "回答深度", score: apiResult.depthScore },
    { name: "表达结构", score: apiResult.communicationScore },
    { name: "风险控制", score: apiResult.riskScore },
  ];

  if (typeof apiResult.resumeAlignmentScore === "number") {
    dimension.push({ name: "简历匹配", score: apiResult.resumeAlignmentScore });
  }

  return {
    total: apiResult.totalScore,
    suggestion: apiResult.suggestion,
    summary: apiResult.summary,
    dimension,
  };
}

function renderAssessment(result) {
  el.assessmentEmpty.classList.add("hidden");
  el.assessmentPanel.classList.remove("hidden");
  el.totalScore.textContent = String(result.total);
  el.hiringSuggestion.textContent = result.suggestion;

  el.dimensionScores.innerHTML = "";
  result.dimension.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${item.name}：${item.score}`;
    el.dimensionScores.appendChild(li);
  });

  el.assessmentSummary.textContent = result.summary;
}

function readArchive() {
  try {
    return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeArchive(records) {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(records));
}

function renderArchive() {
  const records = readArchive();
  el.archiveList.innerHTML = "";

  if (!records.length) {
    el.archiveEmpty.classList.remove("hidden");
    return;
  }

  el.archiveEmpty.classList.add("hidden");

  records.forEach((record) => {
    const li = document.createElement("li");
    li.textContent = `${record.time} | ${record.candidate} | 岗位:${record.jobTitle} | 评分:${record.total} | ${record.suggestion}`;
    el.archiveList.appendChild(li);
  });
}

function setButtonBusy(button, busyText, idleText, busy) {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function sanitizeFileSegment(text) {
  return String(text || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 40);
}

function buildTimestampForFile() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function downloadFile(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/[",]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function fetchInterviewReportById(interviewId) {
  if (!interviewId) return null;

  try {
    const reportRes = await apiFetch(`/api/interviews/${interviewId}/report`);
    return reportRes.report || null;
  } catch {
    return null;
  }
}

function buildRecordSnapshot(report = null) {
  if (!state.assessment) return null;

  const candidate = el.candidateName.value.trim() || "未命名候选人";
  const dimension = Array.isArray(state.assessment.dimension) ? state.assessment.dimension : [];

  return {
    id: Date.now(),
    interviewId: state.lastInterviewId,
    time: new Date().toLocaleString(),
    candidate,
    jobTitle: report?.jobTitle || state.jd?.jobTitle || "",
    total: report?.totalScore ?? state.assessment.total,
    suggestion: report?.suggestion || state.assessment.suggestion,
    summary: report?.summary || state.assessment.summary || "",
    source: state.assessmentSource || "rule",
    dimension,
    questionCount: state.questions.length,
    transcript: el.transcript.value.trim(),
    jdText: el.jdText.value.trim(),
    resumeText: el.resumeText.value.trim(),
  };
}

function buildReportText(record) {
  const dimensionText = (record.dimension || [])
    .map((item) => `- ${item.name}: ${item.score}`)
    .join("\n");

  return [
    "影楼候选人评估报告",
    "====================",
    `生成时间: ${record.time}`,
    `候选人: ${record.candidate}`,
    `岗位: ${record.jobTitle}`,
    `总分: ${record.total}`,
    `建议: ${record.suggestion}`,
    `评估来源: ${record.source === "ai" ? "AI模型" : "规则引擎"}`,
    `题目数量: ${record.questionCount || 0}`,
    "",
    "维度评分:",
    dimensionText || "- 无",
    "",
    "评估摘要:",
    record.summary || "无",
    "",
    "面试转写:",
    record.transcript || "无",
    "",
    "岗位画像(JD):",
    record.jdText || "无",
    "",
    "候选人简历:",
    record.resumeText || "无",
  ].join("\n");
}

function exportArchiveAsCsv(records) {
  const headers = [
    "time",
    "candidate",
    "jobTitle",
    "total",
    "suggestion",
    "source",
    "summary",
    "dimension",
    "questionCount",
    "interviewId",
    "transcript",
  ];

  const rows = records.map((record) => {
    const dimension = Array.isArray(record.dimension)
      ? record.dimension.map((item) => `${item.name}:${item.score}`).join("; ")
      : "";

    return [
      record.time,
      record.candidate,
      record.jobTitle,
      record.total,
      record.suggestion,
      record.source,
      record.summary,
      dimension,
      record.questionCount,
      record.interviewId,
      record.transcript,
    ].map(escapeCsvCell).join(",");
  });

  return `\uFEFF${headers.join(",")}\n${rows.join("\n")}`;
}

function buildInterviewContextKey(jobId, candidateName) {
  return `${jobId || 0}::${String(candidateName || "").trim()}`;
}

async function ensureInterviewSession(candidateName) {
  const contextKey = buildInterviewContextKey(state.jobId, candidateName);
  if (state.lastInterviewId && state.interviewContextKey === contextKey) {
    return state.lastInterviewId;
  }

  const interview = await apiFetch("/api/interviews", {
    method: "POST",
    body: {
      jobId: state.jobId,
      candidateName,
      interviewerName: "网页端",
    },
  });

  state.lastInterviewId = interview.interviewId;
  state.interviewContextKey = contextKey;
  return state.lastInterviewId;
}

function buildFollowupRequestKey(question, transcriptText, askedFollowups) {
  return JSON.stringify({
    question: question?.question || "",
    focus: question?.focus || "",
    transcript: transcriptText,
    askedFollowups,
  });
}

async function requestFollowupSuggestions({ manual = false } = {}) {
  const currentQuestion = getCurrentQuestion();
  const transcriptText = el.transcript.value.trim();
  const candidateName = el.candidateName.value.trim();
  const resumeText = el.resumeText.value.trim();
  const jdText = el.jdText.value.trim();

  if (!currentQuestion || !state.jobId) {
    updateFollowupStatus("状态：请先生成题库并选择当前题", true);
    renderFollowupState();
    return;
  }

  if (isPlaceholderLike(candidateName) || candidateName.length < 2) {
    updateFollowupStatus("状态：待填写候选人姓名", true);
    if (manual) alert("请先填写真实候选人姓名，再分析追问建议");
    return;
  }

  if (!hasMeaningfulText(transcriptText, 12)) {
    updateFollowupStatus("状态：回答内容过短，暂不分析", true);
    if (manual) alert("当前回答内容过短，先补充更完整的转写再分析");
    return;
  }

  const askedFollowups = [...state.followupAsked];
  const requestKey = buildFollowupRequestKey(currentQuestion, transcriptText, askedFollowups);
  if (!manual && requestKey === state.lastFollowupKey) {
    return;
  }

  const seq = state.followupRequestSeq + 1;
  state.followupRequestSeq = seq;
  setButtonBusy(el.suggestFollowupBtn, "分析中...", "分析回答并给追问建议", true);
  updateFollowupStatus(manual ? "状态：分析当前回答中..." : "状态：静默窗口已到，正在刷新追问建议...");

  try {
    const interviewId = await ensureInterviewSession(candidateName);
    const res = await apiFetch(`/api/interviews/${interviewId}/followups/suggest`, {
      method: "POST",
      body: {
        currentQuestion: currentQuestion.question,
        focus: currentQuestion.focus,
        rubric: currentQuestion.rubric,
        transcript: transcriptText,
        resumeText,
        jdText,
        askedFollowups,
      },
    });

    if (seq !== state.followupRequestSeq) return;

    state.followupAnalysis = res.analysis || null;
    state.lastFollowupKey = requestKey;
    renderFollowupState();
    updateFollowupStatus(`状态：已更新追问建议（${new Date().toLocaleTimeString()}）`);
  } catch (error) {
    if (seq !== state.followupRequestSeq) return;
    state.followupAnalysis = null;
    renderFollowupState();
    updateFollowupStatus(`状态：追问分析失败 - ${error.message}`, true);
    if (manual) alert(`追问分析失败：${error.message}`);
  } finally {
    if (seq === state.followupRequestSeq) {
      setButtonBusy(el.suggestFollowupBtn, "分析中...", "分析回答并给追问建议", false);
    }
  }
}

function scheduleFollowupAnalysis({ manual = false } = {}) {
  clearScheduledFollowup();

  if (manual) {
    requestFollowupSuggestions({ manual: true });
    return;
  }

  if (!getCurrentQuestion() || !state.jobId) {
    renderFollowupState();
    return;
  }

  if (!hasMeaningfulText(el.transcript.value.trim(), 12)) {
    renderFollowupState();
    return;
  }

  updateFollowupStatus("状态：等待回答稳定后自动分析...");
  state.followupTimer = window.setTimeout(() => {
    requestFollowupSuggestions({ manual: false });
  }, FOLLOWUP_DEBOUNCE_MS);
}

async function handleUpload(file, kind) {
  const ok = await checkBackend();
  if (!ok) {
    alert("后端未连接，请先启动后端服务");
    return;
  }

  const statusNode = kind === "jd" ? el.jdUploadStatus : el.resumeUploadStatus;
  setPillStatus(statusNode, "解析中...");

  try {
    const data = await uploadFileForText(file);
    const text = String(data.text || "").trim();

    if (!text) {
      throw new Error("文件中没有可识别文本");
    }

    if (kind === "jd") {
      el.jdText.value = text;

      if (!el.jobTitle.value.trim()) {
        el.jobTitle.value = inferTitleFromText(text) || el.jobTitle.value;
      }

      if (!el.responsibilities.value.trim()) {
        el.responsibilities.value = text.slice(0, 1200);
      }

      const must = splitByComma(el.mustSkills.value);
      if (!must.length) {
        el.mustSkills.value = uniqueKeepOrder(inferSkillsFromText(text, 6)).join(",");
      }

      const nice = splitByComma(el.niceSkills.value);
      if (!nice.length) {
        const inferred = inferSkillsFromText(text, 12);
        const mustSet = new Set(splitByComma(el.mustSkills.value));
        const niceAuto = inferred.filter((item) => !mustSet.has(item)).slice(0, 6);
        el.niceSkills.value = uniqueKeepOrder(niceAuto).join(",");
      }

      setPillStatus(statusNode, `JD已解析: ${data.fileName}`, true, false);
      return;
    }

    el.resumeText.value = text;
    setPillStatus(statusNode, `简历已解析: ${data.fileName}`, true, false);
  } catch (error) {
    setPillStatus(statusNode, `解析失败: ${error.message}`, false, true);
    alert(`文件解析失败：${error.message}`);
  }
}

el.recheckBtn.addEventListener("click", async () => {
  el.recheckBtn.disabled = true;
  await checkBackend();
  el.recheckBtn.disabled = false;
});

el.jdFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await handleUpload(file, "jd");
});

el.resumeFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await handleUpload(file, "resume");
});

el.questionBody.addEventListener("click", (event) => {
  const button = event.target.closest('button[data-action="select-question"]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (!Number.isInteger(index)) return;
  setActiveQuestion(index);
});

el.generateBtn.addEventListener("click", async () => {
  const jd = collectJd();
  if (!jd) return;

  const ok = await checkBackend();
  if (!ok) {
    alert("后端未连接，请先启动 backend: npm run dev");
    return;
  }

  setButtonBusy(el.generateBtn, "生成中...", "生成结构化面试题库", true);

  try {
    const jobRes = await apiFetch("/api/jobs", {
      method: "POST",
      body: {
        title: jd.jobTitle,
        mustSkills: jd.mustSkills,
        niceSkills: jd.niceSkills,
        responsibilities: jd.responsibilities,
        jdText: jd.jdText,
      },
    });

    state.jd = jd;
    state.jobId = jobRes.jobId;
    state.lastInterviewId = null;
    state.interviewContextKey = "";
    resetAssessmentView();

    const questionRes = await apiFetch(`/api/jobs/${state.jobId}/questions/generate`, {
      method: "POST",
      body: {
        resumeText: jd.resumeText,
        jdText: jd.jdText,
      },
    });

    state.questions = (questionRes.questions || []).map((item) => ({
      type: item.category,
      question: item.questionText,
      focus: item.focus,
      rubric: item.rubric,
    }));

    state.currentQuestionIndex = state.questions.length ? 0 : null;
    resetFollowupState({ keepQuestion: state.currentQuestionIndex !== null });
    renderQuestions(state.questions);
    renderFollowupState();
    alert(`题库生成成功，共 ${state.questions.length} 题（岗位ID: ${state.jobId}）`);
  } catch (error) {
    alert(`生成失败：${error.message}`);
  } finally {
    setButtonBusy(el.generateBtn, "生成中...", "生成结构化面试题库", false);
  }
});

el.startRecBtn.addEventListener("click", () => {
  if (!state.recognition) {
    state.recognition = setupSpeechRecognition();
  }

  if (!state.recognition) {
    el.recStatus.textContent = "状态：当前浏览器不支持语音识别，请手工记录";
    el.recStatus.classList.add("warn");
    return;
  }

  state.recognition.start();
});

el.stopRecBtn.addEventListener("click", () => {
  if (!state.recognition) return;
  state.recognition.stop();
});

el.appendBtn.addEventListener("click", () => {
  const line = el.manualAppend.value.trim();
  if (!line) return;

  const nextValue = `${el.transcript.value.trim()} ${line}`.trim();
  el.transcript.value = nextValue;
  state.transcript = nextValue;
  el.manualAppend.value = "";
  scheduleFollowupAnalysis({ manual: false });
});

el.transcript.addEventListener("input", () => {
  state.transcript = el.transcript.value.trim();
  scheduleFollowupAnalysis({ manual: false });
});

el.candidateName.addEventListener("input", () => {
  state.lastInterviewId = null;
  state.interviewContextKey = "";
});

el.suggestFollowupBtn.addEventListener("click", () => {
  scheduleFollowupAnalysis({ manual: true });
});

el.followupQuestionList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.followupAnalysis) return;

  const index = Number(button.dataset.index);
  const suggestion = state.followupAnalysis.followupQuestions?.[index];
  if (!suggestion) return;

  if (button.dataset.action === "copy-followup") {
    try {
      await navigator.clipboard.writeText(suggestion);
      updateFollowupStatus(`状态：已复制追问（${new Date().toLocaleTimeString()}）`);
    } catch {
      updateFollowupStatus("状态：复制失败，请手工复制", true);
    }
    return;
  }

  if (button.dataset.action === "mark-followup") {
    if (!state.followupAsked.includes(suggestion)) {
      state.followupAsked.push(suggestion);
      state.lastFollowupKey = "";
      renderFollowupState();
      updateFollowupStatus(`状态：已标记第 ${index + 1} 条追问为“已问”`);
      scheduleFollowupAnalysis({ manual: false });
    }
  }
});

el.evaluateBtn.addEventListener("click", async () => {
  if (!state.jobId || !state.questions.length) {
    alert("请先生成结构化面试题库");
    return;
  }

  const transcriptText = el.transcript.value.trim();
  if (!transcriptText) {
    alert("请先录入面试记录（转写或手工）");
    return;
  }

  const candidateName = el.candidateName.value.trim() || "未命名候选人";
  const resumeText = el.resumeText.value.trim();

  if (isPlaceholderLike(candidateName) || candidateName.length < 2) {
    alert("候选人姓名过短或像占位值，请填写真实姓名或可识别标识");
    return;
  }

  if (!hasMeaningfulText(transcriptText, 12)) {
    alert("面试转写内容过短或像占位值，无法生成有效评估");
    return;
  }

  if (resumeText && !hasMeaningfulText(resumeText, 12)) {
    alert("候选人简历文本内容过短或像占位值，请补充真实简历后再评估");
    return;
  }

  const ok = await checkBackend();
  if (!ok) {
    alert("后端未连接，请先启动 backend: npm run dev");
    return;
  }

  setButtonBusy(el.evaluateBtn, "评估中...", "生成初步评分与建议", true);

  try {
    state.lastInterviewId = await ensureInterviewSession(candidateName);

    await apiFetch(`/api/interviews/${state.lastInterviewId}/transcripts`, {
      method: "POST",
      body: {
        speaker: "candidate",
        content: transcriptText,
      },
    });

    const evaluateRes = await apiFetch(`/api/interviews/${state.lastInterviewId}/evaluate`, {
      method: "POST",
      body: {
        resumeText,
        jdText: state.jd?.jdText || "",
      },
    });

    state.assessmentSource = evaluateRes.source || "rule";
    state.assessment = normalizeAssessment(evaluateRes.assessment);
    renderAssessment(state.assessment);
  } catch (error) {
    alert(`评估失败：${error.message}`);
  } finally {
    setButtonBusy(el.evaluateBtn, "评估中...", "生成初步评分与建议", false);
  }
});

el.saveBtn.addEventListener("click", async () => {
  if (!state.jd || !state.assessment) {
    alert("请先完成评估，再保存档案");
    return;
  }

  const report = await fetchInterviewReportById(state.lastInterviewId);
  const record = buildRecordSnapshot(report);

  if (!record) {
    alert("当前没有可保存的评估记录");
    return;
  }

  const records = readArchive();
  records.unshift(record);
  writeArchive(records.slice(0, 200));
  renderArchive();
  alert("已保存到候选人档案（本地）");
});

el.downloadReportBtn.addEventListener("click", async () => {
  if (!state.jd || !state.assessment) {
    alert("请先完成评估，再下载报告");
    return;
  }

  const report = await fetchInterviewReportById(state.lastInterviewId);
  const record = buildRecordSnapshot(report);

  if (!record) {
    alert("当前没有可下载的评估结果");
    return;
  }

  const fileName = `${sanitizeFileSegment(record.candidate || "candidate")}_${sanitizeFileSegment(record.jobTitle || "job")}_评估报告_${buildTimestampForFile()}.txt`;
  const content = buildReportText(record);
  downloadFile(fileName, content);
});

el.exportCsvBtn.addEventListener("click", () => {
  const records = readArchive();
  if (!records.length) {
    alert("暂无可导出的档案数据");
    return;
  }

  const csv = exportArchiveAsCsv(records);
  const fileName = `候选人档案批量导出_${buildTimestampForFile()}.csv`;
  downloadFile(fileName, csv, "text/csv;charset=utf-8");
});

el.exportJsonBtn.addEventListener("click", () => {
  const records = readArchive();
  if (!records.length) {
    alert("暂无可导出的档案数据");
    return;
  }

  const jsonText = JSON.stringify(records, null, 2);
  const fileName = `候选人档案批量导出_${buildTimestampForFile()}.json`;
  downloadFile(fileName, jsonText, "application/json;charset=utf-8");
});
checkBackend();
renderFollowupState();
resetAssessmentView();
renderArchive();









