# 影楼人资系统（流程 MVP）

你现在有两部分：

- 前端原型：`index.html`（浏览器打开）
- 正式后端：`backend/`（Node.js + MySQL）

## 启动顺序

1. 启动 MySQL 服务（你已完成）
2. 启动后端：

```bash
cd C:\Users\96520\Desktop\codex\backend
npm run dev
```

3. 打开前端页面：

- 双击 `C:\Users\96520\Desktop\codex\index.html`
- 页面顶部会显示“后端连接状态”

## 当前前端能力

- 填写 JD 后点击“生成结构化面试题库”：会调用后端并写入数据库
- 面试记录后点击“生成初步评分与建议”：会创建面试会话、写入转写、调用 AI 评估接口
- 点击“保存到候选人档案”：保存本地归档（可后续改为后端持久化）

## 数据库脚本

- `database/schema.sql`

## 后端接口示例

- `backend/api-examples.http`
