import asyncio
import datetime
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from astrbot.api import logger, star
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import File, Plain
from astrbot.api.provider import ProviderRequest
from astrbot.core.message.message_event_result import MessageChain, MessageEventResult, ResultContentType
from astrbot.core.platform.message_type import MessageType

BRIDGE_URL = "http://127.0.0.1:9412"
CHUNK_LIMIT = 1500
MAX_FILE_BYTES = 50 * 1024 * 1024
SENT_HISTORY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sent_history.json")
SENT_HISTORY_LIMIT = 30
SENT_TEXT_LIMIT = 6000
SENT_FILE_READ_LIMIT = 64 * 1024
APPROVAL_ALLOW_WORDS = {"允许", "同意", "allow", "yes", "ok", "可以", "好"}
APPROVAL_DENY_WORDS = {"拒绝", "不同意", "deny", "no", "不行", "不要"}
APPROVAL_OUTCOME_LABELS = {
    "allow": "已允许",
    "allowed": "已允许",
    "allowed-once": "已允许（一次）",
    "deny": "已拒绝",
    "denied": "已拒绝",
    "reject": "已拒绝",
    "rejected": "已拒绝",
    "cancelled": "已取消",
    "unavailable": "审批通道不可用",
    "timeout": "超时自动拒绝",
}
PROMPT_MODES = ("auto", "queue", "steer")
STEER_PUSH_PREFIX = "DSH 对追加指令的回复："
STEER_TASK_TTL_SECONDS = 1800
EVENT_POLL_INTERVAL_SECONDS = 2
APPROVAL_ID_PATTERN = re.compile(r"approval[_-][\w.-]+")
APPROVAL_ALLOW_PATTERN = re.compile(
    r"^(?P<word>"
    + "|".join(re.escape(word) for word in sorted(APPROVAL_ALLOW_WORDS, key=len, reverse=True))
    + r")(?P<rest>.*)$",
    re.IGNORECASE,
)
APPROVAL_DENY_PATTERN = re.compile(
    r"^(?P<word>"
    + "|".join(re.escape(word) for word in sorted(APPROVAL_DENY_WORDS, key=len, reverse=True))
    + r")(?P<rest>.*)$",
    re.IGNORECASE,
)


