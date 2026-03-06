const IS_FILE_MODE = window.location.protocol === "file:";
const HAS_EXPLICIT_PORT = window.location.port && window.location.port.length > 0;
const IS_BACKEND_PORT = window.location.port === "3001";
const API_BASE = IS_FILE_MODE
  ? "http://localhost:3001"
  : HAS_EXPLICIT_PORT && !IS_BACKEND_PORT
    ? `http://${window.location.hostname}:3001`
    : "";
const ARCHIVE_KEY = "studio_hr_records";

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
  recognition: null,
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

  if (!responsibilities && !jdText) {
    alert("请先填写核心职责，或上传/粘贴 JD 原文");
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

  questions.forEach((q) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${q.type}</td>
      <td>${q.question}</td>
      <td>${q.focus}</td>
      <td>${q.rubric}</td>
    `;
    el.questionBody.appendChild(tr);
  });

  el.questionEmpty.classList.add("hidden");
  el.questionTable.classList.remove("hidden");
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

    const questionRes = await apiFetch(`/api/jobs/${state.jobId}/questions/generate`, {
      method: "POST",
      body: {
        resumeText: jd.resumeText,
      },
    });

    state.questions = (questionRes.questions || []).map((item) => ({
      type: item.category,
      question: item.questionText,
      focus: item.focus,
      rubric: item.rubric,
    }));

    renderQuestions(state.questions);
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

  const ok = await checkBackend();
  if (!ok) {
    alert("后端未连接，请先启动 backend: npm run dev");
    return;
  }

  setButtonBusy(el.evaluateBtn, "评估中...", "生成初步评分与建议", true);

  try {
    const interview = await apiFetch("/api/interviews", {
      method: "POST",
      body: {
        jobId: state.jobId,
        candidateName,
        interviewerName: "网页端",
      },
    });

    state.lastInterviewId = interview.interviewId;

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
renderArchive();









