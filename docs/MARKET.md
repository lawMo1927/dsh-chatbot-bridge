# 发布到 DSH 插件市场

DSH 的插件市场（dshmarket）从社区维护的插件清单拉取条目，收录需要先发布 npm 包，再提交清单。

## 一、发布 npm 包

1. 登录 npm：

```bash
npm login
```

2. 确认包名可用：

```bash
npm view dsh-chatbot-bridge version
```

3. 在仓库根目录发布：

```bash
npm publish --access public
```

## 二、提交到插件清单

插件清单由 `awesome-dsh-plugin` 社区维护（dshmarket 从该清单拉取）：

1. 打开清单仓库（通常是 GitHub 上的 awesome-dsh-plugin 项目）
2. 按仓库说明，在插件列表 JSON 中追加一条：

```json
{
  "name": "dsh-chatbot-bridge",
  "description": "一站式聊天机器人桥接器：面板管理、任务派发、双通道审批",
  "author": "你的名字",
  "repository": "https://github.com/lawMo1927/dsh-chatbot-bridge",
  "npm": "dsh-chatbot-bridge",
  "tags": ["chatbot", "bridge", "qq", "astrbot"]
}
```

3. 提交 Pull Request，等待合并
4. 合并后在 DSH 插件市场里即可搜索到

## 三、市场条目要求

- npm 包名以 `dsh-` 开头
- `package.json` 包含 `dsh.client` 声明（本仓库已包含）
- README 说明安装、配置与使用
- 提供许可证文件（本仓库为 MIT）

## 四、更新版本

修改代码后：

1. 更新 `package.json` 的 `version`
2. 重新执行 `npm publish`
3. 市场会按版本号提示更新
