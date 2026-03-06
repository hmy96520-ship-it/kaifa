# 影楼人资系统（流程 MVP）

当前版本已经支持：

- 上传岗位 JD 文件（txt/pdf/docx）并自动解析文本
- 上传候选人简历文件（txt/pdf/docx）并自动解析文本
- 根据 JD + 简历生成更有针对性的结构化面试题
- 根据 JD + 简历 + 面试转写进行综合评分

## 启动方式

1. 启动后端

```bash
cd C:\Users\96520\Desktop\codex\backend
npm install
npm run dev
```

2. 打开页面

- 本地原型：双击 `C:\Users\96520\Desktop\codex\index.html`
- 部署版：访问 Railway 域名

## 关键说明

- 题库生成接口：`POST /api/jobs/:jobId/questions/generate`，可传 `resumeText`
- 评估接口：`POST /api/interviews/:interviewId/evaluate`，可传 `resumeText`
- 文件解析接口：`POST /api/files/parse-text`（form-data, field: `file`）

## 目录

- `backend/src`：后端接口与业务逻辑
- `backend/public`：部署时静态页面
- `database/schema.sql`：数据库建表脚本
