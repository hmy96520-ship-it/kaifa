# Backend (Node.js + MySQL)

## 1. 安装依赖
```bash
cd backend
npm install
```

## 2. 配置环境变量
复制 `.env.example` 为 `.env`，按实际密码修改：
```bash
cp .env.example .env
```

Windows PowerShell 可用：
```powershell
Copy-Item .env.example .env
```

## 3. 初始化数据库
在项目根目录执行：
```bash
mysql -u root -p < database/schema.sql
```

## 4. 启动
```bash
cd backend
npm run dev
```

默认端口：`3001`

## 5. 健康检查
```bash
curl http://localhost:3001/api/health
```

## 6. 核心接口
- `POST /api/jobs` 新建岗位 JD
- `POST /api/jobs/:jobId/questions/generate` 生成结构化题库
- `GET /api/jobs/:jobId/questions` 查询题库
- `POST /api/interviews` 创建面试会话
- `POST /api/interviews/:interviewId/transcripts` 追加转写片段
- `POST /api/interviews/:interviewId/evaluate` 生成 AI 初评
- `GET /api/interviews/:interviewId/report` 获取面试报告
