const IS_FILE_MODE = window.location.protocol === "file:";
const HAS_EXPLICIT_PORT = window.location.port && window.location.port.length > 0;
const IS_BACKEND_PORT = window.location.port === "3001";
const API_BASE = IS_FILE_MODE
  ? "http://localhost:3001"
  : HAS_EXPLICIT_PORT && !IS_BACKEND_PORT
    ? `http://${window.location.hostname}:3001`
    : "";
const WS_BASE = (() => {
  if (IS_FILE_MODE) return "ws://localhost:3001";
  if (API_BASE) {
    return API_BASE.replace(/^http/i, "ws");
  }
  return window.location.origin.replace(/^http/i, "ws");
})();
const DEFAULT_CANDIDATE_NAME = "候选人";
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
const RECORDING_BACKUP_CHUNK_MS = 4000;
const PCM_SAMPLE_RATE = 16000;
const PCM_PACKET_BYTES = 3200;

const state = {
  jd: null,
  jobId: null,
  questions: [],
  transcript: "",
  assessment: null,
  assessmentSource: "rule",
  lastInterviewId: null,
  interviewContextKey: "",
  asr: { enabled: false },
  recognition: null,
  recorder: null,
  mediaStream: null,
  audioContext: null,
  audioSource: null,
  audioProcessor: null,
  audioSink: null,
  realtimeSocket: null,
  realtimeReady: false,
  realtimeSendBuffer: new Uint8Array(0),
  realtimePartialText: "",
  realtimeReconnectAvailable: false,
  recordingMode: "detecting",
  recordingMimeType: "",
  recordingSessionId: "",
  recordingChunks: [],
  isRecording: false,
  currentQuestionIndex: null,
  followupByQuestion: {},
};

const el = {
  backendStatus: document.getElementById("backendStatus"),
  recheckBtn: document.getElementById("recheckBtn"),
  jdFile: document.getElementById("jdFile"),
  jdUploadStatus: document.getElementById("jdUploadStatus"),
  resumeFile: document.getElementById("resumeFile"),
  resumeUploadStatus: document.getElementById("resumeUploadStatus"),
  jdText: document.getElementById("jdText"),
  resumeText: document.getElementById("resumeText"),
  generateBtn: document.getElementById("generateBtn"),
  generateStatus: document.getElementById("generateStatus"),
  questionEmpty: document.getElementById("questionEmpty"),
  questionTable: document.getElementById("questionTable"),
  questionBody: document.getElementById("questionBody"),
  startRecBtn: document.getElementById("startRecBtn"),
  stopRecBtn: document.getElementById("stopRecBtn"),
  restartRealtimeBtn: document.getElementById("restartRealtimeBtn"),
  downloadAudioBtn: document.getElementById("downloadAudioBtn"),
  recStatus: document.getElementById("recStatus"),
  recMode: document.getElementById("recMode"),
  recPreview: document.getElementById("recPreview"),
  transcript: document.getElementById("transcript"),
  currentQuestionPreview: document.getElementById("currentQuestionPreview"),
  suggestFollowupBtn: document.getElementById("suggestFollowupBtn"),
  followupStatus: document.getElementById("followupStatus"),
  followupEmpty: document.getElementById("followupEmpty"),
  followupPanel: document.getElementById("followupPanel"),
  followupRoundCount: document.getElementById("followupRoundCount"),
  followupHistory: document.getElementById("followupHistory"),
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

function createEmptyFollowupState() {
  return {
    rounds: [],
    requestSeq: 0,
    lastKey: "",
  };
}

function getFollowupState(questionIndex = state.currentQuestionIndex) {
  if (!Number.isInteger(questionIndex) || questionIndex < 0) {
    return null;
  }

  if (!state.followupByQuestion[questionIndex]) {
    state.followupByQuestion[questionIndex] = createEmptyFollowupState();
  }

  return state.followupByQuestion[questionIndex];
}

function getAskedFollowups() {
  const followupState = getFollowupState();
  if (!followupState) return [];

  const asked = [];
  for (const round of followupState.rounds) {
    for (const item of round.askedFollowups || []) {
      if (!asked.includes(item)) {
        asked.push(item);
      }
    }
  }

  return asked;
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

function createFollowupList(items, emptyText) {
  const list = document.createElement("ul");
  list.className = "followup-list";
  const values = Array.isArray(items) && items.length ? items : [emptyText];
  values.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });

  return list;
}

