# github-hub

自动巡检 `6mt` 名下所有非 fork 的 public 仓库，每 30 分钟一次（GitHub Actions cron）。

- `index.html` — 在线看板（GitHub Pages）
- `poll.mjs` — 巡检脚本：快照各仓库 stars/forks/issues/PRs + 检测新动态（issue、评论、PR、review、star、fork）
- `data/data.json` — 看板数据（每次运行自动更新并 commit）
- `data/state.json` — 增量对比状态（各仓库 event 游标、stars 基线）

## 通知

- 新动态会写入看板「动态流」，并显示在 Actions 运行摘要里。
- 可选飞书推送：在仓库 Settings → Secrets and variables → Actions 添加 `FEISHU_WEBHOOK`
  （飞书群「自定义机器人」的 Webhook 地址），下次运行即自动推送卡片消息。

## 看板地址

GitHub Pages：https://6mt.github.io/github-hub/
