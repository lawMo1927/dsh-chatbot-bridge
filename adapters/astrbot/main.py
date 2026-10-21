import asyncio
import json
import os
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
APPROVAL_ALLOW_WORDS = {"允许", "同意", "allow", "yes", "ok", "可以", "好"}
APPROVAL_DENY_WORDS = {"拒绝", "不同意", "deny", "no", "不行", "不要"}


class Main(star.Star):
    def __init__(self, context: star.Context) -> None:
        self.context = context
        self._poll_task = None
        self._pending_approval_id = None
        self._admin_qq = ""
        self._workspace = ""

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
        with urllib.request.urlopen(request, timeout=40) as response:
            return json.loads(response.read().decode("utf-8"))

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
        if status == "completed":
            return result.get("reply") or "任务已完成，结果和文件已自动发送给用户。"
        if status == "answered":
            return result.get("reply") or "DSH 没有返回内容。"
        if status == "timeout":
            reply = result.get("reply")
            if reply:
                return f"DSH 暂时没有回应，最近的输出是：{reply}"
            return "DSH 暂时没有回应，可能正在执行较长的步骤，稍后再问一次。"
        return "已把询问发给 DSH。"

    def _resolve_workspace_file(self, file_name: str):
        root = os.path.realpath(self._workspace)
        candidate = os.path.realpath(os.path.join(self._workspace, file_name.strip()))
        if candidate != root and not candidate.startswith(root + os.sep):
            return "只能访问工作区内的文件。"
        if not os.path.isfile(candidate):
            return f"工作区里没有这个文件：{file_name}"
        return candidate

    @filter.llm_tool(name="send_workspace_file")
    async def send_workspace_file(self, event: AstrMessageEvent, file_name: str) -> str:
        """把工作区里已有的文件直接发给用户。
        当用户要求发送、给我、发一份工作区内的文件时调用。

        Args:
            file_name(string): 工作区内的文件名或相对路径，例如 notes.txt
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        target = self._resolve_workspace_file(file_name)
        if isinstance(target, str):
            return target
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
        return f"已发送 {os.path.basename(target)}（{size} 字节）。"

    @filter.llm_tool(name="read_workspace_file")
    async def read_workspace_file(self, event: AstrMessageEvent, file_name: str) -> str:
        """读取工作区内文本文件的内容。
        当用户询问工作区里某个文件写了什么、想看文件内容时调用。
        二进制文件或过大的文件会拒绝。

        Args:
            file_name(string): 工作区内的文件名或相对路径，例如 notes.txt
        """
        if not self._allowed(event):
            return "这个功能仅限管理员使用。"
        target = self._resolve_workspace_file(file_name)
        if isinstance(target, str):
            return target
        if os.path.getsize(target) > 1024 * 1024:
            return "文件超过 1MB，改用发送文件的方式查看。"
        try:
            with open(target, "rb") as handle:
                raw = handle.read()
        except Exception as error:
            return f"读取失败：{error}"
        if b"\x00" in raw[:4096]:
            return "这是二进制文件，内容无法直接展示，可以用发送文件的方式获取。"
        text = raw.decode("utf-8", errors="replace")
        if len(text) > 8000:
            text = text[:8000] + "\n……（内容过长已截断）"
        return text

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
            "4. DSH 执行任务时遇到越权操作（工作区外读写、需要提权的命令）会自动向管理员发起审批，"
            "审批结果由管理员在 QQ 里亲自决定。你不应代替它决定，也不需要向用户解释审批细节。\n"
            f"5. DSH 只给最高管理员（QQ {self._admin_qq}）使用。其他人询问 DSH、要求用 DSH 做事、"
            "或者让你操作电脑、写文件、跑命令时，必须明确拒绝，不要答应，也不要向他们介绍 DSH 的能力。"
            "拒绝时用普通聊天的语气，不要说教，也不要说'可以'或'我交给它弄'。\n"
        )
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
        await self._load_settings()
        self._poll_task = asyncio.create_task(self._poll_reports())
        asyncio.create_task(self._poll_approvals())
        logger.info("dsh_bridge 报告轮询已启动")

    async def _poll_approvals(self) -> None:
        while True:
            try:
                data = await self._bridge("GET", "/approvals/pending")
                approvals = data.get("approvals", [])
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
                        "回复「允许」或「拒绝」，3 分钟内有效，超时自动拒绝。"
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
