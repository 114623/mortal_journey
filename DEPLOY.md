# 部署到 GitHub Pages

项目是纯前端，不需要服务器；存档和 API Key 都存在玩家浏览器里。

## 操作步骤

### 1. 本地跑通构建

```bash
cd /d/ak/mortal_journey-main
npm install
npm run build
```

（`build` 带 `vue-tsc --noEmit` 类型检查，本地不过 CI 一定红。）

### 2. 初始化仓库

ZIP 下载的源码包没有 `.git`，需要先初始化。已是仓库可跳过。

```bash
git init
git add .
git commit -m "初始提交"
```

### 3. GitHub 新建仓库

<https://github.com/new> → 填仓库名 → 选 **Public**。

⚠️ 三个勾（Add README / .gitignore / license）**全部不要勾**，否则首次 push 会被拒。

### 4. 推送

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

弹密码框时填 **Personal Access Token**（GitHub 已取消密码推送）。
生成方式：Settings → Developer settings → Personal access tokens → 勾 `repo` 权限。

### 5. 开启 Pages

仓库 **Settings → Pages → Build and deployment → Source**，选 **GitHub Actions**。

⚠️ 不要选 "Deploy from a branch"，选了 Actions 不会跑。

### 6. 验证

Actions 标签页等绿勾（1~3 分钟），访问：

```
https://<你的用户名>.github.io/<仓库名>/
```

打开后在启动页填 Base URL / API Key / Model 即可开始玩。

## 以后更新

```bash
git add . && git commit -m "改了什么" && git push
```

push 到 main 自动构建部署，1~3 分钟生效。

## 卡住了看这里

| 现象 | 解决 |
|---|---|
| npm 报「禁止运行脚本」 | PowerShell 执行策略拦的，改用 cmd 或 Git Bash 跑 |
| 白屏 + 控制台 404 | `vite.config.ts` 的 `base` 必须是 `"./"` |
| 打开是 404 | Pages 的 Source 选错了，改成 GitHub Actions |
| Actions 报 `error TS...` | 本地 `npm run build` 先跑通 |
| push 被拒 rejected | 远程有提交，先 `git pull --rebase origin main` |
| push 提示认证失败 | 改用 Personal Access Token 或 SSH |
| Actions 里看不到运行记录 | Fork 的仓库需先到 Actions 页点 "I understand my workflows" 启用 |
| 文生图报 CORS/403 | 生产环境需自填带 CORS 头的代理地址 |

## 注意

- 免费账号仓库必须 **Public**，源码全公开
- 无云同步，清缓存 / 换浏览器 = 存档丢失
- 自定义域名：Settings → Pages 填域名，DNS 加一条 CNAME 指向 `<用户名>.github.io`
