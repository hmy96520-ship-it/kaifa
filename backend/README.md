# Backend (Python/FastAPI + MySQL)

## 1) 安装依赖
```bash
cd backend
py -m pip install -r requirements.txt
```

## 2) 配置环境变量
复制 `.env.example` 为 `.env`：
```bash
copy .env.example .env
```

## 3) 初始化数据库
```bash
mysql -u root -p < database/schema.sql
```

## 4) 启动
```bash
cd backend
py -m uvicorn app.main:app --reload --host 0.0.0.0 --port 3001
```

## 5) 健康检查
```bash
curl http://localhost:3001/api/health
```

## 6) 国内模型接入（OpenAI 兼容协议）

### 提示词文件
- `backend/prompts/question.system.txt`
- `backend/prompts/evaluate.system.txt`
- `backend/prompts/followup.system.txt`

### 环境变量
- `AI_PROVIDER=kimi|deepseek|qwen|glm|custom`
- `AI_API_KEY=...`（也支持直接使用 `OPENAI_API_KEY`）
- `AI_BASE_URL=...`（provider 为 custom 时必填）
- `AI_MODEL_QUESTION=...`
- `AI_MODEL_EVAL=...`
- `AI_WIRE_API=chat_completions|responses`
- `AI_REASONING_EFFORT=low|medium|high|xhigh`（仅 `responses` 时生效）
- `AI_DISABLE_RESPONSE_STORAGE=true|false`（仅 `responses` 时生效）

### 内置 provider 预设
- `kimi` -> `https://api.moonshot.cn/v1`
- `deepseek` -> `https://api.deepseek.com/v1`
- `qwen` -> `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `glm` -> `https://open.bigmodel.cn/api/paas/v4`

当 AI 配置可用时：
- 题库生成接口调用模型。
- 面试评估接口调用模型。
- 实时追问建议接口调用模型。

### OpenAI Responses 风格示例
```env
AI_PROVIDER=custom
AI_BASE_URL=http://vivii.dpdns.org:58080
AI_API_KEY=your_api_key_here
AI_MODEL_QUESTION=gpt-5.4
AI_MODEL_EVAL=gpt-5.4
AI_WIRE_API=responses
AI_REASONING_EFFORT=xhigh
AI_DISABLE_RESPONSE_STORAGE=true
```

## 7) 稳定转写（方案一）

前端默认会优先使用：
- 浏览器录音
- 浏览器实时 PCM 采集
- 后端 `/api/asr/realtime` WebSocket 中转
- 阿里云实时语音识别
- 录音备份下载

要启用稳定转写，需要额外配置一组阿里云百炼实时 ASR 环境变量：
- `ASR_WS_URL=wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/`
- `ASR_API_KEY=...`
- `ASR_MODEL=fun-asr-realtime`
- `ASR_FORMAT=pcm`
- `ASR_SAMPLE_RATE=16000`
- `ASR_LANGUAGE_HINTS=zh`
- `ASR_VOCABULARY_ID=...`（可选，热词）
- `ASR_WORKSPACE=...`（可选）
- `ASR_DISFLUENCY_REMOVAL_ENABLED=false`
- `ASR_CONNECT_TIMEOUT_MS=10000`

当前实现的要点：
- 前端实时发送 `16k / 单声道 / PCM`
- 停止录音时会等待阿里云回完最后结果，再结束会话
- 若实时链路中断，录音备份仍会继续保存，可手动重连或下载录音

如果你使用的是北京地域 Key：
- 将 `ASR_WS_URL` 改成 `wss://dashscope.aliyuncs.com/api-ws/v1/inference/`
- 模型可继续用 `fun-asr-realtime`

如果未配置 ASR：
- 页面会自动退回浏览器兼容模式
- 仍可手工记录
- 如果浏览器支持录音但不支持兼容转写，会退到仅录音备份模式

## 8) 主要接口
- `GET /api/ai/status` 查看 AI 配置状态（不返回密钥）
- `GET /api/asr/status` 查看 ASR 配置状态（不返回密钥）
- `WS /api/asr/realtime` 实时转写中转通道
- `POST /api/files/parse-text` 上传并解析文件文本（txt/pdf/docx）
- `POST /api/jobs` 新建岗位 JD（可附带 jdText）
- `POST /api/jobs/:jobId/questions/generate` 生成题库（可附带 resumeText）
- `POST /api/interviews` 创建面试会话
- `POST /api/interviews/:interviewId/transcripts` 追加转写
- `POST /api/interviews/:interviewId/followups/suggest` 生成当前题目的实时追问建议
- `POST /api/interviews/:interviewId/evaluate` 评估（可附带 resumeText）
- `GET /api/interviews/:interviewId/report` 报告
