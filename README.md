# 效果图订单管理系统（第二代）

轻量级个人订单管理系统，用于室内效果图代画业务。

**与第一代分开部署，互不干扰。**

- **新系统链接**（部署后获得）：`https://ZTKyo.github.io/order-manager/`
- **旧系统链接**（保持原样）：`https://ZTKyo.github.io/order-management/`

## 功能

- 📋 订单卡片列表，平面图缩略图可点击放大
- 💰 报价 / 已收 / 未收 一目了然，收款一键自动变「已完成」
- 🔔 **Telegram 定时通知**（需要配置 Cloud Functions + Bot Token）
- 🔄 Firebase Firestore 实时同步，手机/电脑打开即同步
- 📦 LocalStorage 模式也能用（不登录时）
- 🔄 **自动迁移旧数据**：首次打开会扫描浏览器 LocalStorage 中常见的旧 key 并导入

## 部署（3 条命令）

```bash
cd /workspace
bash push_to_github.sh
# 按提示选择认证方式并推送
# 然后：Settings → Pages → Branch: main / root → Save
```

部署成功后约 1-2 分钟访问 `https://ZTKyo.github.io/order-manager/`

## Telegram 通知（可选）

1. 在 Telegram 给 **@BotFather** 发 `/newbot` 创建机器人，拿到 Bot Token
2. 在终端（在 /workspace 目录）：

```bash
# 安装 Firebase CLI（第一次）
npm install -g firebase-tools
firebase login

# 设置 Bot Token
firebase functions:config:set telegram.bot_token="你的BotFather给你的Token"

# 部署 Cloud Functions
cd functions && npm install && cd ..
firebase deploy --only functions
```

3. 在 Telegram 里和刚创建的机器人聊一句 `/start`，拿到自己的 `chat id`
4. 在应用内进入 `🔔 通知` 页面，填入 Chat ID 并保存

每分钟触发一次扫描测试链接：
```
https://asia-east1-order-management-62810.cloudfunctions.net/testNotify
```

## 导入旧数据

- **方法 1（推荐）**：打开新链接 → 进入 `本机模式`，系统会在浏览器中扫描旧系统常用 LocalStorage key，发现就自动导入。
- **方法 2**：在旧系统点「导出」→ 得到 JSON → 在新系统底部「导入」上传 JSON。

## 文件结构

```
├── index.html
├── css/style.css
├── js/app.js
├── functions/            # Cloud Functions (Telegram 通知)
│   ├── index.js
│   └── package.json
├── firebase.json         # Firebase 部署配置
└── push_to_github.sh     # 一键部署脚本（可选）
```
