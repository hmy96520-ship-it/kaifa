const IS_FILE_MODE = window.location.protocol === "file:";
const HAS_EXPLICIT_PORT = window.location.port && window.location.port.length > 0;
const IS_BACKEND_PORT = window.location.port === "3001";
const API_BASE = IS_FILE_MODE
  ? "http://localhost:3001"
  : HAS_EXPLICIT_PORT && !IS_BACKEND_PORT
    ? `http://${window.location.hostname}:3001`
    : "";
const ARCHIVE_KEY = "studio_hr_records";

const state = {
  jd: null,
  jobId: null,
  questions: [],
  transcript: "",
  assessment: null,
  lastInterviewId: null,
  recognition: null,
};

const el = {
  backendStatus: document.getElementById("backendStatus"),
  recheckBtn: document.getElementById("recheckBtn"),
  jobTitle: document.getElementById("jobTitle"),
  mustSkills: document.getElementById("mustSkills"),
  niceSkills: document.getElementById("niceSkills"),
  responsibilities: document.getElementById("responsibilities"),
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
  assessmentEmpty: document.getElementById("assessmentEmpty"),
  assessmentPanel: document.getElementById("assessmentPanel"),
  totalScore: document.getElementById("totalScore"),
  hiringSuggestion: document.getElementById("hiringSuggestion"),
  dimensionScores: document.getElementById("dimensionScores"),
  assessmentSummary: document.getElementById("assessmentSummary"),
  archiveEmpty: document.getElementById("archiveEmpty"),
  archiveList: document.getElementById("archiveList"),
};

function splitByComma(text) {
  return String(text)
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectJd() {
  const jd = {
    jobTitle: el.jobTitle.value.trim(),
    mustSkills: splitByComma(el.mustSkills.value),
    niceSkills: splitByComma(el.niceSkills.value),
    responsibilities: el.responsibilities.value.trim(),
  };

  if (!jd.jobTitle) {
    alert("请先填写岗位名称");
    return null;
  }

  if (!jd.responsibilities) {
    alert("请先填写核心职责");
    return null;
  }

  return jd;
}

function setBackendStatus(ok, text) {
  el.backendStatus.textContent = text;
  el.backendStatus.classList.remove("good", "bad");
  el.backendStatus.classList.add(ok ? "good" : "bad");
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

async function checkBackend() {
  try {
    const health = await apiFetch("/api/health");
    if (health.ok && health.db) {
      setBackendStatus(true, "后端：已连接 (3001)");
      return true;
    }

    setBackendStatus(false, "后端：未就绪");
    return false;
  } catch {
    setBackendStatus(false, "后端：连接失败，请先 npm run dev");
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
  if (!SpeechRecognition) {
    return null;
  }

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
  return {
    total: apiResult.totalScore,
    suggestion: apiResult.suggestion,
    summary: apiResult.summary,
    dimension: [
      { name: "技能覆盖", score: apiResult.coverageScore },
      { name: "回答深度", score: apiResult.depthScore },
      { name: "表达结构", score: apiResult.communicationScore },
      { name: "风险控制", score: apiResult.riskScore },
    ],
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

el.recheckBtn.addEventListener("click", async () => {
  el.recheckBtn.disabled = true;
  await checkBackend();
  el.recheckBtn.disabled = false;
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
      },
    });

    state.jd = jd;
    state.jobId = jobRes.jobId;

    const questionRes = await apiFetch(`/api/jobs/${state.jobId}/questions/generate`, {
      method: "POST",
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
    });

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

  const candidate = el.candidateName.value.trim() || "未命名候选人";
  let report = null;

  if (state.lastInterviewId) {
    try {
      const reportRes = await apiFetch(`/api/interviews/${state.lastInterviewId}/report`);
      report = reportRes.report || null;
    } catch {
      report = null;
    }
  }

  const record = {
    id: Date.now(),
    interviewId: state.lastInterviewId,
    time: new Date().toLocaleString(),
    candidate,
    jobTitle: report?.jobTitle || state.jd.jobTitle,
    total: report?.totalScore ?? state.assessment.total,
    suggestion: report?.suggestion || state.assessment.suggestion,
    transcript: el.transcript.value.trim(),
  };

  const records = readArchive();
  records.unshift(record);
  writeArchive(records.slice(0, 100));
  renderArchive();
  alert("已保存到候选人档案（本地）");
});

checkBackend();
renderArchive();





