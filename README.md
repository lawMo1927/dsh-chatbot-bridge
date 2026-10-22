# dsh-chatbot-bridge

DSH 插件：一站式聊天机器人桥接器。装在 DSH 里，侧边栏多一个「聊天机器人」入口，安装向导负责检测组件、生成配置、启动进程和扫码登录；AstrBot 的登录、模型供应商、人格和平台连接在 AstrBot 自己的网页中完成。机器人派发任务给 DSH 执行，结果与产物文件自动回传聊天。

## 功能

- **安装向导**：环境检测、自动生成配置、路径检测、一键安装适配器并启动组件
- **进程管理**：AstrBot 启停重启、NapCat 启动、QQ 登录状态与二维码、桥接状态
- **AstrBot 网页入口**：面板各处提供一键打开 AstrBot 网页的按钮，登录、模型、人格和平台连接都在 AstrBot 网页中完成
- **任务桥接**：聊天消息派发给 DSH 执行，结果原文回传，产物文件自动发送
- **进度插话**：任务执行中追问进度，直接插入任务上下文
- **中断与继续**：随时中断任务，之后继续
- **审批双通道**：DSH 的越权审批可以同时在聊天和 DSH 页面应答，任一渠道先到先得
- **会话可见**：机器人会话出现在 DSH 会话列表里，可查看、可干预
- **工作区归属**：机器人会话按 cwd 归入已登记的 DSH 工作区
- **环境检测与安装**：uv、AstrBot、NapCat 可检测并安装；QQ 客户端只做检测，需要手动安装

## 模型工具与协作能力

聊天机器人通过 5 个模型工具操作 DSH：

| 工具 | 用途 |
|---|---|
| `dsh_session` | 查询会话列表、会话状态、双方历史消息，向指定会话发送提示词，支持 auto、queue、steer 三种模式 |
| `dsh_task` | 提交任务、列出任务、查看状态与进度、按任务编号中断或继续 |
| `dsh_approval` | 查询待审批项与最近已结束的审批 |
| `dsh_file` | 读取或发送 DSH 工作区内的文件 |
| `read_chat_messages` | 读取当前聊天（私聊/群聊）历史与机器人最近发送的消息、文件记录；默认同时返回两部分 |

任务执行过程中追加的指令会绑定到当前回合；适配器会实时把 DSH 对追加指令的回复推送到聊天，最终报告与文件随后回传。

审批支持双通道应答。待审批项推送会带审批编号、工具、命令、原因、会话、任务与等待时间；同时有多项时，管理员可以回复「允许 审批编号」或「拒绝 审批编号」精确处理某一项。

## 环境要求

- Windows 10 或 Windows 11。进程管理、安装、二维码链路依赖 PowerShell 与 Windows 进程接口。
- 已安装 DSH。
- AstrBot 4.x、NapCat、QQ 客户端。
- 一个管理员 QQ 号，以及可用的模型供应商与 API Key。
- 首次安装 uv、AstrBot、NapCat 或生成二维码时需要网络。

插件不会自动安装 QQ 客户端，也不会替用户创建 AstrBot WebUI 账号或配置 NapCat 的 OneBot 连接。

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

首次启动 DSH 时，如果插件目录和 DSH 数据目录都没有 `config.json`，插件会在 DSH 数据目录（默认 `C:\Users\<名字>\.dsh\chatbot-bridge\config.json`）生成一份默认配置，并创建默认工作区、日志目录与安装目录。插件目录里的 `config.json` 优先使用，方便本地目录安装；从 npm 或市场安装时使用 DSH 数据目录里的配置。

默认工作区是用户主目录下的 `dsh-chatbot-workspace`；AstrBot 与 NapCat 路径默认为空，需要用户在面板「安装」页填写，或使用环境检测得到的路径。

也可以复制 `config.example.json` 到上述任一位置后手动修改。`config.json` 不随包安装，面板的「进程」页和「安装」页会回写其中的常用字段。

| 字段 | 说明 |
|---|---|
| `port` | 桥接服务端口，默认 9412，聊天插件通过它调用桥接 |
| `workspace` | 机器人执行任务的工作目录，也是会话的 cwd |
| `dshHome` | DSH 数据目录，默认 `C:\Users\<名字>\.dsh` |
| `adminQQ` | 管理员 QQ 号，机器人只响应这个号码发起的任务；默认留空，在面板「进程」页填写 |
| `astrbot` | AstrBot 的安装目录、启动 exe、WebUI 地址；账号登录在 AstrBot 网页中完成 |
| `napcat` | NapCat 的 WebUI 地址、token、安装目录与启动脚本 |
| `qqPath` | QQ 客户端路径，用于检测是否已安装 |

