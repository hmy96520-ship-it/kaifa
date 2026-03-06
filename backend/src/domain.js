function splitCommaText(text = "") {
  return String(text)
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeJdPayload(payload) {
  const title = String(payload.title || "").trim();
  const responsibilities = String(payload.responsibilities || "").trim();

  const mustSkills = Array.isArray(payload.mustSkills)
    ? payload.mustSkills.map((i) => String(i).trim()).filter(Boolean)
    : splitCommaText(payload.mustSkills);

  const niceSkills = Array.isArray(payload.niceSkills)
    ? payload.niceSkills.map((i) => String(i).trim()).filter(Boolean)
    : splitCommaText(payload.niceSkills);

  if (!title) {
    return { ok: false, message: "title is required" };
  }

  if (!responsibilities) {
    return { ok: false, message: "responsibilities is required" };
  }

  return {
    ok: true,
    value: { title, responsibilities, mustSkills, niceSkills },
  };
}

export function generateQuestionsFromJd(jd) {
  const baseQuestions = [
    {
      category: "基础题",
      questionText: `请介绍你在${jd.title}相关岗位的经验，并说明最有代表性的案例。`,
      focus: "岗位匹配度、表达清晰度、案例真实性",
      rubric: "有完整案例并可量化结果=高分；只有描述无结果=低分",
    },
  ];

  const skills = jd.mustSkills.length ? jd.mustSkills : ["岗位关键技能"];

  const skillQuestions = skills.map((skill) => ({
    category: "专业题",
    questionText: `请结合影楼业务，说明你在“${skill}”上的实操方法，并举一个独立解决问题的例子。`,
    focus: `${skill} 的方法论、执行力、复盘能力`,
    rubric: "讲清步骤、决策依据、结果数据=高分",
  }));

  const scenarioQuestion = {
    category: "情景题",
    questionText: "如果当天拍摄排期延误且客户情绪较强，你会如何稳定现场并保证出片质量？",
    focus: "抗压能力、服务意识、跨岗位协同",
    rubric: "先安抚后给方案并落地执行=高分",
  };

  const behaviorQuestion = {
    category: "行为题",
    questionText: `请分享一次你在“${jd.responsibilities}”上执行不理想的经历，你如何修正？`,
    focus: "责任心、成长性、问题反思",
    rubric: "主动复盘并提出后续改进动作=高分",
  };

  return [...baseQuestions, ...skillQuestions, scenarioQuestion, behaviorQuestion];
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function countHits(text, terms) {
  return terms.reduce((sum, term) => sum + (term && text.includes(term) ? 1 : 0), 0);
}

export function evaluateInterview({ transcript, jd, questionCount }) {
  const normalized = String(transcript || "").replace(/\s+/g, "");
  const charCount = normalized.length;

  const keyTerms = [
    ...jd.mustSkills,
    ...jd.niceSkills,
    "客户",
    "流程",
    "沟通",
    "质量",
    "效率",
    "协同",
    "复盘",
  ];

  const keyTermHits = countHits(normalized, keyTerms);
  const coverageScore = clamp(Math.round((keyTermHits / Math.max(5, keyTerms.length)) * 100), 0, 100);
  const depthScore = clamp(Math.round(charCount / 14), 0, 100);

  const sentenceMarks = (String(transcript).match(/[。！？；]/g) || []).length;
  const communicationScore = clamp(45 + sentenceMarks * 7, 0, 100);

  const riskWords = ["不知道", "不会", "没做过", "不清楚", "忘了", "应该可以", "大概"];
  const riskHits = countHits(normalized, riskWords);
  const riskScore = clamp(100 - riskHits * 18, 0, 100);

  const totalScore = Math.round(
    coverageScore * 0.35 + depthScore * 0.25 + communicationScore * 0.2 + riskScore * 0.2,
  );

  let suggestion = "不建议录用";
  if (totalScore >= 80) suggestion = "建议录用";
  else if (totalScore >= 65) suggestion = "建议复试";

  const weakItems = [];
  if (coverageScore < 60) weakItems.push("关键技能覆盖不足，建议追问项目细节与可量化结果。");
  if (depthScore < 60) weakItems.push("回答深度偏浅，建议追问决策依据、风险与复盘动作。");
  if (communicationScore < 60) weakItems.push("表达结构不稳定，建议要求按场景-动作-结果复述。");
  if (riskScore < 70) weakItems.push("风险表述较多，建议重点核验稳定性与执行细节。");
  if (!weakItems.length) weakItems.push("整体表现稳定，可进入薪资与排班匹配环节。");

  const summary = `基于${questionCount}道结构化题及面试转写生成初评。${weakItems.join(" ")}`;

  return {
    totalScore,
    suggestion,
    coverageScore,
    depthScore,
    communicationScore,
    riskScore,
    summary,
  };
}