class BridgeError(RuntimeError):
    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class Main(star.Star):
    def __init__(self, context: star.Context) -> None:
        self.context = context
        self._poll_task = None
        self._pending_approval_id = None
        self._pending_approvals = []
        self._admin_qq = ""
        self._workspace = ""
        self._sent_history = []
        self._sent_history_lock = asyncio.Lock()
        self._event_cursor = 0
        self._event_poll_count = 0
        self._steer_tasks = {}

    async def _load_settings(self) -> None:
        try:
            data = await self._bridge("GET", "/admin/settings")
            self._admin_qq = str(data.get("adminQQ") or "").strip()
            self._workspace = str(data.get("workspace") or "").strip()
            if self._admin_qq:
                logger.info(f"dsh_bridge 已加载设置：管理员 {self._admin_qq}，工作区 {self._workspace}")
            else:
                logger.warning("dsh_bridge 尚未配置管理员 QQ，请在 DSH 的聊天机器人面板设置")
        except Exception as error:
            logger.warning(f"dsh_bridge 读取桥接设置失败：{error}")

    def _bridge_sync(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = None
        headers = {"Content-Type": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        def send() -> dict:
            request = urllib.request.Request(BRIDGE_URL + path, data=data, headers=headers, method=method)
            return self._send_request(request)

        try:
            return send()
        except (ConnectionResetError, ConnectionAbortedError) as error:
            if method != "GET":
                raise BridgeError(
                    f"与桥接服务的连接被中断，可能该接口尚未实现或桥接服务正在重启：{error}"
                ) from error
            try:
                return send()
            except (ConnectionResetError, ConnectionAbortedError) as retry_error:
                raise BridgeError(
                    f"与桥接服务的连接被中断，可能该接口尚未实现或桥接服务正在重启：{retry_error}"
                ) from retry_error

    @staticmethod
    def _send_request(request: urllib.request.Request) -> dict:
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                body = error.read().decode("utf-8")
                parsed = json.loads(body)
                message = parsed.get("error") or parsed.get("reason") or body
            except Exception:
                message = str(error)
            raise BridgeError(str(message), error.code) from error
        except urllib.error.URLError as error:
            raise BridgeError(f"无法连接桥接服务 {BRIDGE_URL}：{error.reason}") from error

    async def _bridge(self, method: str, path: str, payload: dict | None = None) -> dict:
        return await asyncio.to_thread(self._bridge_sync, method, path, payload)

    def _allowed(self, event: AstrMessageEvent) -> bool:
        if not self._admin_qq:
            return False
        message_type = event.get_message_type()
        if message_type not in (MessageType.FRIEND_MESSAGE, MessageType.GROUP_MESSAGE):
            return False
        return str(event.get_sender_id()) == self._admin_qq

    def _report_umo(self, event: AstrMessageEvent) -> str:
        umo = event.unified_msg_origin
        if event.get_message_type() == MessageType.GROUP_MESSAGE:
            platform_name = umo.split(":", 1)[0]
            return f"{platform_name}:FriendMessage:{self._admin_qq}"
        return umo

    @filter.llm_tool(name="dsh_session")
    async def dsh_session(
        self,
        event: AstrMessageEvent,
        action: str,
        session_id: str = "",
        limit: int = 20,
        before_seq: int = 0,
        prompt: str = "",
        mode: str = "auto",
    ) -> str:
        """查询 DSH 会话列表、会话状态或双方历史消息，也可以向指定会话发送提示词。
        action 取值：
        - list：列出所有会话的运行状态、当前任务、是否等待审批。
        - status：查看指定会话的详细状态，需要 session_id。
        - history：读取指定会话的历史消息，需要 session_id，可用 before_seq 向前翻页。
        - prompt：向指定会话发送提示词；不传 session_id 时发给机器人自己的桥接会话。
        不确定会话编号时先用 list 查询，不要猜测。

        Args:
            action(string): list、status、history、prompt 之一。
            session_id(string): 会话编号，来自 list 的结果；prompt 动作可以留空表示桥接会话。
            limit(int): list 与 history 最多返回多少条，默认 20，最大 100。
            before_seq(int): history 向前翻页的起始序号，取上一次结果里的提示，默认 0 表示从最新读起。
            prompt(string): action 为 prompt 时要发送的提示词。
            mode(string): action 为 prompt 时的提交方式，auto（默认）、queue 或 steer。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        action = (action or "").strip().lower()
        session_id = (session_id or "").strip()
        if action == "list":
            return await self._session_list(limit)
        if action == "status":
            return await self._session_status(session_id)
        if action == "history":
            return await self._session_history(session_id, limit, before_seq)
        if action == "prompt":
            if not (prompt or "").strip():
                return "action 为 prompt 时需要提供 prompt。"
            if mode not in PROMPT_MODES:
                return "mode 只能是 auto、queue 或 steer。"
            return await self._submit_prompt(event, session_id, prompt, mode)
        return "action 只能是 list、status、history、prompt。"

    async def _session_list(self, limit: int) -> str:
        try:
            data = await self._bridge("GET", "/sessions")
        except Exception as error:
            logger.error(f"dsh_bridge 获取会话列表失败: {error}")
            return self._bridge_error_text("读取会话列表（GET /sessions）", error)
        sessions = data.get("sessions") or []
        if not sessions:
            return "当前没有任何 DSH 会话。"
        limit = max(1, min(int(limit or 20), 100))
        shown = sessions[:limit]
        lines = [f"共 {len(sessions)} 个会话（按最近活动排序，显示前 {len(shown)} 个）："]
        lines.extend(self._format_session_line(item) for item in shown)
        if len(sessions) > len(shown):
            lines.append(f"还有 {len(sessions) - len(shown)} 个会话未显示，可以调大 limit。")
        return "\n".join(lines)

    @staticmethod
    def _session_flags(item: dict) -> str:
        tags = []
        if item.get("running"):
            tags.append("运行中")
        if item.get("waitingApproval"):
            tags.append("等待审批")
        if item.get("archived"):
            tags.append("已归档")
        if item.get("pinned"):
            tags.append("置顶")
        if item.get("blank"):
            tags.append("空白")
        return "、".join(tags) if tags else "空闲"

    def _format_session_line(self, item: dict) -> str:
        line = (
            f"- {item.get('sessionId') or '（缺少编号）'}"
            f"｜{self._session_flags(item)}"
            f"｜{item.get('title') or '（无标题）'}"
        )
        cwd = item.get("cwd")
        if cwd:
            line += f"｜{cwd}"
        current_task_id = item.get("currentTaskId")
        if current_task_id:
            line += f"｜当前任务 {current_task_id}"
        task_ids = item.get("taskIds") or []
        if task_ids:
            line += f"｜任务 {len(task_ids)} 个"
        updated_at = item.get("updatedAt")
        if updated_at:
            line += f"｜最近活动 {self._format_time(updated_at)}"
        return line

    async def _session_status(self, session_id: str) -> str:
        if not session_id:
            return "查看会话状态需要 session_id；请先用 dsh_session 的 list 动作查询会话编号。"
        try:
            data = await self._bridge("GET", "/sessions")
        except Exception as error:
            logger.error(f"dsh_bridge 获取会话列表失败: {error}")
            return self._bridge_error_text("读取会话列表（GET /sessions）", error)
        sessions = data.get("sessions") or []
        item = next(
            (candidate for candidate in sessions if str(candidate.get("sessionId") or "") == session_id),
            None,
        )
        if item is None:
            return f"没有找到会话 {session_id}；请先用 dsh_session 的 list 动作查询会话编号。"
        lines = [
            f"会话 {session_id}：",
            f"标题：{item.get('title') or '（无标题）'}",
            f"状态：{self._session_flags(item)}",
            f"工作目录：{item.get('cwd') or '（未知）'}",
            f"当前任务：{item.get('currentTaskId') or '无'}",
        ]
        updated_at = item.get("updatedAt")
        if updated_at:
            lines.append(f"最近活动：{self._format_time(updated_at)}")
        tasks, task_error = await self._fetch_tasks(session_id, "", 10)
        if task_error:
            lines.append(task_error)
        elif tasks:
            lines.append("该会话最近的任务：")
            lines.extend(self._format_task_line(task) for task in tasks)
        else:
            lines.append("该会话还没有任务记录。")
        return "\n".join(lines)

    async def _session_history(self, session_id: str, limit: int, before_seq: int) -> str:
        if not session_id:
            return "读取历史需要 session_id；请先用 dsh_session 的 list 动作查询会话编号。"
        query = {"limit": str(max(1, min(int(limit or 20), 100)))}
        if int(before_seq or 0) > 0:
            query["beforeSeq"] = str(int(before_seq))
        path = (
            f"/sessions/{urllib.parse.quote(session_id, safe='')}/history"
            f"?{urllib.parse.urlencode(query)}"
        )
        try:
            data = await self._bridge("GET", path)
        except Exception as error:
            logger.error(f"dsh_bridge 读取会话历史失败: {error}")
            return self._bridge_error_text("读取会话历史（GET /sessions/:id/history）", error)
        messages = data.get("messages") or []
        if not messages:
            return f"会话 {session_id} 没有可读取的历史消息。"
        ordered = sorted(messages, key=self._message_seq)
        lines = [f"会话 {session_id} 的历史消息（本次返回 {len(ordered)} 条）："]
        for item in ordered:
            text = str(item.get("text") or "").strip()
            if len(text) > 600:
                text = text[:600] + "……"
            lines.append(
                f"[{self._format_time(item.get('time'))}] #{item.get('seq')}"
                f" {item.get('role') or '?'}/{item.get('source') or '?'}/{item.get('kind') or '?'}：{text}"
            )
        if data.get("hasMore"):
            oldest_seq = ordered[0].get("seq")
            lines.append(f"还有更早的消息；把 before_seq 设为 {oldest_seq} 可以继续向前翻页。")
        else:
            lines.append("已经读到最早的消息。")
        text = "\n".join(lines)
        if len(text) > 12000:
            text = text[:12000] + "\n……（输出过长已截断）"
        return text

    @staticmethod
    def _message_seq(item: dict):
        seq = item.get("seq")
        return seq if isinstance(seq, (int, float)) else 0

    async def _submit_prompt(
        self,
        event: AstrMessageEvent,
        session_id: str,
        prompt: str,
        mode: str,
    ) -> str:
        payload = {
            "target": {"sessionId": session_id} if session_id else {},
            "prompt": prompt.strip(),
            "mode": mode,
            "umo": self._report_umo(event),
            "fileUmo": event.unified_msg_origin if event.get_message_type() == MessageType.GROUP_MESSAGE else "",
        }
        try:
            result = await self._bridge("POST", "/prompt", payload)
        except Exception as error:
            logger.error(f"dsh_bridge 提交提示词失败: {error}")
            return self._bridge_error_text("提交提示词（POST /prompt）", error)
        if result.get("accepted") is False:
            return f"DSH 没有接受这次提交：{result.get('error') or '桥接未给出原因'}"
        task_id = result.get("taskId")
        if not task_id:
            return f"桥接服务返回的内容缺少任务编号，无法确认提交结果：{result}"
        target_session = result.get("sessionId") or session_id or "桥接会话"
        mode_used = result.get("mode") or mode
        if mode_used == "steer":
            self._steer_tasks.setdefault(
                str(task_id),
                {
                    "umo": event.unified_msg_origin,
                    "pushed": False,
                    "text": "",
                    "createdAt": datetime.datetime.now().timestamp(),
                },
            )
        # 回执由适配器生成，包含完整提示词，作为单条消息直接展示
        if mode_used == "steer":
            receipt = (
                f"已向正在执行的任务追加指令（任务编号 {task_id}，会话 {target_session}），"
                f"追加的提示词是：\n\n{prompt.strip()}"
            )
        else:
            receipt = (
                f"已交给 DSH（任务编号 {task_id}，会话 {target_session}），"
                f"我发出的提示词是：\n\n{prompt.strip()}"
            )
        event.set_extra("dsh_receipt_text", receipt)
        event.set_extra("dsh_single_message", True)
        if mode_used == "steer":
            return (
                f"已向正在执行的任务追加指令（任务编号 {task_id}，会话 {target_session}）。"
                "回执已由插件生成并发送，你不需要再重复提示词。"
                "现在请立即向用户输出一句极短的确认，回执发完后停下，不要调用其他工具。"
            )
        return (
            f"已把提示词提交给 DSH（任务编号 {task_id}，会话 {target_session}）。"
            "回执已由插件生成并发送，你不需要再重复提示词。"
            "现在请立即向用户输出一句极短的确认，回执发完后停下，不要调用其他工具。"
        )

    @filter.llm_tool(name="dsh_task")
    async def dsh_task(
        self,
        event: AstrMessageEvent,
        action: str,
        task_id: str = "",
        session_id: str = "",
        prompt: str = "",
        status: str = "",
        limit: int = 20,
    ) -> str:
        """查询或操作 DSH 任务。
        action 取值：
        - run：把任务交给 DSH 执行，需要 prompt；可用 session_id 指定目标会话，不传时用机器人自己的桥接会话。
        目标会话正在执行时，这次提示词会作为追加指令处理；需要明确指定提交方式时用 dsh_session 的 prompt 动作。
        - list：列出任务，可用 session_id、status、limit 过滤。
        - status：查看指定任务的详情，需要 task_id。
        - progress：查看指定任务当前阶段与最近事件，需要 task_id。
        - cancel：中断指定任务，需要 task_id。
        - continue：以指定任务为上下文继续，需要 task_id，prompt 为补充说明。
        涉及具体任务时必须用 task_id 精确指定；不知道编号时先用 list 查询，不要猜测。
        任务结果和产物文件由桥接层自动发送给用户。

        Args:
            action(string): run、list、status、progress、cancel、continue 之一。
            task_id(string): 任务编号，例如 task_1792586133760_731。
            session_id(string): 会话编号，用于 run 指定目标会话，或用于 list 按会话过滤。
            prompt(string): run 的任务描述，或 continue 的补充说明；run 时必须提供。
            status(string): list 过滤的任务状态，例如 running、completed、failed、cancelled。
            limit(int): list 最多返回多少条任务，默认 20，最大 100。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        action = (action or "").strip().lower()
        task_id = (task_id or "").strip()
        session_id = (session_id or "").strip()
        if action == "run":
            if not (prompt or "").strip():
                return "action 为 run 时需要提供 prompt。"
            return await self._submit_prompt(event, session_id, prompt, "auto")
        if action == "list":
            return await self._task_list(session_id, (status or "").strip(), limit)
        if action == "status":
            return await self._task_status(task_id)
        if action == "progress":
            return await self._task_progress(task_id)
        if action == "cancel":
            return await self._task_cancel(task_id)
        if action == "continue":
            return await self._task_continue(event, task_id, prompt)
        return "action 只能是 run、list、status、progress、cancel、continue。"

    async def _fetch_tasks(self, session_id: str, status: str, limit: int):
        query = {"limit": str(max(1, min(int(limit or 20), 100)))}
        if session_id:
            query["sessionId"] = session_id
        if status:
            query["status"] = status
        path = "/tasks?" + urllib.parse.urlencode(query)
        try:
            data = await self._bridge("GET", path)
        except Exception as error:
            logger.error(f"dsh_bridge 获取任务列表失败: {error}")
            return None, self._bridge_error_text("读取任务列表（GET /tasks）", error)
        return data.get("tasks") or [], None

    async def _task_list(self, session_id: str, status: str, limit: int) -> str:
        tasks, error_text = await self._fetch_tasks(session_id, status, limit)
        if error_text:
            return error_text
        if not tasks:
            conditions = []
            if session_id:
                conditions.append(f"会话 {session_id}")
            if status:
                conditions.append(f"状态 {status}")
            scope = "、".join(conditions)
            if scope:
                return f"没有找到符合条件（{scope}）的任务。"
            return "当前没有任何任务记录。"
        heading = f"共 {len(tasks)} 个任务"
        if session_id:
            heading += f"（会话 {session_id}）"
        lines = [heading + "："]
        lines.extend(self._format_task_line(item) for item in tasks)
        return "\n".join(lines)

    def _format_task_line(self, item: dict) -> str:
        line = f"- {item.get('taskId') or '（缺少编号）'}｜{item.get('status') or '未知状态'}"
        session_id = item.get("sessionId")
        if session_id:
            line += f"｜会话 {session_id}"
        prompt = str(item.get("prompt") or "").replace("\n", " ").strip()
        if prompt:
            line += f"｜{self._truncate_text(prompt, 80)}"
        phase = item.get("phase")
        if phase:
            line += f"｜{phase}"
        created_at = item.get("createdAt")
        if created_at:
            line += f"｜创建 {self._format_time(created_at)}"
        if item.get("durationMs") is not None:
            line += f"｜耗时 {self._format_duration(item.get('durationMs'))}"
        return line

    @staticmethod
    def _session_block(task: dict) -> dict:
        block = task.get("session")
        return block if isinstance(block, dict) else {}

    def _format_task_detail(self, task: dict) -> str:
        session_block = self._session_block(task)
        lines = [f"任务 {task.get('taskId') or '（缺少编号）'}："]
        lines.append(f"状态：{task.get('status') or '未知状态'}")
        session_id = task.get("sessionId") or session_block.get("sessionId")
        if session_id:
            lines.append(f"会话：{session_id}")
        session_title = task.get("sessionTitle") or session_block.get("title")
        if session_title:
            lines.append(f"会话标题：{session_title}")
        session_status = task.get("sessionStatus") or session_block.get("status")
        if session_status:
            lines.append(f"会话状态：{session_status}")
        prompt = str(task.get("prompt") or "").strip()
        if prompt:
            lines.append("提示词：\n" + self._truncate_text(prompt, 2000))
        created_at = task.get("createdAt")
        if created_at:
            lines.append(f"创建时间：{self._format_time(created_at)}")
        started_at = task.get("startedAt")
        if started_at:
            lines.append(f"开始时间：{self._format_time(started_at)}")
        finished_at = task.get("finishedAt")
        if finished_at:
            lines.append(f"结束时间：{self._format_time(finished_at)}")
        if task.get("durationMs") is not None:
            lines.append(f"耗时：{self._format_duration(task.get('durationMs'))}")
        last_message = task.get("lastMessage")
        if last_message:
            lines.append("最近输出：\n" + self._truncate_text(str(last_message), 3000))
        error = task.get("error")
        if error:
            lines.append(f"错误：{error}")
        return "\n".join(lines)

    async def _task_status(self, task_id: str) -> str:
        if not task_id:
            return "查看任务详情需要 task_id；请先用 dsh_task 的 list 动作查询任务编号。"
        try:
            task = await self._bridge("GET", f"/tasks/{urllib.parse.quote(task_id, safe='')}")
        except Exception as error:
            logger.error(f"dsh_bridge 获取任务详情失败: {error}")
            return self._bridge_error_text("读取任务详情（GET /tasks/:id）", error)
        return self._format_task_detail(task)

    async def _task_progress(self, task_id: str) -> str:
        if not task_id:
            return "查询进度需要 task_id；请先用 dsh_task 的 list 动作查询任务编号。"
        try:
            task = await self._bridge("GET", f"/tasks/{urllib.parse.quote(task_id, safe='')}")
        except Exception as error:
            logger.error(f"dsh_bridge 获取任务进度失败: {error}")
            return self._bridge_error_text("读取任务详情（GET /tasks/:id）", error)
        status = task.get("status") or "未知状态"
        session_block = self._session_block(task)
        lines = [f"任务 {task_id} 进度：", f"状态：{status}"]
        session_id = task.get("sessionId") or session_block.get("sessionId")
        if session_id:
            lines.append(f"会话：{session_id}")
        session_title = task.get("sessionTitle") or session_block.get("title")
        if session_title:
            lines.append(f"会话标题：{session_title}")
        phase = task.get("phase")
        if phase:
            lines.append(f"当前阶段：{phase}")
        percent = task.get("progressPercent", task.get("percent", task.get("progress")))
        if isinstance(percent, (int, float)):
            lines.append(f"大致进度：{percent}%")
        elif isinstance(percent, str) and percent.strip():
            lines.append(f"大致进度：{percent}")
        if status == "running":
            elapsed = self._elapsed_ms(task.get("startedAt"))
            if elapsed is not None:
                lines.append(f"已运行：{self._format_duration(elapsed)}")
        if task.get("durationMs") is not None:
            lines.append(f"总耗时：{self._format_duration(task.get('durationMs'))}")
        last_message = task.get("lastMessage")
        if last_message:
            lines.append("最近输出：\n" + self._truncate_text(str(last_message), 2000))
        error = task.get("error")
        if error:
            lines.append(f"错误：{error}")
        if session_id:
            lines.append(await self._task_events(session_id, task_id))
        else:
            lines.append("任务详情没有 sessionId，无法核对最近事件的归属，因此不展示事件。")
        return "\n".join(lines)

    async def _task_events(self, session_id: str, task_id: str) -> str:
        path = "/events?" + urllib.parse.urlencode({"sessionId": session_id})
        try:
            data = await self._bridge("GET", path)
        except Exception as error:
            logger.warning(f"dsh_bridge 读取事件失败: {error}")
            return self._bridge_error_text("读取事件（GET /events）", error)
        events = data.get("events") or []
        matched = [item for item in events if self._event_task_id(item) == task_id]
        if not matched:
            if any(self._event_task_id(item) for item in events):
                return "最近事件：没有找到属于该任务的事件。"
            if events:
                return "最近事件：桥接返回的事件都没有标注任务的编号，无法确认是否属于当前任务，因此不展示。"
            return "最近事件：暂无。"
        lines = ["最近事件："]
        for item in matched[-5:]:
            lines.append(f"- {self._format_event(item)}")
        return "\n".join(lines)

    @staticmethod
    def _event_task_id(item: dict) -> str:
        task_id = item.get("taskId")
        if task_id:
            return str(task_id)
        data = item.get("data")
        if isinstance(data, dict) and data.get("taskId"):
            return str(data["taskId"])
        return ""

    def _format_event(self, item: dict) -> str:
        event_type = item.get("type") or "未知事件"
        data = item.get("data")
        pieces = []
        if isinstance(data, dict):
            text = data.get("text")
            if text:
                pieces.append(self._truncate_text(str(text).replace("\n", " ").strip(), 200))
            for key in ("phase", "status", "reason", "title"):
                value = data.get(key)
                if value is not None and value != "":
                    pieces.append(f"{key}={value}")
        suffix = "；".join(piece for piece in pieces if piece)
        return f"[{self._format_time(item.get('time'))}] {event_type}" + (f"：{suffix}" if suffix else "")

    async def _task_cancel(self, task_id: str) -> str:
        if not task_id:
            return "中断任务需要 task_id；请先用 dsh_task 的 list 动作查询任务编号。"
        try:
            result = await self._bridge("POST", f"/tasks/{urllib.parse.quote(task_id, safe='')}/cancel", {})
        except Exception as error:
            logger.error(f"dsh_bridge 中断任务失败: {error}")
            return self._bridge_error_text("中断任务（POST /tasks/:id/cancel）", error)
        if result.get("ok"):
            return f"已请求中断任务 {task_id}。中断生效后桥接层会推送结果，你可以告诉用户任务已停止。"
        return f"中断任务失败：{result.get('error') or result.get('reason') or '桥接未给出原因'}"

    async def _task_continue(self, event: AstrMessageEvent, task_id: str, prompt: str) -> str:
        if not task_id:
            return "继续任务需要 task_id；请先用 dsh_task 的 list 动作查询任务编号。"
        note = (prompt or "").strip()
        payload = {
            "prompt": note or "请继续完成刚才中断的任务，从上次中断的位置接着做，完成后汇报结果。",
            "umo": self._report_umo(event),
            "fileUmo": event.unified_msg_origin if event.get_message_type() == MessageType.GROUP_MESSAGE else "",
        }
        try:
            result = await self._bridge(
                "POST",
                f"/tasks/{urllib.parse.quote(task_id, safe='')}/continue",
                payload,
            )
        except Exception as error:
            logger.error(f"dsh_bridge 继续任务失败: {error}")
            return self._bridge_error_text("继续任务（POST /tasks/:id/continue）", error)
        new_task_id = result.get("taskId")
        if not new_task_id:
            return f"桥接服务返回的内容缺少任务编号，无法确认提交结果：{result}"
        session_id = result.get("sessionId")
        suffix = f"，会话 {session_id}" if session_id else ""
        receipt = f"已提交继续指令（新任务编号 {new_task_id}{suffix}），我发出的提示词是：\n\n{payload['prompt']}"
        event.set_extra("dsh_receipt_text", receipt)
        event.set_extra("dsh_single_message", True)
        return (
            f"已提交继续指令（新任务编号 {new_task_id}{suffix}）。"
            "回执已由插件生成并发送，你不需要再重复提示词。"
            "现在请立即向用户回一句极短的确认，然后停下，不要调用其他工具。"
        )

    @filter.llm_tool(name="dsh_approval")
    async def dsh_approval(self, event: AstrMessageEvent, action: str = "list") -> str:
        """查询 DSH 的审批情况：当前待审批项与最近已结束的审批。
        待审批项包含工具、命令、原因、所属会话与任务、已等待时间；
        最近已结束的审批包含工具、命令、原因、会话、任务、发起时间、结束时间与结果。
        当用户询问是否在等审批、审批要批什么、任务为什么停住，或想确认刚才的审批结果时调用。
        管理员在 QQ 里可以回复「允许 审批编号」或「拒绝 审批编号」精确处理某一项，
        只回复「允许」或「拒绝」时处理当前推送的那一项。
        本工具只能查询；审批决定必须由管理员本人作出，不要代替管理员批准或拒绝。

        Args:
            action(string): 目前只支持 list。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        if (action or "").strip().lower() != "list":
            return "action 目前只支持 list。"
        return await self._approval_list()

    async def _approval_list(self) -> str:
        try:
            data = await self._bridge("GET", "/approvals?limit=20")
        except BridgeError as error:
            if error.status == 404:
                return await self._approval_list_legacy(error)
            logger.error(f"dsh_bridge 获取审批列表失败: {error}")
            return self._bridge_error_text("读取审批列表（GET /approvals）", error)
        except Exception as error:
            logger.error(f"dsh_bridge 获取审批列表失败: {error}")
            return self._bridge_error_text("读取审批列表（GET /approvals）", error)
        pending = data.get("pending") or []
        recent = data.get("recent") or []
        lines = []
        if pending:
            lines.append(f"待审批 {len(pending)} 项：")
            lines.extend(self._format_approval(item) for item in pending)
        else:
            lines.append("当前没有待审批项。")
        if recent:
            lines.append(f"最近已结束的审批 {len(recent)} 项：")
            lines.extend(self._format_approval(item, finished=True) for item in recent)
        else:
            lines.append("最近没有已结束的审批记录。")
        lines.append(
            "审批决定由管理员在 QQ 里回复「允许 审批编号」或「拒绝 审批编号」作出，"
            "也可以只回复「允许」或「拒绝」处理当前推送项；"
            "你只负责查询，不要代替管理员决定，也不要声称已经批准或拒绝。"
        )
        return "\n".join(lines)

    async def _approval_list_legacy(self, cause: Exception) -> str:
        logger.info(f"dsh_bridge 新审批接口不可用（{cause}），回退到 /approvals/pending")
        try:
            data = await self._bridge("GET", "/approvals/pending")
        except Exception as error:
            logger.error(f"dsh_bridge 获取待审批项失败: {error}")
            return self._bridge_error_text("读取待审批项（GET /approvals/pending）", error)
        approvals = data.get("pending") or []
        lines = ["桥接版本较旧，尚未提供最近已结束的审批查询，下面只展示待审批项。"]
        if approvals:
            lines.append(f"待审批 {len(approvals)} 项：")
            lines.extend(self._format_approval(item) for item in approvals)
        else:
            lines.append("当前没有待审批项。")
        lines.append(
            "审批决定由管理员在 QQ 里回复「允许 审批编号」或「拒绝 审批编号」作出，"
            "也可以只回复「允许」或「拒绝」处理当前推送项；"
            "你只负责查询，不要代替管理员决定，也不要声称已经批准或拒绝。"
        )
        return "\n".join(lines)

    def _format_approval(self, item: dict, finished: bool = False) -> str:
        lines = [f"- 审批编号 {item.get('id') or '未知'}｜工具 {item.get('toolName') or '未知工具'}"]
        if item.get("sessionId"):
            lines.append(f"  会话：{item.get('sessionId')}")
        if item.get("taskId"):
            lines.append(f"  任务：{item.get('taskId')}")
        command = str(item.get("command") or "").strip()
        if command:
            lines.append("  命令：" + self._truncate_text(command, 1500).replace("\n", "\n    "))
        reason = str(item.get("reason") or "").strip()
        if reason:
            lines.append(f"  原因：{reason}")
        created_at = item.get("createdAt")
        if created_at:
            lines.append(f"  发起时间：{self._format_time(created_at)}")
        if finished:
            decided_at = item.get("decidedAt") or item.get("finishedAt")
            if decided_at:
                lines.append(f"  结束时间：{self._format_time(decided_at)}")
            status = item.get("status")
            outcome = item.get("outcome")
            if status == "timeout":
                lines.append("  结果：超时自动拒绝")
            elif outcome is None or outcome == "":
                lines.append("  结果：未知")
            else:
                lines.append(f"  结果：{self._approval_outcome_label(outcome)}")
        elif created_at:
            elapsed = self._elapsed_ms(created_at)
            if elapsed is not None:
                lines.append(f"  已等待：{self._format_duration(elapsed)}")
        return "\n".join(lines)

    @staticmethod
    def _approval_outcome_label(outcome) -> str:
        value = str(outcome)
        return APPROVAL_OUTCOME_LABELS.get(value, value)

    @staticmethod
    def _format_time(value) -> str:
        if value is None or value == "":
            return "未知时间"
        if isinstance(value, (int, float)):
            seconds = float(value)
            if seconds > 1e12:
                seconds /= 1000.0
            try:
                moment = datetime.datetime.fromtimestamp(seconds)
            except (OverflowError, OSError, ValueError):
                return str(value)
            return moment.strftime("%Y-%m-%d %H:%M:%S")
        return str(value)

    @staticmethod
    def _format_duration(milliseconds) -> str:
        try:
            total_seconds = int(float(milliseconds) / 1000.0)
        except (TypeError, ValueError):
            return "未知"
        if total_seconds < 0:
            return "未知"
        days, remainder = divmod(total_seconds, 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, seconds = divmod(remainder, 60)
        parts = []
        if days:
            parts.append(f"{days} 天")
        if hours:
            parts.append(f"{hours} 小时")
        if minutes:
            parts.append(f"{minutes} 分")
        if seconds or not parts:
            parts.append(f"{seconds} 秒")
        return " ".join(parts)

    @staticmethod
    def _elapsed_ms(started_at):
        if started_at is None or started_at == "":
            return None
        if isinstance(started_at, (int, float)):
            seconds = float(started_at)
            if seconds > 1e12:
                seconds /= 1000.0
            start = datetime.datetime.fromtimestamp(seconds)
        else:
            try:
                start = datetime.datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
            except ValueError:
                return None
        now = datetime.datetime.now(start.tzinfo) if start.tzinfo is not None else datetime.datetime.now()
        return max(0, int((now - start).total_seconds() * 1000))

    @staticmethod
    def _truncate_text(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return text[:limit] + "……（已截断）"

    @staticmethod
    def _bridge_error_text(operation: str, error: Exception) -> str:
        if isinstance(error, BridgeError) and error.status == 404 and str(error) == "未知接口":
            return f"桥接服务尚未提供{operation}接口，请先更新 DSH 聊天机器人桥接插件后再试。"
        return f"{operation}失败：{error}"

    def _resolve_workspace_file(self, file_name: str):
        root = os.path.realpath(self._workspace)
        candidate = os.path.realpath(os.path.join(self._workspace, file_name.strip()))
        if candidate != root and not candidate.startswith(root + os.sep):
            return None, "只能访问工作区内的文件。"
        if not os.path.isfile(candidate):
            return None, f"工作区里没有这个文件：{file_name}"
        return candidate, None

    @filter.llm_tool(name="dsh_file")
    async def dsh_file(
        self,
        event: AstrMessageEvent,
        action: str,
        file_name: str,
        start: int = 0,
        max_chars: int = 2000,
    ) -> str:
        """读取或发送 DSH 工作区内的文件。
        action 为 send 时把工作区里已有的文件直接发给用户；action 为 read 时读取文本内容，支持分段读取。
        处理 DSH 工作区文件只用本工具，不要使用 AstrBot 自带的文件工具。

        Args:
            action(string): send 或 read。
            file_name(string): 工作区内的文件名或相对路径，例如 notes.txt。
            start(int): action 为 read 时从第几个字符开始读，默认 0。
            max_chars(int): action 为 read 时本次最多返回多少个字符，默认 2000，最大 8000。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        action = (action or "").strip().lower()
        file_name = (file_name or "").strip()
        if not file_name:
            return "需要提供 file_name，例如 notes.txt。"
        if action == "send":
            return await self._send_workspace_file(event, file_name)
        if action == "read":
            return await self._read_workspace_file(file_name, start, max_chars)
        return "action 只能是 send 或 read。"

    async def _send_workspace_file(self, event: AstrMessageEvent, file_name: str) -> str:
        target, error = self._resolve_workspace_file(file_name)
        if error:
            return error
        size = os.path.getsize(target)
        if size > MAX_FILE_BYTES:
            return f"文件太大（{size} 字节），超过发送上限。"
        try:
            sent = await self.context.send_message(
                event.unified_msg_origin,
                MessageChain([File(name=os.path.basename(target), file=target)]),
            )
        except Exception as error:
            logger.warning(f"dsh_bridge 发送工作区文件失败: {error}")
            return f"发送失败：{error}"
        if not sent:
            return "文件发送失败，平台可能未就绪。"
        await self._record_sent({
            "time": self._now(),
            "taskId": "",
            "sessionTitle": "",
            "umo": event.unified_msg_origin,
            "text": f"（主动发送工作区文件）{os.path.basename(target)}",
            "files": [{"name": os.path.basename(target), "path": target, "size": size}],
        })
        return f"已发送 {os.path.basename(target)}（{size} 字节）。"

    async def _read_workspace_file(self, file_name: str, start: int, max_chars: int) -> str:
        target, error = self._resolve_workspace_file(file_name)
        if error:
            return error
        if os.path.getsize(target) > 1024 * 1024:
            return "文件超过 1MB，改用发送文件的方式查看。"
        try:
            with open(target, "rb") as handle:
                raw = handle.read()
        except Exception as error:
            return f"读取失败：{error}"
        if b"\x00" in raw[:4096]:
            return "这是二进制文件，内容无法直接展示，可以用发送文件的方式获取。"
        text = raw.decode("utf-8", errors="replace").lstrip("\ufeff")
        total = len(text)
        start = max(0, min(int(start or 0), total))
        max_chars = max(1, min(int(max_chars or 2000), 8000))
        chunk = text[start:start + max_chars]
        if start + len(chunk) < total:
            chunk += (
                f"\n……（本次返回第 {start + 1} 到 {start + len(chunk)} 个字符，"
                f"共 {total} 个字符，可用 start={start + len(chunk)} 继续读取）"
            )
        return chunk

    @filter.llm_tool(name="read_own_sent_messages")
    async def read_own_sent_messages(
        self,
        event: AstrMessageEvent,
        index: int = 0,
        task_id: str = "",
        keyword: str = "",
        full: bool = False,
    ) -> str:
        """读取机器人自己最近发送给用户的内容，包括从 DSH 转发的任务结果与文件。
        当用户询问“刚才发的/之前发的结果或文件是什么”“结果有没有发出去”，
        或者需要确认自己已经推送过的内容时调用；必要时可以强制读取完整内容与文件文本。

        Args:
            index(int): 读取倒数第几条发送记录，1 表示最近一条，0 表示默认最近一条。
            task_id(string): 按 DSH 任务编号筛选，例如 task_1792586133760_731。
            keyword(string): 按文本内容或文件名筛选。
            full(bool): 是否返回完整文本；为 true 时文本不截断，并尝试读取工作区内文本文件的内容。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        async with self._sent_history_lock:
            records = list(self._sent_history)
        if not records:
            return "最近没有发送过内容。"
        selected = []
        if task_id:
            selected = [item for item in records if task_id in str(item.get("taskId") or "")]
        elif keyword:
            needle = keyword.strip()
            for item in records:
                file_names = " ".join(
                    str(file_item.get("name") or "") for file_item in item.get("files") or []
                )
                if needle in str(item.get("text") or "") or needle in file_names:
                    selected.append(item)
            selected = selected[-5:]
        elif index and index > 0:
            if index <= len(records):
                selected = [records[-index]]
        else:
            selected = [records[-1]]
        if not selected:
            return "没有找到匹配的发送记录。"
        lines = [f"共 {len(records)} 条发送记录，以下为匹配结果："]
        for item in selected:
            lines.append(self._format_sent_record(records, item, full))
        text = "\n\n".join(lines)
        if len(text) > 12000:
            text = text[:12000] + "\n……（输出过长已截断）"
        return text

    @filter.on_decorating_result()
    async def on_decorating_result(self, event: AstrMessageEvent) -> None:
        receipt = event.get_extra("dsh_receipt_text")
        if receipt:
            text = str(receipt)
            result = event.get_result()
            if result is None:
                event.set_result(
                    MessageEventResult(chain=[Plain(text)]).set_result_content_type(
                        ResultContentType.GENERAL_RESULT
                    )
                )
            else:
                result.chain = [Plain(text)]
                result.set_result_content_type(ResultContentType.GENERAL_RESULT)
            return
        if not event.get_extra("dsh_single_message"):
            return
        result = event.get_result()
        if not result or not result.chain:
            return
        text_parts = []
        other_parts = []
        for component in result.chain:
            if isinstance(component, Plain):
                text_parts.append(component.text)
            else:
                other_parts.append(component)
        merged = "".join(part for part in text_parts if part)
        if merged:
            result.chain = [Plain(merged)] + other_parts
        result.set_result_content_type(ResultContentType.GENERAL_RESULT)

    @filter.on_llm_request()
    async def on_llm_request(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        if not self._allowed(event):
            return
        extra = (
            "\n\nDSH 桥接规则：\n"
            "1. 本插件只提供 5 个 DSH 工具：dsh_session（会话列表、状态、历史、提示词）、"
            "dsh_task（任务提交、列表、详情、进度、中断、继续）、dsh_approval（待审批项查询）、"
            "dsh_file（DSH 工作区文件读取与发送）、read_own_sent_messages（读取自己已发送的内容）。"
            "旧的 run_dsh_task、ask_dsh_progress、cancel_dsh_task、continue_dsh_task、"
            "send_workspace_file、read_workspace_file、list_dsh_sessions、operate_dsh_session 已经下线，"
            "不要调用这些名称，也不要用 AstrBot 自带的同类工具代替。\n"
            "2. 需要在本机执行文件读写、改代码、运行命令、批量处理等实际操作时，用 dsh_task 的 run 动作交给 DSH；"
            "简单问答、闲聊、知识查询不要调用。\n"
            "3. 涉及会话与任务的操作必须精确指定目标：会话用 session_id，任务用 task_id。"
            "编号只能来自工具查询结果，禁止猜测或凭记忆填写；无法唯一确定目标时，先用 dsh_session 的 list "
            "或 dsh_task 的 list 查询。\n"
            "4. 提交任务或提示词后必须向用户回一句简短自然的话，说明已转交，并把发给 DSH 的提示词附上。"
            "回执用你自己的话组织，不要用固定模板。任务结果和产物文件由桥接层自动发送给用户，"
            "不要调用 send_message_to_user 发送 DSH 的结果或文件。\n"
            "5. 不要主动查任务状态，除非用户明确询问进度、卡在哪、还要多久、做完了没有。"
            "查询时用 dsh_task 的 status 或 progress 动作并按 task_id 精确指定；"
            "用户要求停止或取消时用 cancel 动作；要求继续时用 continue 动作；"
            "运行中的任务需要追加指令时用 dsh_session 的 prompt 动作并指定 session_id。\n"
            "6. 读取或发送 DSH 工作区内的文件只用 dsh_file；不要使用 astrbot_file_read_tool、"
            "astrbot_file_write_tool 等 AstrBot 自带文件工具处理 DSH 工作区。\n"
            "7. DSH 执行任务时遇到越权操作（工作区外读写、需要提权的命令）会自动向管理员发起审批。"
            "用 dsh_approval 可以查询待审批项的工具、命令、原因与所属会话，也可以查看最近已结束审批的时间与结果；"
            "待审批项有多条时推送文案会带审批编号与序号，管理员可以回复「允许 审批编号」或「拒绝 审批编号」"
            "精确处理某一项；审批决定必须由管理员本人作出，模型不得代替管理员批准或拒绝，"
            "也不要根据最近的审批结果推断下一次审批会被允许。\n"
            "8. 需要查看会话双方历史消息、DSH 之前的输出，或判断某个会话最近在做什么时，"
            "用 dsh_session 的 history 或 status 动作读取，不要凭记忆回答。\n"
            f"9. DSH 只给最高管理员（QQ {self._admin_qq}）使用。其他人询问 DSH、要求用 DSH 做事、"
            "或者让你操作电脑、写文件、跑命令时，必须明确拒绝，不要答应，也不要向他们介绍 DSH 的能力。"
            "拒绝时用普通聊天的语气，不要说教，也不要说'可以'或'我交给它弄'。\n"
            f"10. 用户提到“工作区”“当前目录”或让 DSH 处理某个文件时，默认指 DSH 工作区：{self._workspace}。"
            "交给 DSH 的任务里不要把目标目录改写成 AstrBot 自己的平台工作区路径；"
            "用户没有给绝对路径时，按 DSH 工作区内的相对路径描述任务。\n"
        )
        extra += self._recent_sent_note()
        req.system_prompt = (req.system_prompt or "") + extra

    @filter.on_astrbot_loaded()
    async def on_loaded(self) -> None:
        self._load_sent_history()
        await self._load_settings()
        self._poll_task = asyncio.create_task(self._poll_reports())
        asyncio.create_task(self._poll_approvals())
        asyncio.create_task(self._poll_events())
        logger.info("dsh_bridge 报告、审批与事件轮询已启动")
        if self._sent_history:
            logger.info(f"dsh_bridge 已加载 {len(self._sent_history)} 条发送记录")

    async def _poll_approvals(self) -> None:
        while True:
            try:
                data = await self._bridge("GET", "/approvals/pending")
                approvals = data.get("pending") or []
                self._pending_approvals = approvals
                if not approvals:
                    self._pending_approval_id = None
                else:
                    current_id = self._pending_approval_id or ""
                    current = next(
                        (item for item in approvals if str(item.get("id") or "") == current_id),
                        None,
                    )
                    if current is None:
                        item = approvals[0]
                        text = self._format_approval_notice(item, 1, len(approvals))
                        umo = f"napcat:FriendMessage:{self._admin_qq}"
                        sent = await self._send_chunked(umo, text)
                        if sent:
                            self._pending_approval_id = str(item.get("id") or "")
                            logger.info(
                                f"dsh_bridge 已推送审批请求 {self._pending_approval_id}"
                                f"（共 {len(approvals)} 项待审批）"
                            )
                        else:
                            logger.warning("dsh_bridge 审批请求发送失败，稍后重试")
            except Exception as error:
                logger.warning(f"dsh_bridge 拉取审批请求失败: {error}")
            await asyncio.sleep(2)

    def _format_approval_notice(self, item: dict, index: int, total: int) -> str:
        approval_id = str(item.get("id") or "")
        tool = item.get("toolName") or "未知工具"
        reason = item.get("reason") or "（无说明）"
        lines = [
            f"DSH 请求提升权限（第 {index} 项，共 {total} 项待审批）",
            f"审批编号：{approval_id}",
            f"工具：{tool}",
            f"原因：{reason}",
        ]
        if item.get("sessionId"):
            lines.append(f"会话：{item.get('sessionId')}")
        if item.get("taskId"):
            lines.append(f"任务：{item.get('taskId')}")
        lines.append("")
        lines.append(f"回复「允许 {approval_id}」或「拒绝 {approval_id}」处理这一项；")
        if total > 1:
            lines.append("也可以只回复「允许」或「拒绝」处理当前这一项。")
        else:
            lines.append("也可以只回复「允许」或「拒绝」。")
        lines.append("超时自动拒绝。")
        return "\n".join(lines)

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_approval_reply(self, event: AstrMessageEvent) -> None:
        if not self._allowed(event):
            return
        if event.get_message_type() != MessageType.FRIEND_MESSAGE:
            return
        text = (event.message_str or "").strip()
        if not text or len(text) > 80:
            return
        decision, approval_id = self._parse_approval_reply(text)
        if decision is None:
            return
        pending = list(self._pending_approvals)
        if approval_id:
            target = next(
                (
                    item
                    for item in pending
                    if str(item.get("id") or "").lower() == approval_id.lower()
                ),
                None,
            )
            if target is None:
                try:
                    data = await self._bridge("GET", "/approvals/pending")
                    self._pending_approvals = data.get("pending") or []
                    pending = list(self._pending_approvals)
                except Exception as error:
                    logger.warning(f"dsh_bridge 刷新待审批列表失败: {error}")
                target = next(
                    (
                        item
                        for item in pending
                        if str(item.get("id") or "").lower() == approval_id.lower()
                    ),
                    None,
                )
            if target is None:
                event.stop_event()
                known = "、".join(str(item.get("id") or "未知编号") for item in pending) or "无"
                await self.context.send_message(
                    event.unified_msg_origin,
                    MessageChain([
                        Plain(
                            f"没有找到待审批编号 {approval_id}。"
                            f"当前待审批项：{known}。请核对编号后重新回复。"
                        )
                    ]),
                )
                logger.info(f"dsh_bridge 审批编号不存在，未提交：{approval_id}")
                return
            approval_id = str(target.get("id") or "")
        else:
            approval_id = self._pending_approval_id or ""
            if not approval_id:
                return
        event.stop_event()
        decision_value = "allow" if decision == "allow" else "reject"
        try:
            await self._bridge("POST", "/approval/answer", {"id": approval_id, "decision": decision_value})
            if self._pending_approval_id == approval_id:
                self._pending_approval_id = None
            self._pending_approvals = [
                item for item in self._pending_approvals
                if str(item.get("id") or "") != approval_id
            ]
            label = "允许" if decision == "allow" else "拒绝"
            await self.context.send_message(
                event.unified_msg_origin,
                MessageChain([Plain(f"审批已提交：{label}（{approval_id}）")]),
            )
            logger.info(f"dsh_bridge 审批 {approval_id} 已提交: {decision_value}")
        except Exception as error:
            logger.warning(f"dsh_bridge 提交审批失败: {error}")
            await self.context.send_message(
                event.unified_msg_origin,
                MessageChain([Plain(f"审批提交失败：{error}")]),
            )

    @staticmethod
    def _parse_approval_reply(text: str):
        for pattern, decision in (
            (APPROVAL_ALLOW_PATTERN, "allow"),
            (APPROVAL_DENY_PATTERN, "reject"),
        ):
            match = pattern.match(text)
            if not match:
                continue
            rest = match.group("rest").strip()
            while rest[:1] in (":", "：", " ", "\t"):
                rest = rest[1:].strip()
            if not rest:
                return decision, ""
            if APPROVAL_ID_PATTERN.fullmatch(rest):
                return decision, rest
            return None, ""
        return None, ""

    async def _poll_reports(self) -> None:
        while True:
            try:
                data = await self._bridge("GET", "/reports")
                reports = data.get("reports", [])
                if reports:
                    acked = []
                    for item in reports:
                        task_id = str(item.get("taskId") or "")
                        steer_state = self._steer_tasks.get(task_id)
                        raw_text = str(item.get("text") or "")
                        pushed_text = str(steer_state.get("text") or "") if steer_state else ""
                        # 只跳过与实时推送完全相同的文本；最终答复不同时仍要发送
                        skip_text = bool(
                            steer_state
                            and steer_state.get("pushed")
                            and pushed_text.strip()
                            and raw_text.strip() == pushed_text.strip()
                        )
                        files = item.get("files") or []
                        umo = item.get("umo") or f"napcat:FriendMessage:{self._admin_qq}"
                        file_umo = item.get("fileUmo") or umo
                        title = str(item.get("sessionTitle") or "")
                        text = raw_text
                        if title:
                            text = f"（转发自DSH会话：{title}）\n\n{text}"
                        ok = True
                        if skip_text:
                            logger.info(f"dsh_bridge steer 回复已实时推送，跳过报告文本：{task_id}")
                        else:
                            ok = await self._send_chunked(umo, text)
                        if ok:
                            ok = await self._send_files(file_umo, files)
                        if ok:
                            acked.append(item["taskId"])
                            if skip_text:
                                if files:
                                    await self._record_sent({
                                        "time": self._now(),
                                        "taskId": task_id,
                                        "sessionTitle": title,
                                        "umo": umo,
                                        "text": "",
                                        "files": files,
                                    })
                            else:
                                await self._record_sent({
                                    "time": self._now(),
                                    "taskId": item.get("taskId") or "",
                                    "sessionTitle": title,
                                    "umo": umo,
                                    "text": text,
                                    "files": files,
                                })
                            self._steer_tasks.pop(task_id, None)
                    if acked:
                        await self._bridge("POST", "/reports/ack", {"taskIds": acked})
                        logger.info(f"dsh_bridge 已推送 {len(acked)} 条结果")
            except Exception as error:
                logger.warning(f"dsh_bridge 拉取报告失败: {error}")
            await asyncio.sleep(3)

    async def _poll_events(self) -> None:
        while True:
            try:
                await self._poll_events_once()
                self._expire_steer_tasks()
            except BridgeError as error:
                if error.status == 404:
                    logger.warning(
                        "dsh_bridge 桥接版本较旧，未提供 /events 接口，"
                        "实时 steer 推送不可用；最终报告仍会正常发送"
                    )
                    return
                logger.warning(f"dsh_bridge 拉取会话事件失败，重新获取游标: {error}")
                self._event_cursor = 0
            except Exception as error:
                logger.warning(f"dsh_bridge 拉取会话事件失败，重新获取游标: {error}")
                self._event_cursor = 0
            await asyncio.sleep(EVENT_POLL_INTERVAL_SECONDS)

    async def _poll_events_once(self) -> None:
        self._event_poll_count += 1
        if self._event_cursor > 0 and self._event_poll_count % 30 == 0:
            await self._resync_event_cursor()
        if self._event_cursor <= 0:
            data = await self._bridge("GET", "/events")
            self._event_cursor = self._event_cursor_of(data)
            logger.info(f"dsh_bridge 事件轮询从序号 {self._event_cursor} 开始，跳过早先事件")
            return
        data = await self._bridge("GET", f"/events?sinceSeq={self._event_cursor}")
        for item in data.get("events") or []:
            seq = item.get("seq")
            if not isinstance(seq, int) or seq <= self._event_cursor:
                continue
            self._event_cursor = seq
            await self._handle_live_event(item)
        cursor = data.get("cursor")
        if isinstance(cursor, int) and cursor > self._event_cursor:
            self._event_cursor = cursor

    async def _resync_event_cursor(self) -> None:
        data = await self._bridge("GET", "/events")
        latest = self._event_cursor_of(data)
        if latest < self._event_cursor:
            logger.warning(
                f"dsh_bridge 检测到事件序号回退（{self._event_cursor} -> {latest}），"
                "桥接可能已重启，重新获取游标"
            )
            self._event_cursor = latest

    @staticmethod
    def _event_cursor_of(data: dict) -> int:
        cursor = data.get("cursor")
        best = cursor if isinstance(cursor, int) else 0
        for item in data.get("events") or []:
            seq = item.get("seq")
            if isinstance(seq, int) and seq > best:
                best = seq
        return best

    async def _handle_live_event(self, item: dict) -> None:
        if item.get("type") != "assistant/message":
            return
        task_id = self._event_task_id(item)
        if not task_id:
            return
        state = self._steer_tasks.get(task_id)
        if state is None or state.get("pushed"):
            return
        data = item.get("data")
        text = str(data.get("text") or "").strip() if isinstance(data, dict) else ""
        text = self._clean_live_text(text)
        if not text:
            return
        umo = str(state.get("umo") or "")
        if not umo:
            self._steer_tasks.pop(task_id, None)
            return
        message = f"{STEER_PUSH_PREFIX}\n{text}"
        if not await self._send_chunked(umo, message):
            logger.warning(f"dsh_bridge steer 回复实时推送失败，等待最终报告：{task_id}")
            return
        state["pushed"] = True
        state["text"] = text
        await self._record_sent({
            "time": self._now(),
            "taskId": task_id,
            "sessionTitle": "",
            "umo": umo,
            "text": message,
            "files": [],
        })
        logger.info(f"dsh_bridge 已实时推送 steer 回复：{task_id}")

    @staticmethod
    def _clean_live_text(text: str) -> str:
        kept = []
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("（调用工具") and stripped.endswith("）"):
                continue
            kept.append(line)
        return "\n".join(kept).strip()

    def _expire_steer_tasks(self) -> None:
        now = datetime.datetime.now().timestamp()
        for task_id in list(self._steer_tasks):
            state = self._steer_tasks.get(task_id) or {}
            created_at = state.get("createdAt")
            if not isinstance(created_at, (int, float)):
                created_at = now
            if now - float(created_at) > STEER_TASK_TTL_SECONDS:
                self._steer_tasks.pop(task_id, None)
                logger.info(f"dsh_bridge 已清理过期的 steer 缓存：{task_id}")

    def _within_workspace(self, file_path: str) -> bool:
        try:
            real_path = os.path.realpath(file_path)
            root = os.path.realpath(self._workspace)
            return os.path.commonpath([real_path, root]) == root
        except Exception:
            return False

    async def _send_files(self, umo: str, files: list) -> bool:
        for file_item in files:
            file_path = str(file_item.get("path") or "")
            name = str(file_item.get("name") or os.path.basename(file_path) or "file")
            if not self._within_workspace(file_path):
                logger.warning(f"dsh_bridge 跳过工作区外的文件: {file_path}")
                continue
            if not os.path.isfile(file_path):
                continue
            if os.path.getsize(file_path) > MAX_FILE_BYTES:
                logger.warning(f"dsh_bridge 跳过过大的文件: {name}")
                continue
            try:
                logger.info(f"dsh_bridge 发送文件: {name} ({os.path.getsize(file_path)} 字节)")
                sent = await self.context.send_message(umo, MessageChain([File(name=name, file=file_path)]))
                if not sent:
                    logger.warning(f"dsh_bridge 文件发送失败，保留待重试: {name}")
                    return False
                await asyncio.sleep(0.5)
            except Exception as error:
                logger.warning(f"dsh_bridge 文件发送异常（保留待重试）: {error}")
                return False
        return True

    async def _send_chunked(self, umo: str, text: str) -> bool:
        chunks = [text[i:i + CHUNK_LIMIT] for i in range(0, len(text), CHUNK_LIMIT)] or [""]
        try:
            for chunk in chunks:
                sent = await self.context.send_message(umo, MessageChain([Plain(chunk)]))
                if not sent:
                    logger.warning(f"dsh_bridge 平台未就绪，结果保留待重试: {umo}")
                    return False
                await asyncio.sleep(0.3)
            return True
        except Exception as error:
            logger.warning(f"dsh_bridge 发送结果失败（保留待重试）: {error}")
            return False

    @staticmethod
    def _now() -> str:
        return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _load_sent_history(self) -> None:
        try:
            with open(SENT_HISTORY_FILE, encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            self._sent_history = []
            return
        except Exception as error:
            logger.warning(f"dsh_bridge 读取发送记录失败: {error}")
            self._sent_history = []
            return
        if isinstance(data, list):
            self._sent_history = [
                item for item in data if isinstance(item, dict)
            ][-SENT_HISTORY_LIMIT:]
        else:
            self._sent_history = []

    def _save_sent_history(self) -> None:
        try:
            temporary = SENT_HISTORY_FILE + ".tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(self._sent_history, handle, ensure_ascii=False, indent=1)
            os.replace(temporary, SENT_HISTORY_FILE)
        except Exception as error:
            logger.warning(f"dsh_bridge 保存发送记录失败: {error}")

    async def _record_sent(self, record: dict) -> None:
        text = str(record.get("text") or "")
        if len(text) > SENT_TEXT_LIMIT:
            record["text"] = text[:SENT_TEXT_LIMIT] + "……（已截断）"
        async with self._sent_history_lock:
            self._sent_history.append(record)
            if len(self._sent_history) > SENT_HISTORY_LIMIT:
                self._sent_history = self._sent_history[-SENT_HISTORY_LIMIT:]
            self._save_sent_history()

    def _format_sent_record(self, records: list, record: dict, full: bool) -> str:
        position = records.index(record) if record in records else -1
        recent_index = len(records) - position if position >= 0 else 0
        lines = [
            f"记录：最近第 {recent_index} 条（时间 {record.get('time') or '未知'}）",
            f"任务：{record.get('taskId') or '（主动发送，无任务编号）'}",
        ]
        title = str(record.get("sessionTitle") or "")
        if title:
            lines.append(f"来源会话：{title}")
        body = str(record.get("text") or "")
        if not full and len(body) > 400:
            body = body[:400] + "……（完整内容请用 full=true 读取）"
        lines.append("内容：\n" + body)
        files = record.get("files") or []
        if files:
            file_lines = []
            for file_item in files:
                name = str(
                    file_item.get("name")
                    or os.path.basename(str(file_item.get("path") or ""))
                    or "文件"
                )
                path = str(file_item.get("path") or "")
                size = file_item.get("size")
                file_lines.append(
                    f"- {name}（{size if size is not None else '?'} 字节，路径：{path}）"
                )
                if full and path:
                    content = self._read_sent_file_content(path)
                    if content:
                        file_lines.append("  文件文本内容：\n" + content)
            lines.append("附带文件：\n" + "\n".join(file_lines))
        return "\n".join(lines)

    def _read_sent_file_content(self, file_path: str) -> str:
        try:
            if not self._within_workspace(file_path) or not os.path.isfile(file_path):
                return ""
            if os.path.getsize(file_path) > SENT_FILE_READ_LIMIT:
                return "（文件超过 64KB，未自动读取）"
            with open(file_path, "rb") as handle:
                raw = handle.read()
            if b"\x00" in raw[:4096]:
                return "（二进制文件，未自动读取）"
            text = raw.decode("utf-8", errors="replace")
            if len(text) > 4000:
                text = text[:4000] + "\n……（文件内容已截断）"
            return text
        except Exception as error:
            return f"（读取文件失败：{error}）"

    def _recent_sent_note(self) -> str:
        if not self._sent_history:
            return ""
        recent = list(self._sent_history)[-3:]
        lines = []
        for item in recent:
            body = str(item.get("text") or "").replace("\n", " ").strip()
            snippet = body[:60] + ("…" if len(body) > 60 else "")
            files = item.get("files") or []
            file_part = f"，附带文件 {len(files)} 个" if files else ""
            lines.append(
                f"- {item.get('time') or '未知时间'} "
                f"{item.get('taskId') or '主动发送'}{file_part}：{snippet}"
            )
        return (
            "最近已向用户推送过的内容（这些内容不在当前对话上下文里，"
            "如果用户询问已经发送的结果或文件，调用 read_own_sent_messages 读取，"
            "不要回答“结果没有推回来”）：\n" + "\n".join(lines) + "\n"
        )