function createFollowupQuestionList(round, roundIndex) {
  const list = document.createElement("ul");
  list.className = "followup-list";
  const items = Array.isArray(round.followupQuestions) ? round.followupQuestions : [];

  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "当前回答已经比较完整，暂无新增追问。";
    list.appendChild(li);
    return list;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "followup-question-item";

    const asked = round.askedFollowups.includes(item);
    if (asked) {
      li.classList.add("is-asked");
    }

    const text = document.createElement("div");
    text.className = "followup-question-text";
    text.textContent = item;
    if (asked) {
      text.classList.add("is-asked");
    }

    const actions = document.createElement("div");
    actions.className = "followup-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "ghost-btn";
    copyBtn.dataset.action = "copy-followup";
    copyBtn.dataset.roundIndex = String(roundIndex);
    copyBtn.dataset.index = String(index);
    copyBtn.textContent = "复制";

    const markBtn = document.createElement("button");
    markBtn.type = "button";
    markBtn.className = "ghost-btn";
    markBtn.dataset.action = "mark-followup";
    markBtn.dataset.roundIndex = String(roundIndex);
    markBtn.dataset.index = String(index);
    markBtn.textContent = asked ? "已追问" : "标记已问";
    markBtn.disabled = asked;

    actions.append(copyBtn, markBtn);
    li.append(text, actions);
    list.appendChild(li);
  });

  return list;
}

function renderFollowupState() {
  const currentQuestion = getCurrentQuestion();
  const followupState = getFollowupState();
  el.suggestFollowupBtn.disabled = !currentQuestion || !state.jobId;

  if (!currentQuestion) {
    el.currentQuestionPreview.textContent = "请先在题库中选择“设为当前题”";
    el.followupEmpty.classList.remove("hidden");
    el.followupPanel.classList.add("hidden");
    el.followupRoundCount.textContent = "追问轮次：0";
    el.followupHistory.innerHTML = "";
    updateFollowupStatus("状态：待选择题目");
    return;
  }

  el.currentQuestionPreview.textContent = `${currentQuestion.type}｜${currentQuestion.question}`;

  if (!followupState || !followupState.rounds.length) {
    el.followupEmpty.classList.remove("hidden");
    el.followupPanel.classList.add("hidden");
    el.followupEmpty.textContent = "当前题已选。候选人回答一轮后，点击“手动生成下一轮追问”。历史轮次会一直保留。";
    el.followupRoundCount.textContent = "追问轮次：0";
    el.followupHistory.innerHTML = "";
    if (!/分析|失败|已生成|已标记|已更新/.test(el.followupStatus.textContent)) {
      updateFollowupStatus("状态：待手动生成第一轮追问");
    }
    return;
  }

  el.followupEmpty.classList.add("hidden");
  el.followupPanel.classList.remove("hidden");
  el.followupRoundCount.textContent = `追问轮次：${followupState.rounds.length}`;
  el.followupHistory.innerHTML = "";

  followupState.rounds.forEach((round, roundIndex) => {
    const article = document.createElement("article");
    article.className = "followup-round";

    const header = document.createElement("div");
    header.className = "followup-round-header";

    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "followup-round-title";
    title.textContent = `第 ${roundIndex + 1} 轮追问`;

    const time = document.createElement("div");
    time.className = "followup-round-time";
    time.textContent = `生成于 ${round.generatedAt}`;

    titleWrap.append(title, time);

    const meta = document.createElement("div");
    meta.className = "followup-round-meta";

    const completeness = document.createElement("span");
    completeness.className = "status-pill";
    completeness.textContent = round.answerComplete ? "回答完整度：较完整" : "回答完整度：仍需追问";

    const askedCount = document.createElement("span");
    askedCount.className = "status-pill";
    askedCount.textContent = `已追问：${round.askedFollowups.length}/${round.followupQuestions.length}`;

    meta.append(completeness, askedCount);
    header.append(titleWrap, meta);

    const grid = document.createElement("div");
    grid.className = "followup-grid";

    const riskSection = document.createElement("div");
    riskSection.className = "followup-section";
    riskSection.innerHTML = "<h3>风险点</h3>";
    riskSection.appendChild(createFollowupList(round.riskPoints, "暂无明显风险点"));

    const missingSection = document.createElement("div");
    missingSection.className = "followup-section";
    missingSection.innerHTML = "<h3>缺失信息</h3>";
    missingSection.appendChild(createFollowupList(round.missingInfo, "暂无明显信息缺口"));

    grid.append(riskSection, missingSection);

    const questionSection = document.createElement("div");
    questionSection.className = "followup-section";
    questionSection.innerHTML = "<h3>建议追问</h3>";
    questionSection.appendChild(createFollowupQuestionList(round, roundIndex));

    article.append(header, grid, questionSection);
    el.followupHistory.appendChild(article);
  });
}

