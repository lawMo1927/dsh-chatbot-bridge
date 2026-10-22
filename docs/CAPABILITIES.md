# DSH-AstrBot 协作能力接口约定

本文件是「DSH-AstrBot 协作能力缺口」改造的接口约定，供桥接服务与 AstrBot 适配器并行实现。能力清单见仓库根目录外的 `TODO.md`。

## 目标能力

1. 读取会话列表与状态。
2. 读取会话双方历史消息。
3. 订阅 DSH 消息与状态更新。
4. 向任意状态的目标发送提示词。
5. 审批传达。
6. 精确指定目标，并查询会话与任务关系。

## 桥接 HTTP 接口

以下接口在现有桥接服务上增加，统一返回 JSON。错误使用 `{ error: string }` 与 4xx/5xx。

### GET /sessions

返回所有可见会话，按最近活动排序：

```json
{
  "sessions": [
    {
      "sessionId": "session-...",
      "title": "QQ 桥接会话",
      "cwd": "D:\\...",
      "running": false,
      "blank": false,
      "archived": false,
      "pinned": false,
      "updatedAt": 1792586133807,
      "currentTaskId": "task_...",
      "taskIds": ["task_..."],
      "waitingApproval": false
    }
  ]
}
```

### GET /sessions/:sessionId/history?limit=20&beforeSeq=

返回指定会话的消息历史，最近的消息在前或在后必须固定一种顺序，并在字段中说明。

```json
{
  "sessionId": "session-...",
  "cursor": 42,
  "hasMore": true,
  "messages": [
    {
      "seq": 40,
      "time": 1792586133807,
      "role": "user",
      "source": "bot",
      "kind": "prompt",
      "text": "把 report.md 的前一百字读出来"
    },
    {
      "seq": 41,
      "time": 1792586134900,
      "role": "assistant",
      "source": "dsh",
      "kind": "text",
      "text": "找到文件..."
    }
  ]
}
```

- `role`：`user`、`assistant`、`system`。
- `source`：`bot`、`human`、`dsh`、`system`。
- `kind`：`prompt`、`text`、`tool`、`approval`、`status`。
- 读取方式：使用 `ctx.sessionController.follow` 的首个 snapshot 取得 `cursor` 与最近记录；更早内容用 `ctx.sessionController.page({ address, throughSeq: cursor, beforeSeq, maxMessages })` 继续读取。类型定义位于 `C:\Users\13826\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-api-session-controller\lib\types\types.d.ts`。

### GET /tasks?sessionId=&status=&limit=50

```json
{
  "tasks": [
    {
      "taskId": "task_...",
      "sessionId": "session-...",
      "status": "completed",
      "prompt": "原始提示词",
      "createdAt": "2026-10-22T...",
      "startedAt": "2026-10-22T...",
      "finishedAt": "2026-10-22T...",
      "durationMs": 12345,
      "error": null
    }
  ]
}
```

### GET /tasks/:taskId

返回单个任务详情，必须包含 `sessionId`，并附带该会话的标题与状态。

### POST /prompt

统一入口，按目标状态自动选择提交方式：

```json
{
  "target": { "sessionId": "session-...", "taskId": "task_..." },
  "prompt": "补充或新的提示词",
  "mode": "auto"
}
```

- `mode`：`auto`、`queue`、`steer`。
- `auto`：目标会话运行中则按 `steer` 追加，空闲或已结束则按 `queue` 开始新回合。
- 返回 `{ taskId, sessionId, accepted: true }`。
- 未传 `sessionId` 时使用桥接会话；传了 `taskId` 时通过任务映射找到会话。

### POST /tasks/:taskId/cancel

精确中断指定任务所在会话的当前回合，返回 `{ ok: true, taskId }`。任务不存在或不属于任何会话时返回 404。

### POST /tasks/:taskId/continue

以指定任务为上下文提交继续提示词，返回 `{ taskId: 新任务编号, sessionId }`。

### GET /approvals/pending

在现有字段基础上补充 `sessionId`、`taskId`、`command` 与 `createdAt`，供机器人查询审批详情。

### GET /events?sessionId=&sinceSeq=

返回增量事件，供适配器轮询：

```json
{
  "sessionId": "session-...",
  "cursor": 45,
  "events": [
    { "seq": 44, "type": "assistant/message", "time": 1792586134900, "data": { "text": "..." } },
    { "seq": 45, "type": "turn/end", "time": 1792586135000, "data": { "reason": "completed" } }
  ]
}
```

事件来源包括会话 follow 流、任务状态变化、报告与审批。桥接内部保留最近 500 条事件。

## AstrBot 适配器工具

合并为 5 个模型工具，替换原有 9 个：

1. `dsh_session`：`action` 为 `list`、`status`、`history`、`prompt`；参数包含 `session_id`、`limit`、`before_seq`、`prompt`、`mode`。
2. `dsh_task`：`action` 为 `run`、`list`、`status`、`progress`、`cancel`、`continue`；参数包含 `task_id`、`session_id`、`prompt`、`status`、`limit`。
3. `dsh_approval`：`action` 为 `list`。
4. `dsh_file`：`action` 为 `send`、`read`；参数包含 `file_name`、`start`、`max_chars`。
5. `read_own_sent_messages`：保留现有实现。

工具描述必须说明：读取 DSH 文件走 `dsh_file`，所有任务与会话操作必须精确指定目标，无法唯一确定时先查询。旧工具名不再注册，避免模型在多个相似工具之间选择。

## 并行分工

- 桥接服务：`index.js`、`tasks.js`。
- 适配器：`adapters/astrbot/main.py`。
- 验证与文档：由团队另行安排。

两边都不得修改对方的文件，不得提交 git，不得重启 DSH。完成后运行语法检查，并把改动摘要报告给负责人。
