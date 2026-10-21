import asyncio
import datetime
import json
import os
import urllib.error
import urllib.request

from astrbot.api import logger, star
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import File, Plain
from astrbot.api.provider import ProviderRequest
from astrbot.core.message.message_event_result import MessageChain
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


class Main(star.Star):
    def __init__(self, context: star.Context) -> None:
        self.context = context
        self._poll_task = None
        self._pending_approval_id = None
        self._admin_qq = ""
        self._workspace = ""
        self._sent_history = []
        self._sent_history_lock = asyncio.Lock()

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
        request = urllib.request.Request(BRIDGE_URL + path, data=data, headers=headers, method=method)
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
            raise RuntimeError(message) from error

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

    @filter.llm_tool(name="run_dsh_task")
    async def run_dsh_task(self, event: AstrMessageEvent, prompt: str) -> str:
        """把需要在本机执行的任务交给 DSH 处理，例如写入或修改文件、改代码、执行命令、批量处理文档。
        当用户要求做实际的电脑操作、普通聊天无法完成时调用。
        简单的问答、闲聊、知识查询不要调用本工具。
        任务结果和产物文件会由桥接层自动发送给用户，提交后只需简短回执，不要调用 send_message_to_user 发送结果或文件。

        Args:
            prompt(string): 完整自包含的任务描述，包含目标、输入和期望的输出位置。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        try:
            result = await self._bridge("POST", "/task", {
                "prompt": prompt,
                "umo": self._report_umo(event),
                "fileUmo": event.unified_msg_origin if event.get_message_type() == MessageType.GROUP_MESSAGE else "",
            })
        except Exception as error:
            logger.error(f"dsh_bridge 提交任务失败: {error}")
            return f"提交给 DSH 失败：{error}"
        return (
            f"任务已提交给 DSH（编号 {result['taskId']}）。"
            "现在请立即向用户输出一句简短自然的回执，说明任务已转交，并把发给 DSH 的提示词原样附上"
            "（可以用代码块或引号）。回执发完后停下，不要调用其他工具，也不要查进度。"
        )

    @filter.llm_tool(name="ask_dsh_progress")
    async def ask_dsh_progress(self, event: AstrMessageEvent, question: str) -> str:
        """向 DSH 询问当前任务的执行进度。
        仅在用户主动询问进度、卡在哪、还要多久、做完了没有时调用。
        不要用它来确认任务是否完成，任务完成后桥接层会自动推送结果。

        Args:
            question(string): 具体要问的问题，例如“现在进度如何”。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        try:
            result = await self._bridge("POST", "/progress", {
                "question": question or "请简要汇报当前进度，一句话即可。",
            })
        except Exception as error:
            logger.error(f"dsh_bridge 询问进度失败: {error}")
            return f"询问进度失败：{error}"

        status = result.get("status")
        if status == "idle":
            return result.get("reply") or "现在没有正在执行的任务。"
        reply = result.get("reply")
        if status == "completed":
            return reply or "任务已完成，结果和文件已自动发送给用户。"
        if reply:
            return f"任务正在执行，最近的输出是：{reply}"
        return "已把询问发给 DSH，任务正在执行，稍后再问一次。"

    def _resolve_workspace_file(self, file_name: str):
        root = os.path.realpath(self._workspace)
        candidate = os.path.realpath(os.path.join(self._workspace, file_name.strip()))
        if candidate != root and not candidate.startswith(root + os.sep):
            return None, "只能访问工作区内的文件。"
        if not os.path.isfile(candidate):
            return None, f"工作区里没有这个文件：{file_name}"
        return candidate, None

    @filter.llm_tool(name="send_workspace_file")
    async def send_workspace_file(self, event: AstrMessageEvent, file_name: str) -> str:
        """把工作区里已有的文件直接发给用户。
        当用户要求发送、给我、发一份工作区内的文件时调用。

        Args:
            file_name(string): 工作区内的文件名或相对路径，例如 notes.txt
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
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

    @filter.llm_tool(name="read_workspace_file")
    async def read_workspace_file(
        self,
        event: AstrMessageEvent,
        file_name: str,
        start: int = 0,
        max_chars: int = 2000,
    ) -> str:
        """读取工作区内文本文件的内容，支持指定起始位置与返回长度。
        当用户询问工作区里某个文件写了什么、想看文件内容或只看某一段时调用。
        二进制文件或过大的文件会拒绝。

        Args:
            file_name(string): 工作区内的文件名或相对路径，例如 notes.txt
            start(int): 从第几个字符开始读，默认 0。
            max_chars(int): 本次最多返回多少个字符，默认 2000，最大 8000。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
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

    @filter.llm_tool(name="cancel_dsh_task")
    async def cancel_dsh_task(self, event: AstrMessageEvent) -> str:
        """中断当前正在执行的 DSH 任务。
        当用户明确要求停止、取消、打断、中断当前任务时调用。
        普通聊天不要调用。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        try:
            result = await self._bridge("POST", "/task/cancel", {})
        except Exception as error:
            logger.error(f"dsh_bridge 中断任务失败: {error}")
            return f"中断任务失败：{error}"
        if result.get("ok"):
            return "已请求中断当前 DSH 任务。中断生效后桥接层会推送结果，你可以告诉用户任务已停止。"
        return result.get("reason") or "当前没有正在执行的任务。"

    @filter.llm_tool(name="continue_dsh_task")
    async def continue_dsh_task(self, event: AstrMessageEvent, note: str) -> str:
        """继续执行上一次被中断的 DSH 任务。
        当用户要求继续、接着做、恢复刚才中断的任务时调用。

        Args:
            note(string): 继续时的补充说明，可以为空字符串。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        prompt = "请继续完成刚才被中断的任务，从上次中断的位置接着做，完成后汇报结果。"
        if note and note.strip():
            prompt += "\n补充说明：" + note.strip()
        try:
            result = await self._bridge("POST", "/task", {
                "prompt": prompt,
                "umo": self._report_umo(event),
                "fileUmo": event.unified_msg_origin if event.get_message_type() == MessageType.GROUP_MESSAGE else "",
            })
        except Exception as error:
            logger.error(f"dsh_bridge 继续任务失败: {error}")
            return f"继续任务失败：{error}"
        return (
            f"已提交继续指令（任务编号 {result['taskId']}）。"
            "现在请立即向用户回一句简短自然的回执，说明任务已继续，然后停下，不要调用其他工具。"
        )

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

    @filter.on_llm_request()
    async def on_llm_request(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        if not self._allowed(event):
            return
        extra = (
            "\n\nDSH 桥接规则：\n"
            "1. 通过 run_dsh_task 提交的任务，执行结果和产物文件会由桥接层自动发送给用户，"
            "不要调用 send_message_to_user 发送 DSH 的结果或文件。\n"
            "2. 不要主动调用 ask_dsh_progress 确认任务状态，除非用户明确询问进度。\n"
            "3. 提交任务后必须向用户回一句简短自然的话，说明任务已转交，并把发给 DSH 的提示词附上。"
            "回执用你自己的话组织，不要用固定模板。\n"
            "4. 需要在本机执行文件读写、改代码、运行命令、批量处理等实际操作时，必须调用 run_dsh_task "
            "交给 DSH 执行，不要使用 AstrBot 自带的文件、命令或代码工具；"
            "本插件提供的 send_workspace_file、read_workspace_file 等工具可以直接使用。"
            "简单问答、闲聊、知识查询不需要调用。\n"
            "5. DSH 执行任务时遇到越权操作（工作区外读写、需要提权的命令）会自动向管理员发起审批，"
            "审批结果由管理员在 QQ 里亲自决定。你不应代替它决定，也不需要向用户解释审批细节。\n"
            f"6. DSH 只给最高管理员（QQ {self._admin_qq}）使用。其他人询问 DSH、要求用 DSH 做事、"
            "或者让你操作电脑、写文件、跑命令时，必须明确拒绝，不要答应，也不要向他们介绍 DSH 的能力。"
            "拒绝时用普通聊天的语气，不要说教，也不要说'可以'或'我交给它弄'。\n"
            f"7. 用户提到“工作区”“当前目录”或让 DSH 处理某个文件时，默认指 DSH 工作区：{self._workspace}。"
            "调用 run_dsh_task 时不要把目标目录改写成 AstrBot 自己的平台工作区路径；"
            "用户没有给绝对路径时，按 DSH 工作区内的相对路径描述任务。\n"
            "8. 读取 DSH 工作区内的文件必须使用本插件的 read_workspace_file 工具，"
            "发送 DSH 工作区内的文件必须使用本插件的 send_workspace_file 工具；"
            "不要使用 astrbot_file_read_tool、astrbot_file_write_tool 等 AstrBot 自带文件工具处理 DSH 工作区。\n"
        )
        extra += self._recent_sent_note()
        req.system_prompt = (req.system_prompt or "") + extra

    @filter.llm_tool(name="list_dsh_sessions")
    async def list_dsh_sessions(self, event: AstrMessageEvent) -> str:
        """列出所有 DSH 会话，包括机器人发起的和用户在 Web 里发起的。
        当用户询问有哪些会话、查看会话列表、想操作某个会话时调用。
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        try:
            result = await self._bridge("GET", "/sessions")
        except Exception as error:
            return f"获取会话列表失败：{error}"
        sessions = result.get("sessions", [])
        if not sessions:
            return "当前没有任何 DSH 会话。"
        lines = [f"共 {len(sessions)} 个会话（按最近活动排序）："]
        for item in sessions[:20]:
            title = item.get("title") or "（无标题）"
            cwd = item.get("cwd") or ""
            tags = []
            if item.get("archived"):
                tags.append("已归档")
            if item.get("pinned"):
                tags.append("置顶")
            if item.get("blank"):
                tags.append("空白")
            if item.get("running"):
                tags.append("运行中")
            status = "、".join(tags) if tags else "正常"
            lines.append(f"- {item['sessionId']}｜{status}｜{title}｜{cwd}")
        return "\n".join(lines)

    @filter.llm_tool(name="operate_dsh_session")
    async def operate_dsh_session(self, event: AstrMessageEvent, session_id: str, action: str, prompt: str) -> str:
        """操作指定的 DSH 会话：继续（prompt）或中断（cancel）。
        当用户要求继续某个会话、或中断某个会话时调用。
        被 Web 页面占用中的会话无法操作，会返回失败原因。

        Args:
            session_id(string): 会话 ID，来自会话列表
            action(string): prompt 或 cancel
            prompt(string): action 为 prompt 时要发送的内容，可以为空
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        try:
            result = await self._bridge("POST", "/sessions/operate", {
                "sessionId": session_id,
                "action": action,
                "prompt": prompt or "",
            })
        except Exception as error:
            return f"操作会话失败：{error}"
        if result.get("ok"):
            return f"已对会话 {session_id} 执行 {action}。"
        return result.get("error") or "操作失败。"

    @filter.on_astrbot_loaded()
    async def on_loaded(self) -> None:
        self._load_sent_history()
        await self._load_settings()
        self._poll_task = asyncio.create_task(self._poll_reports())
        asyncio.create_task(self._poll_approvals())
        logger.info("dsh_bridge 报告轮询已启动")
        if self._sent_history:
            logger.info(f"dsh_bridge 已加载 {len(self._sent_history)} 条发送记录")

    async def _poll_approvals(self) -> None:
        while True:
            try:
                data = await self._bridge("GET", "/approvals/pending")
                approvals = data.get("pending", [])
                if not approvals:
                    self._pending_approval_id = None
                elif not self._pending_approval_id:
                    item = approvals[0]
                    tool = item.get("toolName") or "未知工具"
                    reason = item.get("reason") or "（无说明）"
                    text = (
                        "DSH 请求提升权限\n"
                        f"工具：{tool}\n"
                        f"原因：{reason}\n\n"
                        "回复「允许」或「拒绝」，超时自动拒绝。"
                    )
                    umo = f"napcat:FriendMessage:{self._admin_qq}"
                    sent = await self._send_chunked(umo, text)
                    if sent:
                        self._pending_approval_id = item["id"]
                        logger.info(f"dsh_bridge 已推送审批请求 {item['id']}")
                    else:
                        logger.warning("dsh_bridge 审批请求发送失败，稍后重试")
            except Exception as error:
                logger.warning(f"dsh_bridge 拉取审批请求失败: {error}")
            await asyncio.sleep(2)

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_approval_reply(self, event: AstrMessageEvent) -> None:
        if not self._allowed(event):
            return
        if event.get_message_type() != MessageType.FRIEND_MESSAGE:
            return
        text = (event.message_str or "").strip()
        if not text or len(text) > 10:
            return
        is_allow = text in APPROVAL_ALLOW_WORDS
        is_deny = text in APPROVAL_DENY_WORDS
        if not is_allow and not is_deny:
            return
        approval_id = self._pending_approval_id
        if not approval_id:
            return
        event.stop_event()
        decision = "allow" if is_allow else "reject"
        try:
            await self._bridge("POST", "/approval/answer", {"id": approval_id, "decision": decision})
            self._pending_approval_id = None
            label = "允许" if is_allow else "拒绝"
            await self.context.send_message(event.unified_msg_origin, MessageChain([Plain(f"审批已提交：{label}")]))
            logger.info(f"dsh_bridge 审批 {approval_id} 已提交: {decision}")
        except Exception as error:
            logger.warning(f"dsh_bridge 提交审批失败: {error}")
            await self.context.send_message(event.unified_msg_origin, MessageChain([Plain(f"审批提交失败：{error}")]))

    async def _poll_reports(self) -> None:
        while True:
            try:
                data = await self._bridge("GET", "/reports")
                reports = data.get("reports", [])
                if reports:
                    acked = []
                    for item in reports:
                        umo = item.get("umo") or f"napcat:FriendMessage:{self._admin_qq}"
                        file_umo = item.get("fileUmo") or umo
                        title = str(item.get("sessionTitle") or "")
                        text = item.get("text") or ""
                        if title:
                            text = f"（转发自DSH会话：{title}）\n\n{text}"
                        ok = await self._send_chunked(umo, text)
                        if ok:
                            ok = await self._send_files(file_umo, item.get("files") or [])
                        if ok:
                            acked.append(item["taskId"])
                            await self._record_sent({
                                "time": self._now(),
                                "taskId": item.get("taskId") or "",
                                "sessionTitle": title,
                                "umo": umo,
                                "text": text,
                                "files": item.get("files") or [],
                            })
                    if acked:
                        await self._bridge("POST", "/reports/ack", {"taskIds": acked})
                        logger.info(f"dsh_bridge 已推送 {len(acked)} 条结果")
            except Exception as error:
                logger.warning(f"dsh_bridge 拉取报告失败: {error}")
            await asyncio.sleep(3)

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
