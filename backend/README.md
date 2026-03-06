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

## 6) 主要接口
- `POST /api/files/parse-text` 上传并解析文件文本（支持 txt/pdf/docx）
- `POST /api/jobs` 新建岗位 JD（可附带 jdText）
- `POST /api/jobs/:jobId/questions/generate` 生成题库（可附带 resumeText）
- `POST /api/interviews` 创建面试会话
- `POST /api/interviews/:interviewId/transcripts` 追加转写
- `POST /api/interviews/:interviewId/evaluate` 评估（可附带 resumeText）
- `GET /api/interviews/:interviewId/report` 报告
