function splitCommaText(text = "") {
  return String(text)
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  if (match && match[1]) {
    return match[1].trim().slice(0, 60);
  }

  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return (firstLine || "").slice(0, 60);
}

function inferSkillsFromText(text, limit = 8) {
  const source = String(text || "");
  if (!source) return [];

  return COMMON_SKILLS.filter((skill) => source.includes(skill)).slice(0, limit);
}

function parseTextArray(input) {
  if (Array.isArray(input)) {
    return uniqueKeepOrder(input.map((item) => String(item).trim()));
  }

  return uniqueKeepOrder(splitCommaText(input));
}

export function normalizeJdPayload(payload) {
  const jdText = String(payload.jdText || "").trim();
  let title = String(payload.title || "").trim();
  let responsibilities = String(payload.responsibilities || "").trim();

  let mustSkills = parseTextArray(payload.mustSkills);
  let niceSkills = parseTextArray(payload.niceSkills);

  if (!title && jdText) {
    title = inferTitleFromText(jdText) || "未命名岗位";
  }

  if (!responsibilities && jdText) {
    responsibilities = jdText.slice(0, 2000);
  }

  if (!mustSkills.length && jdText) {
    mustSkills = inferSkillsFromText(jdText, 6);
  }

  if (!niceSkills.length && jdText) {
    const inferred = inferSkillsFromText(jdText, 12);
    niceSkills = inferred.filter((skill) => !mustSkills.includes(skill)).slice(0, 6);
  }

  if (!title) {
    return { ok: false, message: "title is required" };
  }

  if (!responsibilities) {
    return { ok: false, message: "responsibilities or jdText is required" };
  }

  return {
    ok: true,
    value: {
      title,
      responsibilities,
      mustSkills,
      niceSkills,
      jdText,
    },
  };
}

function extractResumeProfile(resumeText) {
  const raw = String(resumeText || "").trim();
  if (!raw) {
    return {
      hasResume: false,
      years: 0,
      skills: [],
      highlights: [],
      raw: "",
    };
  }

  const yearsMatches = [...raw.matchAll(/(\d{1,2})\s*年/g)].map((match) => Number(match[1]));
  const years = yearsMatches.length ? Math.max(...yearsMatches) : 0;

  const skills = inferSkillsFromText(raw, 10);
  const highlights = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12 && line.length <= 120)
    .slice(0, 3);

  return {
    hasResume: true,
    years,
    skills,
    highlights,
    raw,
  };
}

function skillMatches(skill, resumeSkills) {
  return resumeSkills.some((item) => item.includes(skill) || skill.includes(item));
}

