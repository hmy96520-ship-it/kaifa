# Backend (Node.js + MySQL)

## 1) 安装依赖
```bash
cd backend
npm install
```

## 2) 配置环境变量
复制 `.env.example` 为 `.env`：
```bash
cp .env.example .env
```

## 3) 初始化数据库
```bash
mysql -u root -p < database/schema.sql
```

## 4) 启动
```bash
cd backend
npm run dev
```

## 5) 健康检查
```bash
curl http://localhost:3001/api/health
```

## 6) 国内模型接入（OpenAI 兼容协议）

### 提示词文件
- `backend/prompts/question.system.txt`
- `backend/prompts/evaluate.system.txt`

### 环境变量
- `AI_PROVIDER=deepseek|qwen|glm|custom`
- `AI_API_KEY=...`
- `AI_BASE_URL=...`（provider 为 custom 时必填）
- `AI_MODEL_QUESTION=...`
- `AI_MODEL_EVAL=...`

### 内置 provider 预设
- `deepseek` -> `https://api.deepseek.com/v1`
- `qwen` -> `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `glm` -> `https://open.bigmodel.cn/api/paas/v4`

当 AI 配置可用时：
- 题库生成接口优先调用模型，失败自动回退规则引擎。
- 面试评估接口优先调用模型，失败自动回退规则引擎。

## 7) 主要接口
- `GET /api/ai/status` 查看 AI 配置状态（不返回密钥）
- `POST /api/files/parse-text` 上传并解析文件文本（txt/pdf/docx）
- `POST /api/jobs` 新建岗位 JD（可附带 jdText）
- `POST /api/jobs/:jobId/questions/generate` 生成题库（可附带 resumeText）
- `POST /api/interviews` 创建面试会话
- `POST /api/interviews/:interviewId/transcripts` 追加转写
- `POST /api/interviews/:interviewId/evaluate` 评估（可附带 resumeText）
- `GET /api/interviews/:interviewId/report` 报告
