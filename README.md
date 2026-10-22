# dsh-chatbot-bridge

DSH 插件：一站式聊天机器人桥接器。装在 DSH 里，侧边栏多一个「聊天机器人」入口，从启动进程、配置模型、编辑人格到扫码登录，全部在面板里完成。机器人派发任务给 DSH 执行，结果与产物文件自动回传聊天。

## 功能

- **一站式面板**：进程管理、安装向导、人格编辑、模型与 API 配置、运行日志
- **任务桥接**：聊天消息派发给 DSH 执行，结果原文回传，产物文件自动发送
- **进度插话**：任务执行中追问进度，直接插入任务上下文
- **中断与继续**：随时中断任务，之后继续
- **审批双通道**：DSH 的越权审批可以同时在聊天和 DSH 页面应答，任一渠道先到先得
- **会话可见**：机器人会话出现在 DSH 会话列表里，可查看、可干预
- **工作区归属**：机器人会话自动归入对应工作区，不落到「未分组」
- **环境检测与安装**：uv、AstrBot、NapCat、QQ 的检测，缺失组件可一键安装

## 模型工具与协作能力

聊天机器人通过 5 个模型工具操作 DSH：

| 工具 | 用途 |
|---|---|
| `dsh_session` | 查询会话列表、会话状态、双方历史消息，向指定会话发送提示词，支持 auto、queue、steer 三种模式 |
| `dsh_task` | 提交任务、列出任务、查看状态与进度、按任务编号中断或继续 |
| `dsh_approval` | 查询待审批项与最近已结束的审批 |
| `dsh_file` | 读取或发送 DSH 工作区内的文件 |
| `read_own_sent_messages` | 读取机器人最近发送的消息与文件记录 |

任务执行过程中追加的指令会绑定到当前回合；适配器会实时把 DSH 对追加指令的回复推送到聊天，最终报告与文件随后回传。

审批支持双通道应答。待审批项推送会带审批编号、工具、命令、原因、会话、任务与等待时间；同时有多项时，管理员可以回复「允许 审批编号」或「拒绝 审批编号」精确处理某一项。

## 安装

### 方式一：从 npm 安装

在 DSH profile 目录执行：

```bash
pnpm add dsh-chatbot-bridge
```

然后在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: chatbot-bridge
      name: dsh-chatbot-bridge
```

市场或 `dsh plugin add` 安装会读取仓库根的 `cordis.patch.yml` 自动挂载，不需要手工加这一段。重启 DSH，侧边栏出现「聊天机器人」入口。

### 方式二：本地目录安装

把本仓库放到 DSH profile 的 `node_modules` 下，或写成 `file:` 依赖：

```json
{
  "dependencies": {
    "dsh-chatbot-bridge": "file:D:/path/to/dsh-chatbot-bridge"
  }
}
```

再执行 `pnpm install` 并添加上面的 patch 行。

## 配置

复制 `config.example.json` 为 `config.json`，按注释修改路径与凭据。`config.json` 不进版本库，安装包也不带；从 npm 或市场安装时，配置文件要放在插件安装目录（DSH profile 的 `node_modules/dsh-chatbot-bridge`）下，首次启动 DSH 之前创建好。

| 字段 | 说明 |
|---|---|
| `port` | 桥接服务端口，默认 9412，聊天插件通过它调用桥接 |
| `workspace` | 机器人执行任务的工作目录，也是会话的 cwd |
| `dshHome` | DSH 数据目录，默认 `C:\Users\<名字>\.dsh` |
| `adminQQ` | 管理员 QQ 号，机器人只响应这个号码发起的任务 |
| `astrbot` | AstrBot 的安装目录、启动 exe、WebUI 地址与登录凭据 |
| `napcat` | NapCat 的 WebUI 地址、token、安装目录与启动脚本 |
| `pythonExe` `qrScript` | 二维码图片生成所需的 Python 与脚本 |
| `qqPath` | QQ 客户端路径，用于检测是否已安装 |

`adminQQ` 可以在面板的「进程」页顶部直接填写保存，不需要手动改文件。

## 首次配置

装好插件后按下面的顺序配置：

1. 「进程」页顶部填管理员 QQ，保存
2. 「模型与 API」页配置供应商的 API 地址与 Key，选择当前模型
3. 「人格」页编辑人格，可以点「载入默认模板」从通用模板开始改
4. 「安装」页确认环境组件齐全，点「安装」把桥接插件装进 AstrBot
5. 「进程」页启动聊天机器人与 NapCat，扫码登录 QQ

管理员保存和 AstrBot 插件安装都需要重启聊天机器人生效。

## 默认人格

插件带一份通用人格模板（`templates/persona-default.md`），是一个简洁的私人助手设定，不含任何个人化内容。人格页的「载入默认模板」按钮会把它填进编辑框，保存后生效。AstrBot 全新安装时自带的是它自己的通用人格，与本模板无关。

## 面板

侧边栏「聊天机器人」入口包含五个分页：

| 分页 | 内容 |
|---|---|
| 进程 | 聊天机器人启停重启、NapCat 启动、QQ 登录状态与二维码、桥接状态 |
| 安装 | 环境检测、缺失组件的安装按钮、最近安装输出 |
| 人格 | 人格列表、系统提示词全文编辑与保存 |
| 模型与 API | 当前模型选择（按供应商分组）、降级列表、供应商配置与添加 |
| 日志 | 最近 200 行运行日志 |

## 审批

DSH 的越权操作（工作区外读写、提权命令）会经过审批。本插件把审批请求同时推给聊天和 DSH 页面：

- DSH 页面开着：页面弹窗与聊天通知同时出现，任一渠道应答都有效
- DSH 页面没开：审批直接落到聊天，管理员回复允许或拒绝

若希望聊天优先、页面弹窗不再出现，可以应用 `docs/PATCHES.md` 里的可选补丁。

## 聊天机器人接入

插件把任务桥接入口暴露为 HTTP 服务（默认 9412），聊天机器人侧需要一个适配器调用它。目前提供 AstrBot 适配器：

- 适配器代码在仓库 `adapters/astrbot`，面板「安装」页可以一键复制到 AstrBot 插件目录
- 接口约定：`POST /task` 提交，`GET /reports` 拉取结果，`POST /approval/answer` 应答审批，`POST /progress` 询问进度，`GET /sessions` 列会话

## 工作区归属

插件创建或恢复会话后，自动把会话归入 cwd 匹配的工作区。历史会话可用 `POST /admin/sessions/attach` 补登记。

## 常见问题

**QQ 二维码获取失败**：先确认 NapCat 在运行（6099 端口），且 `config.json` 里的 token 正确。

**审批没有出现在聊天里**：检查 DSH 页面是否打开着且正在等待页面应答；或应用可选补丁。

**AstrBot 启动后自动退出**：早期版本存在此问题，已改为独立进程并写日志到 `astrbotLogFile`。

## 开发

```bash
# 语法检查
node --check index.js
node --check client.js

# 安装到本机 DSH 调试
# 把仓库目录复制到 profile 的 node_modules，重启 DSH 查看插件日志
```

## 许可

MIT