`adminQQ` 可以在面板的「进程」页顶部或「向导」页填写，不需要手动改文件。

二维码图片由插件的 Node 依赖 `qrcode` 生成，不需要 Python 脚本；通过 npm 或 pnpm 安装插件时会自动安装该依赖。

## 首次配置

装好插件并重启 DSH 后按下面的顺序配置：

1. 打开「聊天机器人」面板。首次启动会自动生成 `config.json`。
2. 在「向导」页填写管理员 QQ 与工作区路径。
3. 在「向导」页填写 AstrBot 目录、启动程序、AstrBot 网页地址、NapCat 目录、启动脚本和 token，或点「自动检测路径」后保存。
4. 在「向导」页安装缺失的 uv、AstrBot、NapCat；QQ 客户端需要手动安装。
5. 点「保存并自动配置」：插件会安装适配器、启动 AstrBot 与 NapCat，并打开 AstrBot 网页。
6. 在打开的 AstrBot 网页中完成登录、模型供应商与 API Key、人格和平台连接配置。插件不收集也不保存 AstrBot 账号密码。
7. 回到「向导」或「进程」页获取二维码，扫码登录 QQ。

管理员保存和 AstrBot 适配器安装都需要重启聊天机器人生效。

## 默认人格

插件带一份通用人格模板（`templates/persona-default.md`），是一个简洁的私人助手设定，不含任何个人化内容。AstrBot 全新安装时自带的是它自己的通用人格，与本模板无关；需要时把模板内容粘贴到 AstrBot 网页的人格编辑器中保存。

## 面板

侧边栏「聊天机器人」入口包含五个分页：

| 分页 | 内容 |
|---|---|
| 向导 | 首次使用流程、路径检测、组件安装、一键配置、打开 AstrBot 网页、QQ 二维码 |
| 进程 | 聊天机器人启停重启、NapCat 启动、QQ 登录状态与二维码、桥接状态、打开 AstrBot 网页 |
| 安装 | 环境检测、缺失组件的安装按钮、适配器安装、高级设置、最近安装输出 |
| AstrBot | 打开 AstrBot 网页、启动或重启 AstrBot；登录、模型、人格和平台连接在 AstrBot 网页中完成 |
| 日志 | 最近 200 行运行日志 |

## 审批

DSH 的越权操作（工作区外读写、提权命令）会经过审批。本插件把审批请求同时推给聊天和 DSH 页面：

- DSH 页面开着：页面弹窗与聊天通知同时出现，任一渠道应答都有效
- DSH 页面没开：审批直接落到聊天，管理员回复允许或拒绝

若希望聊天优先、页面弹窗不再出现，可以应用 `docs/PATCHES.md` 里的可选补丁。

## 聊天机器人接入

插件把任务桥接入口暴露为 HTTP 服务（默认 9412），聊天机器人侧需要一个适配器调用它。目前提供 AstrBot 适配器：

- 适配器代码在仓库 `adapters/astrbot`，面板「安装」页可以一键复制到 AstrBot 插件目录
- 当前接口包括：`POST /task`、`GET /tasks`、`GET /tasks/:id`、`POST /tasks/:id/cancel`、`POST /tasks/:id/continue`、`POST /prompt`、`GET /sessions`、`GET /sessions/:id/history`、`GET /reports`、`POST /reports/ack`、`GET /approvals`、`POST /approval/answer`、`GET /events`、`GET /events/stream`；旧接口 `/task/cancel`、`/task/continue`、`/task/:id`、`/progress`、`/sessions/operate` 继续保留

## 工作区归属

插件创建或恢复会话后，会按 cwd 查找 DSH 已登记的工作区并归入。用户需要先在 DSH 里登记与 `config.workspace` 相同路径的工作区；没有登记时会话仍可创建，但不会归入工作区。历史会话可用 `POST /admin/sessions/attach` 补登记。

## 常见问题

**QQ 二维码获取失败**：先确认 NapCat 在运行（6099 端口），且 `config.json` 里的 token 正确。二维码图片由 Node 依赖生成；如果依赖没有安装，先重新执行 `pnpm install`。

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