function resetFollowupState({ keepQuestion = false } = {}) {
  state.followupByQuestion = {};
  if (!keepQuestion) {
    state.currentQuestionIndex = null;
  }
  renderFollowupState();
}

function collectJd() {
  const jdText = el.jdText.value.trim();
  const resumeText = el.resumeText.value.trim();

  if (!hasMeaningfulText(jdText, 12)) {
    alert("请先填写或上传完整 JD 画像原文（内容需足够具体）");
    return null;
  }

  const jobTitle = inferTitleFromText(jdText) || "未命名岗位";

  if (resumeText && !hasMeaningfulText(resumeText, 12)) {
    alert("候选人简历文本内容过短或像占位值，请上传/粘贴真实简历内容");
    return null;
  }

  return {
    jobTitle,
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
  node.classList.remove("good", "bad", "loading");
  if (good) node.classList.add("good");
  if (bad) node.classList.add("bad");
}

function setGenerateStatus(text, tone = "idle") {
  setPillStatus(el.generateStatus, text, tone === "good", tone === "bad");
  if (tone === "loading") {
    el.generateStatus.classList.add("loading");
  }
}

function setRecordingModeStatus(text, tone = "idle") {
  setPillStatus(el.recMode, text, tone === "good", tone === "bad");
  if (tone === "loading") {
    el.recMode.classList.add("loading");
  }
}

function setRecordingStatus(text, warn = false) {
  el.recStatus.textContent = text;
  el.recStatus.classList.toggle("warn", warn);
}

function browserSpeechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function mediaRecorderSupported() {
  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

function realtimeStreamingSupported() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  return Boolean(AudioContextClass && AudioContextClass.prototype?.createScriptProcessor);
}

function createRecordingSessionId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `rec-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function chooseRecordingMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) {
    return "audio/webm";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((item) => window.MediaRecorder.isTypeSupported(item)) || "";
}

function getRecordingMode() {
  if (state.asr?.enabled && mediaRecorderSupported() && realtimeStreamingSupported()) return "managed";
  if (browserSpeechSupported()) return "browser";
  if (mediaRecorderSupported()) return "record-only";
  return "manual";
}

function updateRecordingUi({ preserveStatus = false } = {}) {
  if (state.isRecording) return;

  state.recordingMode = getRecordingMode();
  if (state.recordingMode === "managed") {
    setRecordingModeStatus("转写模式：阿里云实时转写 + 录音备份", "good");
    if (!preserveStatus) setRecordingStatus("状态：待开始");
  } else if (state.recordingMode === "browser") {
    setRecordingModeStatus("转写模式：浏览器兼容模式", "bad");
    if (!preserveStatus) setRecordingStatus("状态：待开始（兼容模式）");
  } else if (state.recordingMode === "record-only") {
    setRecordingModeStatus("转写模式：仅录音备份", "bad");
    if (!preserveStatus) setRecordingStatus("状态：当前环境仅支持录音备份", true);
  } else {
    setRecordingModeStatus("转写模式：仅手工记录", "bad");
    if (!preserveStatus) setRecordingStatus("状态：当前环境不支持录音，请手工记录", true);
  }

  el.startRecBtn.disabled = state.recordingMode === "manual";
  el.stopRecBtn.disabled = true;
  el.restartRealtimeBtn.disabled = true;
  el.downloadAudioBtn.disabled = !state.recordingChunks.length;
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

async function apiFormFetch(path, formData) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: formData,
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
    state.asr = health.asr || { enabled: false };
    if (health.ok && health.db) {
      const aiLabel = health.ai?.enabled ? "AI:开" : "AI:关";
      const asrLabel = health.asr?.enabled ? "ASR:开" : "ASR:关";
      setBackendStatus(true, `后端：已连接 (${aiLabel} / ${asrLabel})`);
      updateRecordingUi();
      return true;
    }

    state.asr = { enabled: false };
    setBackendStatus(false, "后端：未就绪");
    updateRecordingUi();
    return false;
  } catch {
    state.asr = { enabled: false };
    setBackendStatus(false, "后端：连接失败，请先启动 backend");
    updateRecordingUi();
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
  const followupState = getFollowupState(index);
  if (followupState?.rounds.length) {
    updateFollowupStatus(`状态：已切换到第 ${index + 1} 题，已恢复 ${followupState.rounds.length} 轮追问记录`);
  } else {
    updateFollowupStatus(`状态：已切换到第 ${index + 1} 题，请手动生成第一轮追问`);
  }
  renderQuestions(state.questions);
  renderFollowupState();
}

function guessAudioExtension(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("webm")) return "webm";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp4") || value.includes("m4a")) return "m4a";
  if (value.includes("wav")) return "wav";
  return "webm";
}

function clearRecordingArtifacts() {
  state.recordingSessionId = "";
  state.recordingChunks = [];
  state.recordingMimeType = "";
  state.realtimeSendBuffer = new Uint8Array(0);
  state.realtimePartialText = "";
  state.realtimeReconnectAvailable = false;
  el.restartRealtimeBtn.disabled = true;
  el.downloadAudioBtn.disabled = true;
  if (el.recPreview) {
    el.recPreview.textContent = "识别预览：等待开始";
  }
}

function stopMediaStream() {
  if (!state.mediaStream) return;
  for (const track of state.mediaStream.getTracks()) {
    track.stop();
  }
  state.mediaStream = null;
}

function stopAudioPipeline() {
  if (state.audioProcessor) {
    try {
      state.audioProcessor.disconnect();
    } catch {}
  }
  if (state.audioSource) {
    try {
      state.audioSource.disconnect();
    } catch {}
  }
  if (state.audioSink) {
    try {
      state.audioSink.disconnect();
    } catch {}
  }
  if (state.audioContext) {
    try {
      state.audioContext.close();
    } catch {}
  }

  state.audioProcessor = null;
  state.audioSource = null;
  state.audioSink = null;
  state.audioContext = null;
}

function closeRealtimeSocket() {
  const socket = state.realtimeSocket;
  state.realtimeSocket = null;
  state.realtimeReady = false;
  state.realtimeSendBuffer = new Uint8Array(0);
  if (!socket) return;
  try {
    socket.close();
  } catch {}
}

function concatUint8Arrays(first, second) {
  const left = first instanceof Uint8Array ? first : new Uint8Array(first || []);
  const right = second instanceof Uint8Array ? second : new Uint8Array(second || []);
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate >= inputSampleRate) {
    return buffer;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }

    result[offsetResult] = count ? accum / count : buffer[offsetBuffer] || 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPcm(floatBuffer) {
  const pcm = new Int16Array(floatBuffer.length);
  for (let i = 0; i < floatBuffer.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, floatBuffer[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

function buildPcmPacket(floatBuffer, inputSampleRate) {
  const mono = downsampleBuffer(floatBuffer, inputSampleRate, PCM_SAMPLE_RATE);
  return floatTo16BitPcm(mono);
}

function updateRealtimePreview(text) {
  state.realtimePartialText = String(text || "").trim();
  if (!el.recPreview) return;
  el.recPreview.textContent = state.realtimePartialText
    ? `识别预览：${state.realtimePartialText}`
    : "识别预览：等待下一句";
}

function flushRealtimeBuffer() {
  if (!state.realtimeReady || !state.realtimeSocket || state.realtimeSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  while (state.realtimeSendBuffer.length >= PCM_PACKET_BYTES) {
    const packet = state.realtimeSendBuffer.slice(0, PCM_PACKET_BYTES);
    state.realtimeSendBuffer = state.realtimeSendBuffer.slice(PCM_PACKET_BYTES);
    state.realtimeSocket.send(packet.buffer);
  }
}

function waitForRealtimeFinished(socket, timeoutMs = 4000) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", finish);
      window.clearTimeout(timer);
      resolve();
    };

    const handleMessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "finished" || payload.type === "error") {
          finish();
        }
      } catch {}
    };

    const timer = window.setTimeout(finish, timeoutMs);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", finish);
  });
}

function queueRealtimePcm(pcmChunk) {
  state.realtimeSendBuffer = concatUint8Arrays(state.realtimeSendBuffer, pcmChunk);
  if (!state.realtimeReady && state.realtimeSendBuffer.length > PCM_PACKET_BYTES * 10) {
    state.realtimeSendBuffer = state.realtimeSendBuffer.slice(-PCM_PACKET_BYTES * 10);
  }
  flushRealtimeBuffer();
}

function handleRealtimeResult(payload) {
  const text = String(payload?.text || "").trim();
  if (!text) return;

  if (payload.sentenceEnd) {
    appendTranscriptText(text);
    updateRealtimePreview("");
    if (state.isRecording) {
      setRecordingStatus("状态：录音中，正在实时转写...");
    }
    return;
  }

  updateRealtimePreview(text);
}

function buildRealtimeSocketUrl() {
  return `${WS_BASE}/api/asr/realtime`;
}

function connectRealtimeSocket({ manualReconnect = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(buildRealtimeSocketUrl());
    state.realtimeSocket = socket;
    state.realtimeReady = false;
    state.realtimeReconnectAvailable = false;
    el.restartRealtimeBtn.disabled = true;

    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "start",
          sessionId: state.recordingSessionId || "",
        })
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let payload = {};
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "ready") {
        state.realtimeReady = true;
        state.realtimeReconnectAvailable = false;
        el.restartRealtimeBtn.disabled = true;
        flushRealtimeBuffer();
        setRecordingStatus(
          manualReconnect ? "状态：实时转写已重连，继续识别中..." : "状态：录音中，实时转写已连接"
        );
        resolve(payload);
        return;
      }

      if (payload.type === "result") {
        handleRealtimeResult(payload);
        return;
      }

      if (payload.type === "finished") {
        state.realtimeReady = false;
        state.realtimeReconnectAvailable = false;
        el.restartRealtimeBtn.disabled = true;
        updateRealtimePreview("");
        if (state.isRecording) {
          setRecordingStatus("状态：录音停止中，正在收尾最后一段...");
        }
        return;
      }

      if (payload.type === "error") {
        state.realtimeReady = false;
        state.realtimeReconnectAvailable = state.isRecording;
        el.restartRealtimeBtn.disabled = !state.isRecording;
        updateRealtimePreview("");
        setRecordingStatus(`状态：实时转写断开 - ${payload.message}`, true);
        reject(new Error(payload.message || "Realtime ASR failed"));
      }
    };

    socket.onerror = () => {
      state.realtimeReady = false;
      state.realtimeReconnectAvailable = state.isRecording;
      el.restartRealtimeBtn.disabled = !state.isRecording;
      updateRealtimePreview("");
      reject(new Error("无法建立实时转写连接"));
    };

    socket.onclose = () => {
      const wasCurrent = state.realtimeSocket === socket;
      if (!wasCurrent) return;

      state.realtimeSocket = null;
      state.realtimeReady = false;
      if (state.isRecording) {
        state.realtimeReconnectAvailable = true;
        el.restartRealtimeBtn.disabled = false;
        updateRealtimePreview("");
        setRecordingStatus("状态：实时转写连接已断开，录音备份仍在继续，可点“重连实时转写”", true);
      }
    };
  });
}

function mergeTranscriptText(currentText, nextText) {
  const current = String(currentText || "").trim();
  const next = String(nextText || "").trim();
  if (!next) return current;
  if (!current) return next;

  const maxOverlap = Math.min(24, current.length, next.length);
  for (let size = maxOverlap; size >= 6; size -= 1) {
    if (current.slice(-size) === next.slice(0, size)) {
      return `${current}${next.slice(size)}`.trim();
    }
  }

  return `${current} ${next}`.trim();
}

function appendTranscriptText(nextText) {
  const merged = mergeTranscriptText(el.transcript.value, nextText);
  el.transcript.value = merged;
  state.transcript = merged;
  handleTranscriptChanged();
}

async function restartRealtimeStreaming() {
  if (!state.isRecording) {
    setRecordingStatus("状态：当前未在录音，无需重连实时转写");
    el.restartRealtimeBtn.disabled = true;
    return;
  }

  if (!state.realtimeReconnectAvailable) {
    setRecordingStatus("状态：实时转写连接正常，无需重连");
    el.restartRealtimeBtn.disabled = true;
    return;
  }

  setButtonBusy(el.restartRealtimeBtn, "重连中...", "重连实时转写", true);
  setRecordingStatus("状态：正在重连实时转写...");

  try {
    closeRealtimeSocket();
    await connectRealtimeSocket({ manualReconnect: true });
  } catch (error) {
    setRecordingStatus(`状态：重连失败 - ${error.message}`, true);
    state.realtimeReconnectAvailable = true;
  } finally {
    el.restartRealtimeBtn.disabled = !state.realtimeReconnectAvailable;
    setButtonBusy(el.restartRealtimeBtn, "重连中...", "重连实时转写", false);
  }
}

function downloadRecordingBackup() {
  if (!state.recordingChunks.length) {
    alert("当前还没有录音备份");
    return;
  }

  const mimeType = state.recordingMimeType || state.recordingChunks[0]?.blob?.type || "audio/webm";
  const extension = guessAudioExtension(mimeType);
  const combinedBlob = new Blob(state.recordingChunks.map((item) => item.blob), { type: mimeType });
  const fileName = `面试录音备份_${buildTimestampForFile()}.${extension}`;
  downloadFile(fileName, combinedBlob, mimeType);
}

async function startManagedRecording({ transcribeChunks = true } = {}) {
  if (!mediaRecorderSupported()) {
    setRecordingStatus("状态：当前浏览器不支持稳定录音，请改为手工记录", true);
    return;
  }

  clearRecordingArtifacts();
  closeRealtimeSocket();
  stopAudioPipeline();
  stopMediaStream();
  state.recorder = null;
  state.recordingMode = transcribeChunks ? "managed" : "record-only";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = AudioContextClass ? new AudioContextClass() : null;

    state.mediaStream = stream;
    state.recorder = recorder;
    state.audioContext = audioContext;
    state.recordingMimeType = recorder.mimeType || mimeType || "audio/webm";
    state.recordingSessionId = createRecordingSessionId();
    state.isRecording = true;

    el.startRecBtn.disabled = true;
    el.stopRecBtn.disabled = true;
    el.restartRealtimeBtn.disabled = true;
    el.downloadAudioBtn.disabled = true;

    setRecordingModeStatus(
      transcribeChunks ? "转写模式：阿里云实时转写 + 录音备份" : "转写模式：仅录音备份",
      transcribeChunks ? "good" : "bad"
    );
    updateRealtimePreview("");
    setRecordingStatus(transcribeChunks ? "状态：正在建立实时转写连接..." : "状态：录音中，正在保留录音备份");

    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      state.recordingChunks.push({ blob: event.data });
      el.downloadAudioBtn.disabled = false;
    };

    recorder.onerror = () => {
      setRecordingStatus("状态：录音异常，请停止后重试或下载录音备份", true);
    };

    recorder.onstop = async () => {
      state.isRecording = false;
      el.startRecBtn.disabled = false;
      el.stopRecBtn.disabled = true;
      state.realtimeReconnectAvailable = false;
      el.restartRealtimeBtn.disabled = true;
      updateRealtimePreview("");

      const activeSocket = state.realtimeSocket;
      flushRealtimeBuffer();
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        if (state.realtimeSendBuffer.length > 0) {
          activeSocket.send(state.realtimeSendBuffer.buffer.slice(0));
          state.realtimeSendBuffer = new Uint8Array(0);
        }
        activeSocket.send(JSON.stringify({ type: "stop" }));
        await waitForRealtimeFinished(activeSocket);
      }

      closeRealtimeSocket();
      stopAudioPipeline();
      stopMediaStream();
      state.recorder = null;
      setRecordingStatus(transcribeChunks ? "状态：录音已停止，已保留实时转写结果和录音备份" : "状态：录音已停止，已保留录音备份");
      el.downloadAudioBtn.disabled = !state.recordingChunks.length;
      updateRecordingUi({ preserveStatus: true });
      handleTranscriptChanged();
    };

    if (transcribeChunks) {
      if (!audioContext || typeof audioContext.createScriptProcessor !== "function") {
        throw new Error("当前浏览器不支持实时 PCM 采集");
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      await connectRealtimeSocket();

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const sink = audioContext.createGain();
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (!state.isRecording) return;
        const inputBuffer = event.inputBuffer.getChannelData(0);
        const pcmChunk = buildPcmPacket(inputBuffer, audioContext.sampleRate);
        queueRealtimePcm(pcmChunk);
      };

      source.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);

      state.audioSource = source;
      state.audioProcessor = processor;
      state.audioSink = sink;
    }

    recorder.start(RECORDING_BACKUP_CHUNK_MS);
    el.stopRecBtn.disabled = false;
  } catch (error) {
    state.isRecording = false;
    closeRealtimeSocket();
    stopAudioPipeline();
    stopMediaStream();
    state.recorder = null;
    updateRecordingUi();
    setRecordingStatus(`状态：无法启动录音 - ${error.message}`, true);
  }
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    state.isRecording = true;
    state.recordingMode = "browser";
    setRecordingModeStatus("转写模式：浏览器兼容模式", "bad");
    setRecordingStatus("状态：转写中（兼容模式）");
    el.startRecBtn.disabled = true;
    el.stopRecBtn.disabled = false;
  };

  recognition.onresult = (event) => {
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        state.transcript = mergeTranscriptText(state.transcript, piece);
      } else {
        interimText += piece;
      }
    }

    el.transcript.value = mergeTranscriptText(state.transcript, interimText);
    handleTranscriptChanged();
  };

  recognition.onerror = () => {
    setRecordingStatus("状态：语音识别异常，请改为手工记录或下载录音备份", true);
  };

  recognition.onend = () => {
    state.isRecording = false;
    el.startRecBtn.disabled = false;
    el.stopRecBtn.disabled = true;
    if (!el.recStatus.classList.contains("warn")) {
      setRecordingStatus("状态：已停止（兼容模式）");
    }
    updateRecordingUi({ preserveStatus: true });
    handleTranscriptChanged();
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

  const candidate = report?.candidateName || DEFAULT_CANDIDATE_NAME;
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
  const normalizedName = String(candidateName || "").trim() || DEFAULT_CANDIDATE_NAME;
  return `${jobId || 0}::${normalizedName}`;
}

async function ensureInterviewSession(candidateName) {
  const normalizedName = String(candidateName || "").trim() || DEFAULT_CANDIDATE_NAME;
  const contextKey = buildInterviewContextKey(state.jobId, normalizedName);
  if (state.lastInterviewId && state.interviewContextKey === contextKey) {
    return state.lastInterviewId;
  }

  const interview = await apiFetch("/api/interviews", {
    method: "POST",
    body: {
      jobId: state.jobId,
      candidateName: normalizedName,
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
  const questionIndex = state.currentQuestionIndex;
  const currentQuestion = getCurrentQuestion();
  const followupState = getFollowupState(questionIndex);
  const transcriptText = el.transcript.value.trim();
  const candidateName = DEFAULT_CANDIDATE_NAME;
  const resumeText = el.resumeText.value.trim();
  const jdText = el.jdText.value.trim();

  if (!currentQuestion || !state.jobId) {
    updateFollowupStatus("状态：请先生成题库并选择当前题", true);
    renderFollowupState();
    return;
  }

  if (!hasMeaningfulText(transcriptText, 12)) {
    updateFollowupStatus("状态：回答内容过短，暂不分析", true);
    if (manual) alert("当前回答内容过短，先补充更完整的转写再分析");
    return;
  }

  const askedFollowups = getAskedFollowups();
  const requestKey = buildFollowupRequestKey(currentQuestion, transcriptText, askedFollowups);
  if (requestKey === followupState?.lastKey) {
    updateFollowupStatus("状态：回答和已问追问没有变化，暂不生成新一轮", true);
    return;
  }

  const seq = (followupState?.requestSeq || 0) + 1;
  followupState.requestSeq = seq;
  setButtonBusy(el.suggestFollowupBtn, "生成中...", "手动生成下一轮追问", true);
  updateFollowupStatus("状态：正在生成下一轮追问...");

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

    if (seq !== followupState.requestSeq) return;

    const analysis = res.analysis || {};
    followupState.rounds.push({
      answerComplete: Boolean(analysis.answerComplete),
      riskPoints: Array.isArray(analysis.riskPoints) ? analysis.riskPoints : [],
      missingInfo: Array.isArray(analysis.missingInfo) ? analysis.missingInfo : [],
      followupQuestions: Array.isArray(analysis.followupQuestions) ? analysis.followupQuestions : [],
      askedFollowups: [],
      generatedAt: new Date().toLocaleTimeString(),
    });
    followupState.lastKey = requestKey;
    if (state.currentQuestionIndex === questionIndex) {
      renderFollowupState();
      updateFollowupStatus(`状态：已生成第 ${followupState.rounds.length} 轮追问（${new Date().toLocaleTimeString()}）`);
    }
  } catch (error) {
    if (seq !== followupState.requestSeq) return;
    if (state.currentQuestionIndex === questionIndex) {
      renderFollowupState();
      updateFollowupStatus(`状态：追问分析失败 - ${error.message}`, true);
    }
    if (manual) alert(`追问分析失败：${error.message}`);
  } finally {
    if (seq === followupState.requestSeq) {
      setButtonBusy(el.suggestFollowupBtn, "生成中...", "手动生成下一轮追问", false);
    }
  }
}

function handleTranscriptChanged() {
  const followupState = getFollowupState();
  state.transcript = el.transcript.value.trim();

  if (!getCurrentQuestion() || !state.jobId) {
    return;
  }

  if (!hasMeaningfulText(state.transcript, 12)) {
    updateFollowupStatus("状态：继续记录回答，补充完整后再手动生成追问");
    return;
  }

  if (followupState?.rounds.length) {
    updateFollowupStatus("状态：回答已更新，可手动生成下一轮追问");
    return;
  }

  updateFollowupStatus("状态：回答已记录，可手动生成第一轮追问");
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

  setGenerateStatus("状态：检测后端中...", "loading");
  const ok = await checkBackend();
  if (!ok) {
    setGenerateStatus("状态：后端未连接", "bad");
    alert("后端未连接，请先启动 backend: npm run dev");
    return;
  }

  setButtonBusy(el.generateBtn, "生成中...", "生成结构化面试题库", true);
  setGenerateStatus("状态：正在创建岗位...", "loading");

  try {
    const jobRes = await apiFetch("/api/jobs", {
      method: "POST",
      body: {
        jdText: jd.jdText,
      },
    });

    state.jd = jd;
    state.jobId = jobRes.jobId;
    state.lastInterviewId = null;
    state.interviewContextKey = "";
    resetAssessmentView();
    setGenerateStatus("状态：AI 正在生成题库，通常需要 20-90 秒...", "loading");

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
    setGenerateStatus(`状态：生成完成，共 ${state.questions.length} 题`, "good");
    alert(`题库生成成功，共 ${state.questions.length} 题（岗位ID: ${state.jobId}）`);
  } catch (error) {
    setGenerateStatus(`状态：生成失败 - ${error.message}`, "bad");
    alert(`生成失败：${error.message}`);
  } finally {
    setButtonBusy(el.generateBtn, "生成中...", "生成结构化面试题库", false);
  }
});

el.startRecBtn.addEventListener("click", async () => {
  const mode = getRecordingMode();

  if (mode === "managed") {
    await startManagedRecording({ transcribeChunks: true });
    return;
  }

  if (mode === "record-only") {
    await startManagedRecording({ transcribeChunks: false });
    return;
  }

  if (!state.recognition) {
    state.recognition = setupSpeechRecognition();
  }

  if (!state.recognition) {
    setRecordingStatus("状态：当前环境不支持录音或转写，请手工记录", true);
    return;
  }

  try {
    state.recognition.start();
  } catch (error) {
    setRecordingStatus(`状态：无法启动兼容模式转写 - ${error.message}`, true);
  }
});

el.stopRecBtn.addEventListener("click", () => {
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recorder.stop();
    return;
  }
  if (!state.recognition) return;
  try {
    state.recognition.stop();
  } catch {
    setRecordingStatus("状态：停止兼容模式转写失败，请重试", true);
  }
});

el.restartRealtimeBtn.addEventListener("click", () => {
  restartRealtimeStreaming();
});

el.downloadAudioBtn.addEventListener("click", () => {
  downloadRecordingBackup();
});

el.transcript.addEventListener("input", () => {
  handleTranscriptChanged();
});

el.suggestFollowupBtn.addEventListener("click", () => {
  requestFollowupSuggestions({ manual: true });
});

el.followupHistory.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const followupState = getFollowupState();
  const roundIndex = Number(button.dataset.roundIndex);
  const index = Number(button.dataset.index);
  const round = followupState?.rounds[roundIndex];
  const suggestion = round?.followupQuestions?.[index];
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
    if (!round.askedFollowups.includes(suggestion)) {
      round.askedFollowups.push(suggestion);
      renderFollowupState();
      updateFollowupStatus(`状态：已在第 ${roundIndex + 1} 轮标记第 ${index + 1} 条追问为“已问”`);
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

  const candidateName = DEFAULT_CANDIDATE_NAME;
  const resumeText = el.resumeText.value.trim();

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
setRecordingModeStatus("转写模式：检测中", "loading");
el.startRecBtn.disabled = true;
checkBackend();
renderFollowupState();
resetAssessmentView();
renderArchive();
setGenerateStatus("状态：待生成");









