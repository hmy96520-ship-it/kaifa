# 影楼人资系统（流程 MVP）

当前版本支持:

- 上传岗位 JD 文件（txt/pdf/docx）并自动解析文本
- 上传候选人简历文件（txt/pdf/docx）并自动解析文本
- 根据 JD + 简历生成针对性面试题
- 根据 JD + 简历 + 面试转写做综合评分
- 单份评估报告下载（txt）
- 候选人档案批量导出（CSV/JSON）
- 可接入国内大模型（DeepSeek / 通义千问 / 智谱，OpenAI 兼容协议）

## 启动

```bash
cd C:\Users\96520\Desktop\codex\backend
npm install
npm run dev
```

访问：
- 本地：`http://localhost:3001`
- 健康：`http://localhost:3001/api/health`

## 国内模型配置

在 `backend/.env` 中设置：

```env
AI_PROVIDER=deepseek
AI_API_KEY=你的Key
AI_MODEL_QUESTION=deepseek-chat
AI_MODEL_EVAL=deepseek-chat
```

提示词文件：
- `backend/prompts/question.system.txt`
- `backend/prompts/evaluate.system.txt`

> 未配置 AI 时，系统自动回退为规则引擎，不影响基本可用性。

## 目录

- `backend/src`：后端接口与业务逻辑
- `backend/prompts`：模型提示词
- `backend/public`：部署静态页面
- `database/schema.sql`：数据库建表脚本


