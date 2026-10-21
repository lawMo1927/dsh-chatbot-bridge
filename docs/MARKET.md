# 发布到 DSH 插件市场

DSH 插件市场（dshmarket）从社区维护的清单拉取条目，清单仓库是 `awesome-dsh-plugin/awesome-dsh-plugin`，市场读取的是 `https://awesome-dsh-plugin.com/plugins.json`。收录只需要提交清单文件，不要求发布 npm 包。

## 一、仓库需要满足的条件

1. `package.json` 声明 `dsh.bundle`，指向仓库根的 `cordis.patch.yml`（本仓库已声明）：

   ```json
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" }
   }
   ```

2. 仓库根有 `cordis.patch.yml`，内容是插入本插件（本仓库已有）：

   ```yaml
   - insert:
       - id: chatbot-bridge
         name: dsh-chatbot-bridge
   ```

   只声明 `dsh.client` 的提交无法通过 CI，`dsh.bundle` 与 `cordis.patch.yml` 是安装能力的前提。

3. 仓库创建满 1 天，CI 会自动检查。
4. 仓库添加 `dsh-plugin` topic。
5. 代码真实可用，README 与实际功能一致。
6. 项目保持活跃维护。

## 二、提交清单条目

在清单仓库新增一个文件，文件名由仓库所有者与仓库名组成，中间用双下划线连接：

```text
data/plugins/lawMo1927__dsh-chatbot-bridge.yml
```

文件内容：

```yaml
url: https://github.com/lawMo1927/dsh-chatbot-bridge
name: lawMo1927/dsh-chatbot-bridge
category: tools
description:
  en: Manage a QQ chatbot from DSH, dispatch tasks to DSH, and deliver results and approval requests back to chat.
  zh: 在 DSH 中管理 QQ 聊天机器人，把任务派发给 DSH 执行，并回传结果与审批。
```

规则：

- `url` 必须与仓库地址完全一致。
- `name` 是清单里显示的链接文字，使用 `owner/repo` 形式。
- `description.en` 必填，描述只写功能，不带营销词；内容里出现半角冒号加空格时必须整体加引号。
- `description.zh` 可选，不写时由维护者补。
- 不要写 `npm`、`tags`、`author`、`repository` 字段；这些不在收录格式里，手写的 `npm` 会被校验拒绝。
- 分类从清单支持的值中选择（`tools`、`ui`、`remote`、`notify` 等），选得不准由维护者调整，不会因此打回。
- 一个 PR 最多新增 3 条条目。

提交方式：在 `awesome-dsh-plugin` 仓库新建分支，添加上述 YAML 文件，向 `main` 发起 Pull Request。CI 会检查条目数量、`dsh.bundle`、仓库年龄、格式与站点构建；通过后由维护者审阅代码与描述。

## 三、发布 npm 包（可选）

不发布 npm 包也可以被收录。发布后市场会显示下载量，并优先提供预构建安装。

```bash
npm login
npm publish --access public
```

要求：

- `package.json` 的 `repository` 字段必须指回被收录的仓库地址。
- 市场会从 registry 自动关联，不需要在清单条目里写 npm 字段。
- 官方 `@deepseek-ai/*` 包应声明为 `peerDependencies`，不要放进 `dependencies`。

## 四、截图（可选）

在 `package.json` 同级放 `screenshots.json`，列出 1 到 8 张仓库内图片的相对路径：

```json
[
  "assets/screenshot-1.png"
]
```

也接受 GitHub 托管的 https 图片地址，第三方图床会被拒绝。

## 五、发布前自检

- [ ] `package.json` 有 `dsh.bundle`，仓库根有 `cordis.patch.yml`
- [ ] 仓库已添加 `dsh-plugin` topic，且创建满 1 天
- [ ] `README.md` 的安装、配置、功能描述与实际一致
- [ ] `config.json` 不进入仓库，`config.example.json` 字段完整
- [ ] 功能清单逐项核验通过
- [ ] 清单条目的描述与代码实际能力一致

## 六、更新版本

修改代码后更新 `package.json` 的 `version`。市场展示的版本来自仓库 `package.json`；如果同时发布了 npm 包，重新执行 `npm publish`。清单条目不需要跟着改，除非插件名称、分类或描述发生变化。