export function generateQuestionsFromJd(jd, options = {}) {
  const resumeProfile = extractResumeProfile(options.resumeText || "");
  const skills = jd.mustSkills.length ? jd.mustSkills : ["岗位关键技能"];

  const questions = [];

  questions.push({
    category: "基础题",
    questionText: resumeProfile.years
      ? `简历显示你有约 ${resumeProfile.years} 年相关经验，请按“场景-动作-结果”介绍你与 ${jd.title} 最相关的一次项目。`
      : `请介绍你与 ${jd.title} 最相关的经历，并说明最终结果和你的关键贡献。`,
    focus: "岗位匹配度、履历真实性、结果导向",
    rubric: "有真实场景+可量化结果+角色边界清晰=高分",
  });

  for (const skill of skills) {
    if (skillMatches(skill, resumeProfile.skills)) {
      questions.push({
        category: "专业题",
        questionText: `你的简历里提到“${skill}”，请具体说明一次落地过程：目标、步骤、风险和最终指标。`,
        focus: `${skill} 深度、方法论、实操细节`,
        rubric: "讲清决策依据和数据结果=高分",
      });
      continue;
    }

    questions.push({
      category: "专业题",
      questionText: `岗位要求“${skill}”，但简历中体现较少。若你本周入岗，会如何在两周内补齐这项能力并保障业务质量？`,
      focus: `${skill} 学习迁移能力、执行计划、风险控制`,
      rubric: "有明确学习路径和可落地时间表=高分",
    });
  }

  if (resumeProfile.highlights.length) {
    questions.push({
      category: "行为题",
      questionText: `简历中有经历：“${resumeProfile.highlights[0]}”。请说明你当时最难的判断点，以及你如何复盘。`,
      focus: "履历验证、复盘能力、问题处理",
      rubric: "能复盘失误并给出改进动作=高分",
    });
  }

  questions.push({
    category: "情景题",
    questionText: `结合岗位职责“${jd.responsibilities.slice(0, 80)}...”，如果当天排期延误且客户情绪较强，你会如何在保证体验的同时控制出片质量？`,
    focus: "抗压能力、服务意识、跨岗位协同",
    rubric: "先稳客户预期，再重排执行方案并落实=高分",
  });

  questions.push({
    category: "综合题",
    questionText: `结合岗位 JD 和你的简历，请给出入职前 30 天工作计划（目标、动作、协同对象、衡量指标）。`,
    focus: "JD-履历匹配度、目标拆解能力、落地意识",
    rubric: "目标清晰、指标明确、节奏可执行=高分",
  });

  return questions.slice(0, 8);
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function countHits(text, terms) {
  return uniqueKeepOrder(terms).reduce((sum, term) => sum + (term && text.includes(term) ? 1 : 0), 0);
}

export function evaluateInterview({ transcript, jd, questionCount, resumeText = "" }) {
  const normalized = String(transcript || "").replace(/\s+/g, "");
  const charCount = normalized.length;
  const resumeProfile = extractResumeProfile(resumeText);

  const jdTerms = uniqueKeepOrder([
    ...jd.mustSkills,
    ...jd.niceSkills,
    ...inferSkillsFromText(jd.responsibilities, 6),
    "客户",
    "流程",
    "沟通",
    "质量",
    "效率",
    "协同",
    "复盘",
  ]);

  const jdHits = countHits(normalized, jdTerms);
  const coverageScore = clamp(Math.round((jdHits / Math.max(5, jdTerms.length)) * 100), 0, 100);

  const depthScore = clamp(Math.round(charCount / 14), 0, 100);

  const sentenceMarks = (String(transcript).match(/[。！？；]/g) || []).length;
  const communicationScore = clamp(45 + sentenceMarks * 7, 0, 100);

  const riskWords = ["不知道", "不会", "没做过", "不清楚", "忘了", "应该可以", "大概"];
  const riskHits = countHits(normalized, riskWords);

  const resumeTerms = resumeProfile.skills.length
    ? resumeProfile.skills
    : inferSkillsFromText(resumeProfile.raw, 6);
  const resumeHits = countHits(normalized, resumeTerms);

  const resumeAlignmentScore = resumeProfile.hasResume
    ? clamp(Math.round((resumeHits / Math.max(3, resumeTerms.length)) * 100), 0, 100)
    : 60;

  const consistencyPenalty = resumeProfile.hasResume && riskHits > 0 && resumeTerms.length
    ? Math.min(24, riskHits * 6)
    : 0;

  const riskScore = clamp(100 - riskHits * 15 - consistencyPenalty, 0, 100);

  const totalScore = Math.round(
    coverageScore * 0.3 +
      depthScore * 0.2 +
      communicationScore * 0.15 +
      riskScore * 0.15 +
      resumeAlignmentScore * 0.2,
  );

  let suggestion = "不建议录用";
  if (totalScore >= 82) suggestion = "建议录用";
  else if (totalScore >= 66) suggestion = "建议复试";

  const weakItems = [];
  if (coverageScore < 60) weakItems.push("岗位关键要求覆盖不足，建议围绕 JD 必备技能继续追问。");
  if (resumeAlignmentScore < 55 && resumeProfile.hasResume) {
    weakItems.push("面试回答与简历关联偏弱，建议做履历真实性和细节核验。");
  }
  if (depthScore < 60) weakItems.push("回答深度偏浅，建议追问决策依据、复盘动作与量化结果。");
  if (communicationScore < 60) weakItems.push("表达结构一般，可要求按“场景-动作-结果”复述。");
  if (riskScore < 70) weakItems.push("风险表述较多，建议重点核验稳定性与执行细节。");
  if (!weakItems.length) weakItems.push("JD 与履历匹配度较好，可进入薪资与排班匹配环节。");

  const summary = `基于${questionCount}道结构化题，结合岗位画像(JD)与候选人简历进行综合初评。${weakItems.join(" ")}`;

  return {
    totalScore,
    suggestion,
    coverageScore,
    depthScore,
    communicationScore,
    riskScore,
    resumeAlignmentScore,
    summary,
  };
}
