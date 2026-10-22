// DSH 聊天机器人桥接插件：在 DSH 进程内提供任务派发、结果回传、审批与聊天机器人管理
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { TaskManager } from './tasks.js';
import { ensureConfigDirs, getConfigFile, loadConfig } from './config.js';

export const name = 'dsh-chatbot-bridge';
export const inject = ['sessionController', 'sessions', 'agents', 'approval', 'workspaceRegistry'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createLogger(logFile) {
    return (message) => {
        const line = `[${new Date().toISOString()}] ${message}`;
        console.log(`[chatbot-bridge] ${message}`);
        try {
            fs.appendFileSync(logFile, line + '\n', 'utf8');
        } catch (error) {
            // 日志文件不可写时忽略
        }
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total > 1_000_000) {
                reject(new Error('请求体过大'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(payload));
}

const MAX_BRIDGE_EVENTS = 500;
const MAX_RECENT_TOOL_CALLS = 500;
const MAX_APPROVAL_HISTORY = 100;
const MAX_EVENT_TEXT_CHARS = 4000;
const MAX_MESSAGE_TEXT_CHARS = 8000;
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
// 桥接自己提交提示词时使用的 requestId 前缀，用于区分机器人提示词与真人提示词
const QQ_REQUEST_PREFIX = 'qq-req-';

function truncateText(value, max) {
    const text = value === null || value === undefined ? '' : String(value);
    return text.length > max ? `${text.slice(0, max)}……（已截断）` : text;
}

function messageText(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const parts = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block.type === 'image') parts.push('（图片）');
        else if (block.type === 'file') parts.push('（文件）');
        else if (block.type === 'tool-call') parts.push(`（调用工具 ${block.name || '未知工具'}）`);
    }
    return parts.join('').trim();
}

// 只保留自然语言与附件占位，用于会话历史；工具调用和工具结果走事件流
function naturalMessageText(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const parts = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block.type === 'image') parts.push('（图片）');
        else if (block.type === 'file') parts.push('（文件）');
    }
    return parts.join('').trim();
}

function classifyUserSource(source) {
    if (!source || typeof source !== 'object') return 'human';
    if (typeof source.rpcId === 'string' && source.rpcId) {
        return source.rpcId.startsWith(QQ_REQUEST_PREFIX) ? 'bot' : 'human';
    }
    return source.kind === 'user' ? 'human' : 'system';
}

// 把会话原始事件压缩成增量事件流里的紧凑形状
function summarizeSessionEvent(event) {
    const data = event.data || {};
    if (event.type === 'user/message') {
        const message = data.message || data;
        const source = classifyUserSource(message.source);
        return {
            type: 'user/message',
            data: {
                role: 'user',
                source,
                kind: source === 'system' ? 'status' : 'prompt',
                text: truncateText(messageText(message), MAX_EVENT_TEXT_CHARS)
            }
        };
    }
    if (event.type === 'assistant/message') {
        return {
            type: 'assistant/message',
            data: {
                role: 'assistant',
                source: 'dsh',
                kind: 'text',
                text: truncateText(naturalMessageText(data.message), MAX_EVENT_TEXT_CHARS),
                turn: data.turn,
                step: data.step
            }
        };
    }
    if (event.type === 'tool/call') {
        return {
            type: 'tool/call',
            data: {
                text: `调用工具 ${data.name || '未知工具'}`,
                toolName: data.name || '',
                callId: data.callId ? String(data.callId) : null,
                command: truncateText(data.arguments, MAX_EVENT_TEXT_CHARS)
            }
        };
    }
    if (event.type === 'tool/result') {
        const failed = Boolean(data.message && data.message.isError);
        return {
            type: 'tool/result',
            data: {
                text: failed ? '工具执行失败' : '工具执行结果已返回',
                callId: data.message && data.message.toolCallId ? String(data.message.toolCallId) : null,
                isError: failed
            }
        };
    }
    if (event.type === 'turn/start') {
        return { type: 'turn/start', data: { text: '回合开始', turn: data.turn } };
    }
    if (event.type === 'turn/end') {
        return {
            type: 'turn/end',
            data: { text: '回合结束', turn: data.turn, reason: (data.reason && data.reason.kind) || 'completed' }
        };
    }
    if (event.type === 'step/start') {
        return {
            type: 'step/start',
            data: {
                text: `第 ${data.turn} 回合第 ${data.step} 步`,
                turn: data.turn,
                step: data.step,
                phase: `第 ${data.turn} 回合第 ${data.step} 步`
            }
        };
    }
    if (event.type === 'approval/asked') {
        return {
            type: 'approval/asked',
            data: {
                text: '等待审批',
                toolName: data.toolName || '',
                approvalId: data.id ? String(data.id) : null,
                reason: data.reason || ''
            }
        };
    }
    if (event.type === 'approval/decided') {
        return {
            type: 'approval/decided',
            data: { text: '审批已结束', approvalId: data.id ? String(data.id) : null, outcome: data.outcome || '' }
        };
    }
    if (event.type === 'session/title') {
        return { type: 'session/title', data: { text: data.title || '', title: data.title || '' } };
    }
    return null;
}

// 把会话历史记录转换成双方自然语言消息条目；工具记录由 /events 提供
function historyMessage(record) {
    const event = record && record.event ? record.event : null;
    if (!event || !Number.isInteger(event.seq)) return null;
    const data = event.data || {};
    if (event.type === 'user/message') {
        const message = data.message || data;
        const source = classifyUserSource(message.source);
        if (source === 'system') return null;
        const text = naturalMessageText(message);
        if (!text) return null;
        return {
            seq: event.seq,
            time: event.time,
            role: 'user',
            source,
            kind: 'prompt',
            text: truncateText(text, MAX_MESSAGE_TEXT_CHARS)
        };
    }
    if (event.type === 'assistant/message') {
        const text = naturalMessageText(data.message);
        if (!text) return null;
        return {
            seq: event.seq,
            time: event.time,
            role: 'assistant',
            source: 'dsh',
            kind: 'text',
            text: truncateText(text, MAX_MESSAGE_TEXT_CHARS)
        };
    }
    return null;
}

function isSessionNotFoundError(error) {
    if (!error) return false;
    if (error.code === 'session/not-found' || error.code === 'subagent/not-found') return true;
    return /session ["'][^"']*["'] not found/.test(String(error.message || ''));
}

export function apply(ctx, pluginConfig) {
    const config = { ...loadConfig(), ...(pluginConfig || {}) };
    ensureConfigDirs(config);
    const log = createLogger(config.logFile);
    const manager = new TaskManager(config.workspace);
    const pendingApprovals = new Map();
    const approvalHistory = [];
    const recentToolCalls = new Map();
    const bridgeEvents = [];
    const eventStreams = new Set();
    // sessionId -> 当前打开的回合号，用于把追加指令绑定到正确的回合
    const openTurns = new Map();
    let bridgeEventSeq = 0;
    let approvalSeq = 1;
    let shuttingDown = false;
    let sessionReady = null;
    let spawnState = { astrbot: null };

    function recordBridgeEvent(sessionId, type, data, taskId) {
        bridgeEventSeq += 1;
        const event = {
            seq: bridgeEventSeq,
            time: Date.now(),
            sessionId: sessionId || null,
            taskId: taskId || null,
            type,
            data: data || {}
        };
        bridgeEvents.push(event);
        if (bridgeEvents.length > MAX_BRIDGE_EVENTS) {
            bridgeEvents.splice(0, bridgeEvents.length - MAX_BRIDGE_EVENTS);
        }
        broadcastBridgeEvent(event);
    }

    function recordTaskEvent(type, task, extra) {
        if (!task) return;
        recordBridgeEvent(task.sessionId, type, {
            status: task.status,
            phase: task.phase,
            durationMs: task.durationMs,
            error: task.error || null,
            ...(extra || {})
        }, task.id);
    }

    // 会话事件只有属于本任务自己的回合时才标注 taskId，避免把别的回合算到任务头上
    function activeTaskIdFor(sessionId) {
        const taskId = manager.currentTaskFor(sessionId);
        if (!taskId) return null;
        const task = manager.getTask(taskId);
        if (!task || task.status !== 'running' || task.awaitTurnStart) return null;
        return taskId;
    }

    function rememberToolCall(sessionId, event) {
        const callId = event.data && event.data.callId ? String(event.data.callId) : '';
        if (!callId) return;
        recentToolCalls.set(callId, {
            sessionId,
            name: String((event.data && event.data.name) || ''),
            arguments: String((event.data && event.data.arguments) || '')
        });
        while (recentToolCalls.size > MAX_RECENT_TOOL_CALLS) {
            const oldest = recentToolCalls.keys().next().value;
            recentToolCalls.delete(oldest);
        }
    }

    // 从审批请求里尽量提取会话编号；不同形态的宿主对象可能给出不同字段
    function extractApprovalSessionId(req) {
        if (!req) return null;
        const agent = req.agent;
        const candidates = [
            agent && agent.session && agent.session.id,
            agent && agent.sessionId,
            req.sessionId,
            agent && agent.id
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate) return candidate;
        }
        return null;
    }

    function approvalContext(req) {
        const sessionId = extractApprovalSessionId(req);
        const taskId = sessionId ? manager.currentTaskFor(sessionId) : null;
        const callId = req && req.callId ? String(req.callId) : '';
        const call = callId ? recentToolCalls.get(callId) : null;
        return {
            sessionId,
            taskId,
            command: call ? call.arguments : null
        };
    }

    // 只接管桥接默认会话与桥接提交过任务的会话，其它会话的审批交回页面通道
    function isManagedApprovalSession(sessionId) {
        if (!sessionId) return false;
        if (manager.sessionId && sessionId === manager.sessionId) return true;
        return manager.listTasks({ sessionId, limit: 1 }).length > 0;
    }

    function pendingApprovalView(item) {
        return {
            id: item.id,
            toolName: item.toolName,
            reason: item.reason,
            callId: item.callId,
            sessionId: item.sessionId,
            taskId: item.taskId,
            command: item.command,
            createdAt: item.createdAt
        };
    }

    function approvalHistoryView(record) {
        return {
            id: record.id,
            toolName: record.toolName,
            reason: record.reason,
            callId: record.callId,
            sessionId: record.sessionId,
            taskId: record.taskId,
            command: record.command,
            createdAt: record.createdAt,
            decidedAt: record.decidedAt,
            outcome: record.outcome,
            status: record.status
        };
    }

    function beginApprovalHistory(entry) {
        const record = {
            id: entry.id,
            toolName: entry.toolName,
            reason: entry.reason,
            callId: entry.callId,
            sessionId: entry.sessionId,
            taskId: entry.taskId,
            command: entry.command,
            createdAt: entry.createdAt,
            decidedAt: null,
            outcome: null,
            status: 'pending'
        };
        approvalHistory.push(record);
        if (approvalHistory.length > MAX_APPROVAL_HISTORY) {
            approvalHistory.splice(0, approvalHistory.length - MAX_APPROVAL_HISTORY);
        }
        return record;
    }

    function endApprovalHistory(record, status, outcome) {
        if (!record) return;
        record.status = status;
        record.outcome = outcome;
        record.decidedAt = new Date().toISOString();
    }

    function normalizeApprovalOutcome(outcome) {
        if (outcome === 'allow' || outcome === 'allowed-once') return 'allowed-once';
        if (outcome === 'deny' || outcome === 'rejected') return 'rejected';
        if (outcome === 'cancelled') return 'cancelled';
        return 'unavailable';
    }

    // SSE 订阅：eventStreams 里的连接按 sessionId 过滤接收增量事件
    function writeEventStream(stream, event) {
        if (stream.closed || stream.res.writableEnded) return;
        if (stream.res.writableLength > MAX_SSE_BUFFER_BYTES) {
            log(`事件订阅积压超过上限，断开连接 session=${stream.sessionId || '全部'}`);
            closeEventStream(stream);
            return;
        }
        try {
            stream.res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (error) {
            closeEventStream(stream);
        }
    }

    function closeEventStream(stream) {
        if (!stream || stream.closed) return;
        stream.closed = true;
        clearInterval(stream.heartbeat);
        eventStreams.delete(stream);
        try {
            stream.res.end();
        } catch (error) {
            // 连接已经断开，无需再处理
        }
    }

    function closeAllEventStreams() {
        for (const stream of Array.from(eventStreams)) {
            closeEventStream(stream);
        }
    }

    function broadcastBridgeEvent(event) {
        for (const stream of Array.from(eventStreams)) {
            if (stream.sessionId && event.sessionId !== stream.sessionId) continue;
            writeEventStream(stream, event);
        }
    }

    function openEventStream(req, res, sessionId, sinceSeq) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no'
        });
        res.write(': connected\n\n');
        const stream = { res, sessionId, closed: false, heartbeat: null };
        stream.heartbeat = setInterval(() => {
            if (stream.closed || res.writableEnded) {
                closeEventStream(stream);
                return;
            }
            try {
                res.write(': ping\n\n');
            } catch (error) {
                closeEventStream(stream);
            }
        }, SSE_HEARTBEAT_MS);
        eventStreams.add(stream);
        for (const event of bridgeEvents) {
            if (event.seq <= sinceSeq) continue;
            if (sessionId && event.sessionId !== sessionId) continue;
            writeEventStream(stream, event);
        }
        const close = () => closeEventStream(stream);
        req.on('close', close);
        req.on('error', close);
        res.on('close', close);
        log(`事件订阅已建立 session=${sessionId || '全部'} sinceSeq=${sinceSeq} 订阅数=${eventStreams.size}`);
    }

    function clampLimit(raw, fallback) {
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) return fallback;
        return Math.min(Math.max(Math.trunc(value), 1), 100);
    }

    function finishedReportText(task) {
        if (task.status === 'cancelled') return task.error || '任务被中断';
        if (task.status === 'failed') return `任务执行失败：${task.error || '未知错误'}`;
        return '任务已完成，结果已加入报告队列';
    }

    function finishTaskById(taskId, options) {
        const finished = manager.finishTask(taskId, options);
        if (!finished) return null;
        const report = manager.reportForTask(finished.id);
        recordTaskEvent('task/finished', finished, { text: finishedReportText(finished) });
        recordBridgeEvent(finished.sessionId, 'report/created', {
            text: '任务结果已加入报告队列',
            files: report ? report.files.length : 0,
            sessionTitle: report ? report.sessionTitle : ''
        }, finished.id);
        log(`任务 ${finished.id} 结束 status=${finished.status} duration=${finished.durationMs === null ? '-' : finished.durationMs + 'ms'}`);
        setImmediate(pumpQueue);
        return finished;
    }

    function finishSessionTask(sessionId, options) {
        const taskId = manager.currentTaskFor(sessionId);
        if (!taskId) return null;
        return finishTaskById(taskId, options);
    }

    function turnEndOutcome(event) {
        const reason = event.data && event.data.reason ? event.data.reason : null;
        const kind = reason && reason.kind ? reason.kind : 'completed';
        if (kind === 'error') {
            const failure = reason.error && (reason.error.message || reason.error.code);
            return { error: failure ? String(failure) : '回合异常结束' };
        }
        if (kind === 'aborted') return { cancelled: true, error: '任务被中断' };
        if (kind === 'blocked') return { error: '回合被阻塞' };
        return {};
    }

    function handleTurnStart(sessionId, event) {
        const turn = event.data && Number.isInteger(event.data.turn) ? event.data.turn : null;
        if (turn === null) return;
        openTurns.set(sessionId, turn);
        const taskId = manager.currentTaskFor(sessionId);
        if (taskId) manager.bindTurn(taskId, turn);
    }

    function handleTurnEnd(sessionId, event) {
        const turn = event.data && Number.isInteger(event.data.turn) ? event.data.turn : null;
        if (turn !== null && openTurns.get(sessionId) === turn) openTurns.delete(sessionId);
        const taskId = manager.currentTaskFor(sessionId);
        if (!taskId) return;
        const task = manager.getTask(taskId);
        if (!task) return;
        // 排队提交的任务还没等到自己的回合，这一轮的结束不算它的结果
        if (task.awaitTurnStart) return;
        if (task.turnNumber !== null && turn !== null && task.turnNumber !== turn) return;
        finishTaskById(taskId, turnEndOutcome(event));
    }

    function handleSessionEvent(session, event) {
        if (!event || typeof event.type !== 'string') return;
        const sessionId = (session && (session.id || (session.header && session.header.id))) || null;
        if (!sessionId) return;
        const eventTaskId = activeTaskIdFor(sessionId);

        if (event.type === 'tool/call') rememberToolCall(sessionId, event);
        if (event.type === 'assistant/message') {
            if (eventTaskId) manager.recordAssistantText(sessionId, messageText(event.data && event.data.message));
            manager.recordPhase(eventTaskId, '生成回复');
        }
        if (event.type === 'step/start') {
            const data = event.data || {};
            manager.recordPhase(eventTaskId, `第 ${data.turn} 回合第 ${data.step} 步`);
        }
        if (event.type === 'tool/call') {
            manager.recordPhase(eventTaskId, `调用工具 ${(event.data && event.data.name) || '未知工具'}`);
        }
        if (event.type === 'tool/result') {
            manager.recordPhase(eventTaskId, '处理工具结果');
        }
        if (event.type === 'session/title') {
            manager.recordSessionTitle(sessionId, event.data && event.data.title);
        }
        if (event.type === 'turn/start') handleTurnStart(sessionId, event);
        if (event.type === 'turn/end') handleTurnEnd(sessionId, event);

        const summary = summarizeSessionEvent(event);
        if (summary) {
            recordBridgeEvent(sessionId, summary.type, summary.data, activeTaskIdFor(sessionId) || eventTaskId);
        }
    }

    function loadState() {
        try {
            return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
        } catch (error) {
            return {};
        }
    }

    function saveState(state) {
        fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2), 'utf8');
    }

    async function resumeSession(sessionId) {
        const presets = ctx.get('agentPresets');
        const resolvedId = presets ? (await presets.resolve(undefined)).id : undefined;
        const setup = async (agentCtx) => {
            if (presets && resolvedId) {
                await presets.mount(agentCtx, resolvedId);
            }
        };
        await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: { provider: config.provider, model: config.model },
            setup
        });
    }

    function workspaceFor(cwd) {
        try {
            const list = ctx.workspaceRegistry.list();
            for (const ws of list) {
                if (ws.path && path.resolve(ws.path) === path.resolve(cwd)) return ws;
            }
        } catch (error) {
            log(`读取工作区列表失败: ${error.message}`);
        }
        return null;
    }

    async function attachWorkspace(sessionId) {
        const ws = workspaceFor(config.workspace);
        if (!ws) return;
        try {
            await ws.attachSession(sessionId);
            log(`会话 ${sessionId} 已归入工作区 ${ws.path}`);
        } catch (error) {
            log(`会话归入工作区失败: ${error.message}`);
        }
    }

    async function ensureSession() {
        if (sessionReady) return sessionReady;
        sessionReady = (async () => {
            const state = loadState();
            if (state.sessionId) {
                const live = ctx.sessions.get(state.sessionId);
                if (live) {
                    manager.setSession(state.sessionId);
                    await attachWorkspace(state.sessionId);
                    log(`恢复已有会话: ${state.sessionId}`);
                    return state.sessionId;
                }
                try {
                    await resumeSession(state.sessionId);
                    manager.setSession(state.sessionId);
                    await attachWorkspace(state.sessionId);
                    log(`恢复历史会话: ${state.sessionId}`);
                    return state.sessionId;
                } catch (error) {
                    log(`恢复会话失败，将新建: ${error.message}`);
                }
            }
            const created = await ctx.sessionController.create({ cwd: config.workspace });
            saveState({ sessionId: created.sessionId });
            manager.setSession(created.sessionId);
            await attachWorkspace(created.sessionId);
            try {
                await ctx.sessionController.rename({ sessionId: created.sessionId, title: 'QQ 桥接会话' });
            } catch (error) {
                log(`设置会话标题失败: ${error.message}`);
            }
            log(`新建会话: ${created.sessionId}`);
            return created.sessionId;
        })();
        return sessionReady;
    }

    async function submitPrompt(sessionId, text, mode) {
        const requestId = `${QQ_REQUEST_PREFIX}${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const controller = new AbortController();
        await ctx.sessionController.prompt({
            requestId,
            sessionId,
            mode: mode || 'queue',
            content: [{ type: 'text', text }]
        }, controller.signal);
        return { sessionId, requestId };
    }

    function pumpQueue() {
        while (true) {
            const task = manager.nextStartable();
            if (!task) return;
            try {
                manager.markRunning(task.id);
            } catch (error) {
                log(`任务 ${task.id} 启动失败: ${error.message}`);
                finishTaskById(task.id, { error: `任务启动失败：${error.message}` });
                continue;
            }
            recordTaskEvent('task/started', task, { text: '任务开始执行' });
            log(`任务 ${task.id} 已提交 session=${task.sessionId}`);
            submitPrompt(task.sessionId, task.prompt, 'queue')
                .then(() => {
                    log(`任务 ${task.id} 已进入会话 ${task.sessionId}`);
                })
                .catch((error) => {
                    log(`任务 ${task.id} 提交失败: ${error.message}`);
                    finishTaskById(task.id, { error: `任务提交失败：${error.message}` });
                });
        }
    }

    const eventDisposer = ctx.on('session/event', (session, event) => {
        handleSessionEvent(session, event);
    });
    ctx.effect(() => eventDisposer);

    const NEVER = new Promise(() => {});

    const approvalDisposer = ctx.on('approval/request', async (req, next) => {
        const context = approvalContext(req);
        if (!isManagedApprovalSession(context.sessionId)) {
            log(`审批请求不属于桥接管理的会话，交回页面通道 session=${context.sessionId || '-'} tool=${req.toolName || '-'}`);
            return next();
        }
        const id = `approval_${Date.now()}_${approvalSeq++}`;
        log(`收到审批请求 ${id}: tool=${req.toolName} reason=${req.reason} session=${context.sessionId}`);

        const pagePromise = next().then(
            (outcome) => {
                if (outcome === 'unavailable' || outcome === undefined || outcome === null) {
                    return NEVER;
                }
                log(`审批 ${id} 页面已应答: ${outcome}`);
                return outcome;
            },
            (error) => {
                log(`审批 ${id} 页面通道异常: ${error && error.message ? error.message : String(error)}`);
                return NEVER;
            }
        );

        let entry = null;
        let historyRecord = null;
        const qqPromise = new Promise((resolve) => {
            let timer = null;
            entry = {
                id,
                toolName: String(req.toolName || ''),
                reason: String(req.reason || ''),
                callId: req.callId ? String(req.callId) : '',
                sessionId: context.sessionId,
                taskId: context.taskId,
                command: context.command,
                createdAt: new Date().toISOString(),
                timedOut: false,
                resolve: (value) => {
                    if (timer) clearTimeout(timer);
                    pendingApprovals.delete(id);
                    resolve(value);
                }
            };
            timer = setTimeout(() => {
                entry.timedOut = true;
                pendingApprovals.delete(id);
                resolve('rejected');
            }, config.approvalTimeoutSeconds * 1000);
            pendingApprovals.set(id, entry);
            historyRecord = beginApprovalHistory(entry);
            recordBridgeEvent(entry.sessionId, 'approval/pending', {
                text: '等待审批',
                toolName: entry.toolName,
                reason: entry.reason,
                command: truncateText(entry.command, MAX_EVENT_TEXT_CHARS),
                approvalId: id
            }, entry.taskId);
        });

        const outcome = await Promise.race([pagePromise, qqPromise]);
        pendingApprovals.delete(id);
        const normalizedOutcome = normalizeApprovalOutcome(outcome);
        const timedOut = Boolean(entry && entry.timedOut);
        endApprovalHistory(historyRecord, timedOut ? 'timeout' : 'decided', normalizedOutcome);
        recordBridgeEvent(context.sessionId, 'approval/decided', {
            text: timedOut ? '审批超时自动拒绝' : '审批已结束',
            approvalId: id,
            outcome: normalizedOutcome,
            status: timedOut ? 'timeout' : 'decided',
            allowed: normalizedOutcome === 'allowed-once'
        }, context.taskId);
        log(`审批 ${id} 结果: ${outcome}${timedOut ? '（超时）' : ''}`);
        return normalizedOutcome === 'allowed-once' ? 'allowed-once' : 'rejected';
    }, { prepend: true });
    ctx.effect(() => approvalDisposer);

    const timeoutTimer = setInterval(async () => {
        for (const task of manager.runningTasks()) {
            if (!task.startedAtMs) continue;
            if (Date.now() - task.startedAtMs <= config.taskTimeoutMinutes * 60_000) continue;
            log(`任务 ${task.id} 超时，标记失败`);
            try {
                await ctx.sessionController.cancel({ sessionId: task.sessionId });
            } catch (error) {
                log(`任务 ${task.id} 超时后中断会话失败: ${error.message}`);
            }
            finishTaskById(task.id, { error: `任务超时（${config.taskTimeoutMinutes} 分钟）` });
        }
    }, 30_000);
    ctx.effect(() => () => clearInterval(timeoutTimer));

    function sessionTitle(sessionId) {
        try {
            const file = path.join(config.dshHome, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
            if (!fs.existsSync(file)) return '';
            const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
            return String(cache.record?.rows?.title?.val || '').slice(0, 60);
        } catch (error) {
            return '';
        }
    }

    function workspaceFlags() {
        try {
            const file = path.join(config.dshHome, 'storages', 'workspace.json');
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return {
                archived: new Set(data.global?.archivedSessionIds || []),
                pinned: new Set(data.global?.pinnedSessionIds || [])
            };
        } catch (error) {
            return { archived: new Set(), pinned: new Set() };
        }
    }

    function approvalSessionIds() {
        const ids = new Set();
        for (const item of pendingApprovals.values()) {
            if (item.sessionId) ids.add(item.sessionId);
        }
        return ids;
    }

    async function listSessions() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const value = await ctx.sessionController.list({}, controller.signal);
            const flags = workspaceFlags();
            const waiting = approvalSessionIds();
            const items = (value.items || [])
                .filter((item) => !item.parentSessionId && item.origin !== 'subagent')
                .map((item) => ({
                    sessionId: item.sessionId,
                    title: sessionTitle(item.sessionId),
                    cwd: item.cwd || '',
                    updatedAt: item.updatedAt,
                    archived: flags.archived.has(item.sessionId),
                    pinned: flags.pinned.has(item.sessionId),
                    blank: item.blank,
                    running: item.running,
                    currentTaskId: manager.currentTaskFor(item.sessionId),
                    taskIds: manager.taskIdsForSession(item.sessionId),
                    waitingApproval: waiting.has(item.sessionId)
                }));
            return items;
        } finally {
            clearTimeout(timer);
        }
    }

    function isSessionRunning(sessionId) {
        if (manager.currentTaskFor(sessionId)) return true;
        const agent = ctx.agents.get(sessionId);
        return Boolean(agent && agent.status === 'running');
    }

    async function inspectSession(sessionId) {
        const live = ctx.sessions.get(sessionId);
        if (live) return live;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            return await ctx.sessionController.inspect(sessionId, controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    // target 可以是 { sessionId }、{ taskId }，都为空时使用桥接会话
    async function resolveTargetSession(target) {
        if (target && target.taskId) {
            const taskId = String(target.taskId);
            const task = manager.getTask(taskId);
            if (!task || !task.sessionId) {
                return { error: { status: 404, message: `任务不存在或没有关联会话: ${taskId}` } };
            }
            if (target.sessionId && String(target.sessionId) !== task.sessionId) {
                return { error: { status: 404, message: `任务 ${taskId} 不属于会话 ${target.sessionId}` } };
            }
            return { sessionId: task.sessionId };
        }
        if (target && target.sessionId) {
            const sessionId = String(target.sessionId);
            try {
                await inspectSession(sessionId);
            } catch (error) {
                if (isSessionNotFoundError(error)) {
                    return { error: { status: 404, message: `会话不存在: ${sessionId}` } };
                }
                throw error;
            }
            return { sessionId };
        }
        return { sessionId: await ensureSession() };
    }

    function promptErrorStatus(error) {
        if (isSessionNotFoundError(error)) return 404;
        if (error && (error.code === 'session/steer-unavailable' || error.code === 'session/agent-busy')) return 409;
        return 500;
    }

    async function taskDetailView(task) {
        const detail = manager.taskDetail(task);
        const title = task.sessionTitle || sessionTitle(task.sessionId) || '';
        const running = isSessionRunning(task.sessionId);
        detail.sessionTitle = title;
        detail.sessionStatus = running ? 'running' : 'idle';
        detail.session = { sessionId: task.sessionId, title, running };
        return detail;
    }

    async function pageHistory(address, throughSeq, beforeSeq, pageSize) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            return await ctx.sessionController.page({
                address,
                throughSeq,
                beforeSeq,
                maxMessages: pageSize
            }, controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    async function readSessionHistory(sessionId, limit, beforeSeq) {
        const address = { kind: 'session', sessionId };
        const wanted = Math.max(1, Math.min(Number(limit) || 20, 100));
        const pageSize = Math.min(Math.max(wanted * 5, 50), 200);
        const streamController = new AbortController();
        const streamTimer = setTimeout(() => streamController.abort(), 15000);
        const stream = ctx.sessionController.follow({ address, maxMessages: pageSize }, streamController.signal);
        const iterator = stream[Symbol.asyncIterator]();
        let snapshot;
        try {
            const first = await iterator.next();
            if (first.done || !first.value || first.value.type !== 'snapshot') {
                throw new Error('会话历史读取没有返回快照');
            }
            snapshot = first.value;
        } finally {
            clearTimeout(streamTimer);
            streamController.abort();
            await iterator.return();
        }

        const cursor = snapshot.cursor;
        let records = snapshot.records || [];
        let hasMore = Boolean(snapshot.hasMore);
        if (beforeSeq !== null) {
            const page = await pageHistory(address, cursor, beforeSeq, pageSize);
            records = page.records || [];
            hasMore = Boolean(page.hasMore);
        }
        let messages = records.map(historyMessage).filter(Boolean);

        // 过滤掉工具事件后可能不足 limit，继续向前翻页补足
        while (messages.length < wanted && hasMore) {
            const oldestSeq = records.length && records[0].event ? records[0].event.seq : null;
            if (!Number.isInteger(oldestSeq)) break;
            const page = await pageHistory(address, cursor, oldestSeq, pageSize);
            const olderRecords = page.records || [];
            const nextOldestSeq = olderRecords.length && olderRecords[0].event ? olderRecords[0].event.seq : null;
            hasMore = Boolean(page.hasMore);
            const older = olderRecords.map(historyMessage).filter(Boolean);
            if (!older.length && !hasMore) break;
            messages = older.concat(messages);
            records = olderRecords;
            if (!Number.isInteger(nextOldestSeq) || nextOldestSeq >= oldestSeq) break;
        }

        messages.sort((a, b) => a.seq - b.seq);
        const result = messages.slice(-wanted);
        return {
            sessionId,
            cursor,
            order: 'ascending',
            hasMore: hasMore || messages.length > result.length,
            messages: result
        };
    }

    let napcatCredential = null;
    let napcatLoginPromise = null;

    async function napcatLogin(force = false) {
        if (napcatCredential && !force) return napcatCredential;
        if (napcatLoginPromise) return napcatLoginPromise;
        napcatLoginPromise = (async () => {
            try {
                const token = config.napcat.token;
                const sha = crypto.createHash('sha256');
                const hash = sha.update(token + '.napcat').digest('hex');
                const response = await fetch(config.napcat.webui + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ hash }),
                    signal: AbortSignal.timeout(5000)
                });
                if (!response.ok) return null;
                const login = await response.json();
                if (!login || login.code !== 0 || !login.data) return null;
                napcatCredential = login.data.Credential || null;
                return napcatCredential;
            } catch (error) {
                return null;
            } finally {
                napcatLoginPromise = null;
            }
        })();
        return napcatLoginPromise;
    }

    async function napcatApi(apiPath, credential, body) {
        const response = await fetch(config.napcat.webui + apiPath, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${credential}`
            },
            body: JSON.stringify(body || {}),
            signal: AbortSignal.timeout(8000)
        });
        if (response.status === 401) {
            const error = new Error('NapCat 凭据失效');
            error.code = 'NAPCAT_AUTH';
            throw error;
        }
        return response.json();
    }

    async function getQqStatus() {
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const credential = await napcatLogin(attempt > 0);
                if (!credential) {
                    lastError = 'NapCat 登录失败';
                    continue;
                }
                const status = await napcatApi('/api/QQLogin/CheckLoginStatus', credential);
                if (!status || status.code !== 0) {
                    lastError = (status && status.message) || 'NapCat 返回异常';
                    napcatCredential = null;
                    continue;
                }
                const data = status.data || {};
                return {
                    reachable: true,
                    isLogin: Boolean(data.isLogin),
                    loginPhase: data.loginPhase || '',
                    qrcodeurl: data.qrcodeurl || ''
                };
            } catch (error) {
                lastError = error.message;
                napcatCredential = null;
            }
        }
        return { reachable: false, error: lastError };
    }

    async function getQrCode() {
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const credential = await napcatLogin(attempt > 0);
                if (!credential) {
                    lastError = 'NapCat 登录失败';
                    continue;
                }
                try {
                    await napcatApi('/api/QQLogin/RefreshQRcode', credential);
                } catch (error) {
                    if (error.code === 'NAPCAT_AUTH') {
                        napcatCredential = null;
                        continue;
                    }
                }
                const qr = await napcatApi('/api/QQLogin/GetQQLoginQrcode', credential);
                if (qr.code !== 0 || !qr.data || !qr.data.qrcode) {
                    const message = qr.message || '没有二维码';
                    if (/logined/i.test(message)) return { error: 'QQ 已登录，无需获取二维码' };
                    return { error: message };
                }
                return { link: qr.data.qrcode };
            } catch (error) {
                lastError = error.message;
                napcatCredential = null;
            }
        }
        if (await isPortOpen(6099)) return { error: 'NapCat 正在启动，请稍后重试' };
        return { error: 'NapCat 不可达' };
    }

    let astrbotToken = null;

    async function astrbotLogin() {
        if (astrbotToken) return astrbotToken;
        const response = await fetch(config.astrbot.webui + '/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: config.astrbot.username, password: config.astrbot.password })
        });
        const data = await response.json();
        const token = data && data.data ? (data.data.token || data.data.access_token) : undefined;
        if (!token) throw new Error((data && data.message) || 'AstrBot 登录失败');
        astrbotToken = token;
        return token;
    }

    async function astrbotApi(apiPath, method, body, retried) {
        const token = await astrbotLogin();
        const response = await fetch(config.astrbot.webui + apiPath, {
            method: method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + token
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        if (response.status === 401 && !retried) {
            astrbotToken = null;
            return astrbotApi(apiPath, method, body, true);
        }
        const data = await response.json();
        if (data && data.status === 'error') throw new Error(data.message || 'AstrBot 接口报错');
        return data;
    }

    function astrbotProcess() {
        if (spawnState.astrbot && spawnState.astrbot.exitCode === null) {
            return spawnState.astrbot;
        }
        return null;
    }

    async function isPortOpen(port) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(500);
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => resolve(false));
            socket.once('timeout', () => {
                socket.destroy();
                resolve(false);
            });
            socket.connect(port, '127.0.0.1');
        });
    }

    const installState = { uv: 'idle', astrbot: 'idle', napcat: 'idle' };
    const installLog = {};

    function commandInPath(name) {
        try {
            execFileSync('cmd.exe', ['/c', 'where', name], { stdio: 'ignore', timeout: 5000 });
            return true;
        } catch (error) {
            return false;
        }
    }

    function findUv() {
        const candidates = [
            path.join(process.env.USERPROFILE || '', '.local', 'bin', 'uv.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'uv', 'uv.exe')
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        if (commandInPath('uv')) return 'uv.exe';
        return null;
    }

    function findQq() {
        const candidates = [
            config.qqPath,
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tencent', 'QQNT', 'QQ.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'QQNT', 'QQ.exe')
        ];
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) return candidate;
        }
        try {
            const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process QQ -ErrorAction SilentlyContinue | Select-Object -First 1).Path'], { encoding: 'utf8', timeout: 5000 });
            const line = output.trim();
            if (line && fs.existsSync(line)) return line;
        } catch (error) {
            // QQ 未运行且不在常见目录
        }
        return null;
    }

    function findAstrbot() {
        const home = process.env.USERPROFILE || '';
        const dirs = [
            config.astrbot.dir,
            path.join(process.env.APPDATA || '', 'uv', 'tools', 'astrbot'),
            path.join(process.env.LOCALAPPDATA || '', 'uv', 'tools', 'astrbot'),
            path.join(home, '.local', 'share', 'uv', 'tools', 'astrbot'),
            path.join(home, 'uv', 'tools', 'astrbot')
        ];
        for (const dir of dirs) {
            if (!dir || !fs.existsSync(dir)) continue;
            const exeCandidates = [
                config.astrbot.exe,
                path.join(dir, 'Scripts', 'astrbot.exe'),
                path.join(dir, 'astrbot.exe')
            ];
            for (const exe of exeCandidates) {
                if (exe && fs.existsSync(exe)) return { dir, exe };
            }
        }
        return { dir: '', exe: '' };
    }

    function findNapcat() {
        const home = process.env.USERPROFILE || '';
        const dirs = [
            config.napcat.dir,
            path.join(home, 'napcat'),
            'C:\\NapCat'
        ];
        for (const dir of dirs) {
            if (!dir || !fs.existsSync(dir)) continue;
            const launcherCandidates = [
                config.napcat.launcher,
                path.join(dir, 'launcher.bat'),
                path.join(dir, 'NapCatWinBootMain.exe')
            ];
            for (const launcher of launcherCandidates) {
                if (launcher && fs.existsSync(launcher)) return { dir, launcher };
            }
        }
        return { dir: '', launcher: '' };
    }

    async function waitForPort(port, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await isPortOpen(port)) return true;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return false;
    }

    async function startNapcat() {
        if (await isPortOpen(6099)) return { ok: true, already: true };
        if (!fs.existsSync(config.napcat.launcher)) {
            return { ok: false, error: `NapCat 启动脚本不存在: ${config.napcat.launcher}` };
        }
        const child = spawn('cmd.exe', ['/c', config.napcat.launcher], {
            cwd: config.napcat.dir,
            windowsHide: true,
            detached: true,
            stdio: 'ignore'
        });
        child.on('error', (error) => {
            log(`NapCat 子进程错误: ${error.message}`);
        });
        child.unref();
        log(`已启动 NapCat launcher pid=${child.pid}`);
        return { ok: true, pid: child.pid, note: '正在启动 NapCat，稍后查看 QQ 登录状态' };
    }

    async function checkEnv() {
        const uv = findUv();
        const qqPath = findQq();
        const astrbot = findAstrbot();
        const napcat = findNapcat();
        return {
            uv: { installed: Boolean(uv), path: uv || '' },
            astrbot: { installed: Boolean(astrbot.exe), path: astrbot.exe, dir: astrbot.dir },
            napcat: { installed: Boolean(napcat.launcher), dir: napcat.dir, launcher: napcat.launcher },
            qq: { installed: Boolean(qqPath), path: qqPath || '' },
            astrbotRunning: await isPortOpen(6185),
            napcatRunning: await isPortOpen(6099),
            install: installState,
            installLog
        };
    }

    function runInstall(component, command, args) {
        if (installState[component] === 'running') return { started: false, reason: '正在安装中' };
        installState[component] = 'running';
        installLog[component] = '';
        log(`开始安装 ${component}`);
        try {
            const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const append = (chunk) => {
                installLog[component] = (installLog[component] + chunk.toString()).slice(-3000);
            };
            child.stdout.on('data', append);
            child.stderr.on('data', append);
            child.on('exit', (code) => {
                installState[component] = code === 0 ? 'done' : 'failed';
                log(`安装 ${component} 结束 code=${code}`);
            });
            child.on('error', (error) => {
                installState[component] = 'failed';
                installLog[component] = (installLog[component] + '\n' + error.message).slice(-3000);
                log(`安装 ${component} 失败: ${error.message}`);
            });
            return { started: true };
        } catch (error) {
            installState[component] = 'failed';
            log(`安装 ${component} 启动失败: ${error.message}`);
            return { started: false, reason: error.message };
        }
    }

    async function installNapcat() {
        if (installState.napcat === 'running') return { started: false, reason: '正在安装中' };
        installState.napcat = 'running';
        installLog.napcat = '开始下载 NapCat 发布包\n';
        try {
            const url = config.napcat.downloadUrl;
            const zipPath = path.join(config.installDir, 'NapCat.Shell.zip');
            const response = await fetch(url, { redirect: 'follow' });
            if (!response.ok) throw new Error('下载失败 HTTP ' + response.status);
            const buffer = Buffer.from(await response.arrayBuffer());
            fs.mkdirSync(config.installDir, { recursive: true });
            fs.writeFileSync(zipPath, buffer);
            installLog.napcat += `下载完成 ${Math.round(buffer.length / 1024 / 1024)} MB，开始解压\n`;
            execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${config.napcat.dir}' -Force`], { timeout: 300000, stdio: 'ignore' });
            installState.napcat = 'done';
            installLog.napcat += `已解压到 ${config.napcat.dir}`;
            log(`NapCat 安装完成: ${config.napcat.dir}`);
            return { started: true };
        } catch (error) {
            installState.napcat = 'failed';
            installLog.napcat += '\n失败: ' + error.message;
            log(`NapCat 安装失败: ${error.message}`);
            return { started: false, reason: error.message };
        }
    }

    async function startAstrBot() {
        if (await isPortOpen(6185)) return { ok: true, already: true };
        if (!fs.existsSync(config.astrbot.exe)) {
            return { ok: false, error: `聊天机器人启动程序不存在: ${config.astrbot.exe}` };
        }
        const logStream = fs.openSync(config.astrbotLogFile, 'a');
        let child;
        try {
            child = spawn(config.astrbot.exe, ['run'], {
                cwd: config.astrbot.dir,
                detached: true,
                windowsHide: true,
                stdio: ['ignore', logStream, logStream]
            });
        } finally {
            fs.closeSync(logStream);
        }
        child.unref();
        child.on('error', (error) => {
            log(`聊天机器人子进程错误: ${error.message}`);
            spawnState.astrbot = null;
        });
        spawnState.astrbot = child;
        child.on('exit', () => {
            spawnState.astrbot = null;
        });
        log(`已启动 AstrBot pid=${child.pid}`);
        return { ok: true, pid: child.pid };
    }

    function killProcessByCommandLine(keyword) {
        const script = `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*${keyword}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
        try {
            execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
        } catch (error) {
            log(`结束进程失败: ${error.message}`);
        }
    }

    async function stopAstrBot() {
        killProcessByCommandLine('astrbot');
        spawnState.astrbot = null;
        return { ok: true };
    }

    async function restartAstrBot() {
        await stopAstrBot();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return startAstrBot();
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');

            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                return res.end();
            }

            if (req.method === 'GET' && url.pathname === '/health') {
                return sendJson(res, 200, {
                    bridge: 'ok',
                    mode: 'dsh-plugin',
                    ...manager.describeState(),
                    astrbot: await isPortOpen(6185)
                });
            }

            if (req.method === 'POST' && url.pathname === '/task') {
                const body = JSON.parse(await readBody(req));
                if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
                    return sendJson(res, 400, { error: '缺少 prompt' });
                }
                const sessionId = await ensureSession();
                const task = manager.createTask({
                    prompt: body.prompt.trim(),
                    umo: body.umo || '',
                    fileUmo: body.fileUmo || '',
                    sessionId
                });
                recordTaskEvent('task/queued', task, { text: '任务已排队' });
                log(`收到任务 ${task.id} session=${sessionId} from=${body.umo || 'unknown'}`);
                setImmediate(pumpQueue);
                return sendJson(res, 200, { taskId: task.id, status: 'queued' });
            }

            if (req.method === 'GET' && url.pathname === '/tasks') {
                const sessionId = url.searchParams.get('sessionId') || '';
                const status = url.searchParams.get('status') || '';
                const limit = clampLimit(url.searchParams.get('limit'), 50);
                const tasks = manager.listTasks({ sessionId, status, limit }).map((task) => manager.taskSummary(task));
                return sendJson(res, 200, { tasks });
            }

            if (req.method === 'POST' && url.pathname.startsWith('/tasks/') && url.pathname.endsWith('/cancel')) {
                const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/cancel'.length));
                const task = taskId ? manager.getTask(taskId) : null;
                if (!task) return sendJson(res, 404, { ok: false, error: `任务不存在: ${taskId}` });
                if (!task.sessionId) return sendJson(res, 404, { ok: false, error: `任务没有关联会话: ${taskId}` });
                if (task.status === 'queued') {
                    finishTaskById(taskId, { cancelled: true, error: '任务在排队时被中断' });
                    log(`排队中的任务 ${taskId} 已中断`);
                    return sendJson(res, 200, { ok: true, taskId });
                }
                if (task.status !== 'running') {
                    return sendJson(res, 200, { ok: false, reason: `任务已经结束（${task.status}）` });
                }
                try {
                    await ctx.sessionController.cancel({ sessionId: task.sessionId });
                } catch (error) {
                    return sendJson(res, 500, { ok: false, error: error.message });
                }
                finishTaskById(taskId, { cancelled: true, error: '任务被中断' });
                log(`任务 ${taskId} 已中断 session=${task.sessionId}`);
                return sendJson(res, 200, { ok: true, taskId });
            }

            if (req.method === 'POST' && url.pathname.startsWith('/tasks/') && url.pathname.endsWith('/continue')) {
                const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length, -'/continue'.length));
                const task = taskId ? manager.getTask(taskId) : null;
                if (!task) return sendJson(res, 404, { error: `任务不存在: ${taskId}` });
                if (!task.sessionId) return sendJson(res, 404, { error: `任务没有关联会话: ${taskId}` });
                const body = JSON.parse(await readBody(req));
                const answer = typeof body.prompt === 'string' && body.prompt.trim()
                    ? body.prompt.trim()
                    : '请继续刚才中断的任务，从上次中断的位置接着做，完成后汇报结果。';
                const next = manager.createTask({
                    prompt: answer,
                    umo: body.umo || '',
                    fileUmo: body.fileUmo || '',
                    sessionId: task.sessionId
                });
                recordTaskEvent('task/queued', next, { text: '继续指令已排队' });
                log(`任务 ${next.id} 继续任务 ${taskId} session=${task.sessionId}`);
                setImmediate(pumpQueue);
                return sendJson(res, 200, { taskId: next.id, sessionId: task.sessionId, accepted: true });
            }

            if (req.method === 'GET' && url.pathname.startsWith('/tasks/')) {
                const taskId = decodeURIComponent(url.pathname.slice('/tasks/'.length));
                const task = taskId ? manager.getTask(taskId) : null;
                if (!task) return sendJson(res, 404, { error: `任务不存在: ${taskId}` });
                return sendJson(res, 200, await taskDetailView(task));
            }

            if (req.method === 'POST' && url.pathname === '/prompt') {
                const body = JSON.parse(await readBody(req));
                const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
                if (!prompt) return sendJson(res, 400, { accepted: false, error: '缺少 prompt' });
                const mode = ['auto', 'queue', 'steer'].includes(body.mode) ? body.mode : 'auto';
                const target = body.target && typeof body.target === 'object' ? body.target : {};
                const resolved = await resolveTargetSession(target);
                if (resolved.error) {
                    return sendJson(res, resolved.error.status, { accepted: false, error: resolved.error.message });
                }
                const sessionId = resolved.sessionId;
                const umo = typeof body.umo === 'string' ? body.umo : '';
                const fileUmo = typeof body.fileUmo === 'string' ? body.fileUmo : '';
                const running = isSessionRunning(sessionId);

                if (mode === 'steer' || (mode === 'auto' && running)) {
                    let taskId = manager.currentTaskFor(sessionId);
                    let boundTask = null;
                    if (!taskId) {
                        boundTask = manager.bindRunningTask({
                            sessionId,
                            prompt,
                            umo,
                            fileUmo,
                            turnNumber: openTurns.has(sessionId) ? openTurns.get(sessionId) : null
                        });
                        taskId = boundTask.id;
                        recordTaskEvent('task/started', boundTask, { text: '追加指令已绑定运行中的回合' });
                    } else if (manager.getTask(taskId).awaitTurnStart) {
                        return sendJson(res, 409, {
                            accepted: false,
                            taskId,
                            sessionId,
                            error: '目标会话有排队中的任务，暂时不能追加指令'
                        });
                    }
                    try {
                        await submitPrompt(sessionId, prompt, 'steer');
                    } catch (error) {
                        if (boundTask) finishTaskById(boundTask.id, { error: `追加指令提交失败：${error.message}` });
                        log(`向会话 ${sessionId} 追加指令失败: ${error.message}`);
                        return sendJson(res, promptErrorStatus(error), { accepted: false, error: error.message });
                    }
                    recordBridgeEvent(sessionId, 'prompt/steer', {
                        text: '已向运行中的会话追加指令',
                        prompt: truncateText(prompt, MAX_EVENT_TEXT_CHARS)
                    }, taskId);
                    log(`已向会话 ${sessionId} 追加指令 task=${taskId}`);
                    return sendJson(res, 200, { taskId, sessionId, accepted: true, mode: 'steer' });
                }

                const task = manager.createTask({ prompt, umo, fileUmo, sessionId });
                recordTaskEvent('task/queued', task, { text: '任务已排队' });
                log(`收到提示词任务 ${task.id} session=${sessionId} mode=${mode}`);
                setImmediate(pumpQueue);
                return sendJson(res, 200, { taskId: task.id, sessionId, accepted: true, mode: 'queue' });
            }

            if (req.method === 'POST' && url.pathname === '/task/cancel') {
                const taskId = manager.currentTaskId;
                if (!taskId) {
                    return sendJson(res, 200, { ok: false, reason: '当前没有正在执行的任务' });
                }
                try {
                    await ctx.sessionController.cancel({ sessionId: manager.sessionId });
                } catch (error) {
                    return sendJson(res, 500, { ok: false, error: error.message });
                }
                finishTaskById(taskId, { cancelled: true, error: '任务被中断' });
                log(`任务 ${taskId} 已中断`);
                return sendJson(res, 200, { ok: true, taskId });
            }

            if (req.method === 'POST' && url.pathname === '/task/continue') {
                const body = JSON.parse(await readBody(req));
                const answer = typeof body.answer === 'string' && body.answer.trim() ? body.answer.trim() : '请继续刚才中断的任务';
                if (manager.currentTaskId) {
                    return sendJson(res, 409, { ok: false, error: '还有任务正在执行' });
                }
                const sessionId = await ensureSession();
                const task = manager.createTask({
                    prompt: answer,
                    umo: body.umo || '',
                    fileUmo: body.fileUmo || '',
                    sessionId
                });
                recordTaskEvent('task/queued', task, { text: '继续任务已排队' });
                log(`继续任务 ${task.id}: ${answer}`);
                setImmediate(pumpQueue);
                return sendJson(res, 200, { ok: true, taskId: task.id });
            }

            if (req.method === 'GET' && url.pathname.startsWith('/task/')) {
                const taskId = decodeURIComponent(url.pathname.slice('/task/'.length));
                const task = taskId ? manager.getTask(taskId) : null;
                if (!task) return sendJson(res, 404, { error: '任务不存在' });
                return sendJson(res, 200, await taskDetailView(task));
            }

            if (req.method === 'POST' && url.pathname === '/progress') {
                const body = JSON.parse(await readBody(req));
                const question = typeof body.question === 'string' ? body.question.trim() : '';
                const requestedTaskId = typeof body.taskId === 'string' && body.taskId.trim() ? body.taskId.trim() : '';
                const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
                    ? body.sessionId.trim()
                    : manager.sessionId;

                if (requestedTaskId) {
                    const task = manager.getTask(requestedTaskId);
                    if (!task) return sendJson(res, 404, { error: '任务不存在' });
                    if (task.status === 'running' && question) {
                        try {
                            await submitPrompt(task.sessionId, question, 'steer');
                        } catch (error) {
                            log(`进度插话失败: ${error.message}`);
                        }
                    }
                    return sendJson(res, 200, {
                        status: task.status,
                        taskId: task.id,
                        sessionId: task.sessionId,
                        reply: task.status === 'running'
                            ? (manager.lastAssistantText(task.sessionId) || null)
                            : (task.lastMessage || task.error || null)
                    });
                }

                const currentTaskId = requestedSessionId ? manager.currentTaskFor(requestedSessionId) : null;
                if (currentTaskId) {
                    if (question) {
                        try {
                            await submitPrompt(requestedSessionId, question, 'steer');
                            log(`进度询问已插话: ${question}`);
                        } catch (error) {
                            log(`进度插话失败: ${error.message}`);
                        }
                    }
                    const task = manager.getTask(currentTaskId);
                    return sendJson(res, 200, {
                        status: 'running',
                        taskId: task ? task.id : null,
                        sessionId: requestedSessionId,
                        reply: manager.lastAssistantText(requestedSessionId) || null
                    });
                }
                const last = manager.getLastCompletedTask(requestedSessionId);
                return sendJson(res, 200, {
                    status: last ? 'completed' : 'idle',
                    taskId: last ? last.id : null,
                    sessionId: requestedSessionId || null,
                    reply: last && last.lastMessage ? last.lastMessage : '现在没有正在执行的任务。'
                });
            }

            if (req.method === 'GET' && url.pathname === '/reports') {
                return sendJson(res, 200, { reports: manager.takeReports() });
            }

            if (req.method === 'POST' && url.pathname === '/reports/ack') {
                const body = JSON.parse(await readBody(req));
                manager.ackReports(body.taskIds);
                return sendJson(res, 200, { ok: true });
            }

            if (req.method === 'GET' && url.pathname === '/approvals/pending') {
                const pending = Array.from(pendingApprovals.values()).map(pendingApprovalView);
                return sendJson(res, 200, { pending });
            }

            if (req.method === 'GET' && url.pathname === '/approvals') {
                const limit = clampLimit(url.searchParams.get('limit'), 20);
                const pending = Array.from(pendingApprovals.values()).map(pendingApprovalView).slice(0, limit);
                const recent = approvalHistory
                    .filter((record) => record.status !== 'pending')
                    .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt))
                    .slice(0, limit)
                    .map(approvalHistoryView);
                return sendJson(res, 200, { pending, recent });
            }

            if (req.method === 'POST' && url.pathname === '/approval/answer') {
                const body = JSON.parse(await readBody(req));
                const item = pendingApprovals.get(body.id);
                if (!item) return sendJson(res, 404, { ok: false, error: '审批不存在或已过期' });
                item.resolve(body.decision === 'allow' ? 'allow' : 'deny');
                return sendJson(res, 200, { ok: true });
            }

            if (req.method === 'GET' && url.pathname === '/sessions') {
                const sessions = await listSessions();
                return sendJson(res, 200, { sessions });
            }

            if (req.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/history')) {
                const sessionId = decodeURIComponent(url.pathname.slice('/sessions/'.length, -'/history'.length));
                if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
                const limit = clampLimit(url.searchParams.get('limit'), 20);
                const beforeSeqRaw = Number(url.searchParams.get('beforeSeq'));
                const beforeSeq = Number.isInteger(beforeSeqRaw) && beforeSeqRaw > 0 ? beforeSeqRaw : null;
                try {
                    const history = await readSessionHistory(sessionId, limit, beforeSeq);
                    return sendJson(res, 200, history);
                } catch (error) {
                    log(`读取会话历史失败 session=${sessionId}: ${error.message}`);
                    if (isSessionNotFoundError(error)) return sendJson(res, 404, { error: `会话不存在: ${sessionId}` });
                    const message = error && error.name === 'AbortError' ? '读取会话历史超时' : error.message;
                    return sendJson(res, 500, { error: message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/events/stream') {
                const sessionId = url.searchParams.get('sessionId') || '';
                const sinceSeqRaw = Number(url.searchParams.get('sinceSeq'));
                const sinceSeq = Number.isInteger(sinceSeqRaw) && sinceSeqRaw > 0 ? sinceSeqRaw : 0;
                openEventStream(req, res, sessionId, sinceSeq);
                return;
            }

            if (req.method === 'GET' && url.pathname === '/events') {
                const sessionId = url.searchParams.get('sessionId') || '';
                const sinceSeqRaw = Number(url.searchParams.get('sinceSeq'));
                const sinceSeq = Number.isInteger(sinceSeqRaw) && sinceSeqRaw > 0 ? sinceSeqRaw : 0;
                const events = bridgeEvents.filter((item) => item.seq > sinceSeq && (!sessionId || item.sessionId === sessionId));
                let cursor = sinceSeq;
                for (const item of events) {
                    if (item.seq > cursor) cursor = item.seq;
                }
                return sendJson(res, 200, { sessionId: sessionId || null, cursor, events });
            }

            if (req.method === 'POST' && url.pathname === '/sessions/operate') {
                const body = JSON.parse(await readBody(req));
                const sessionId = body.sessionId;
                if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
                if (sessionId === manager.sessionId) {
                    return sendJson(res, 400, { error: '这是机器人自己的会话，请用任务工具操作' });
                }
                if (body.action === 'prompt') {
                    await submitPrompt(sessionId, body.prompt || '请继续处理当前任务。', 'queue');
                    log(`已向会话 ${sessionId} 发送提示`);
                    return sendJson(res, 200, { ok: true, sessionId });
                }
                if (body.action === 'cancel') {
                    await ctx.sessionController.cancel({ sessionId });
                    log(`已请求中断会话 ${sessionId}`);
                    return sendJson(res, 200, { ok: true, sessionId });
                }
                return sendJson(res, 400, { error: '不支持的操作' });
            }

            if (req.method === 'GET' && url.pathname === '/admin/status') {
                const napcatPortOpen = await isPortOpen(6099);
                const qq = await getQqStatus();
                if (!qq.reachable && napcatPortOpen) qq.starting = true;
                return sendJson(res, 200, {
                    astrbot: await isPortOpen(6185),
                    napcat: napcatPortOpen,
                    bridge: true,
                    adminQQ: config.adminQQ || '',
                    qq
                });
            }

            if (req.method === 'GET' && url.pathname === '/admin/settings') {
                return sendJson(res, 200, {
                    adminQQ: config.adminQQ || '',
                    workspace: config.workspace,
                    provider: config.provider,
                    model: config.model,
                    astrbotDir: config.astrbot.dir,
                    astrbotExe: config.astrbot.exe,
                    astrbotWebui: config.astrbot.webui,
                    napcatWebui: config.napcat.webui,
                    napcatToken: config.napcat.token,
                    napcatDir: config.napcat.dir,
                    napcatLauncher: config.napcat.launcher
                });
            }

            if (req.method === 'POST' && url.pathname === '/admin/settings') {
                try {
                    const body = JSON.parse(await readBody(req));
                    const configFile = getConfigFile();
                    const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
                    if (typeof body.adminQQ === 'string') {
                        config.adminQQ = body.adminQQ.trim();
                        data.adminQQ = config.adminQQ;
                        log(`管理员 QQ 已更新: ${config.adminQQ}`);
                    }
                    if (typeof body.workspace === 'string' && body.workspace.trim()) {
                        config.workspace = body.workspace.trim();
                        data.workspace = config.workspace;
                        log(`工作区已更新: ${config.workspace}`);
                    }
                    if (typeof body.astrbotDir === 'string' && body.astrbotDir.trim()) {
                        config.astrbot.dir = body.astrbotDir.trim();
                        data.astrbot.dir = config.astrbot.dir;
                        log(`聊天机器人目录已更新: ${config.astrbot.dir}`);
                    }
                    if (typeof body.astrbotExe === 'string' && body.astrbotExe.trim()) {
                        config.astrbot.exe = body.astrbotExe.trim();
                        data.astrbot.exe = config.astrbot.exe;
                        log(`聊天机器人启动程序已更新: ${config.astrbot.exe}`);
                    }
                    if (typeof body.astrbotWebui === 'string' && body.astrbotWebui.trim()) {
                        config.astrbot.webui = body.astrbotWebui.trim();
                        data.astrbot.webui = config.astrbot.webui;
                        log(`AstrBot 网页地址已更新: ${config.astrbot.webui}`);
                    }
                    if (typeof body.napcatWebui === 'string' && body.napcatWebui.trim()) {
                        config.napcat.webui = body.napcatWebui.trim();
                        data.napcat.webui = config.napcat.webui;
                        log(`NapCat 管理地址已更新: ${config.napcat.webui}`);
                    }
                    if (typeof body.napcatToken === 'string') {
                        config.napcat.token = body.napcatToken.trim();
                        data.napcat.token = config.napcat.token;
                        log(`NapCat token 已更新`);
                    }
                    if (typeof body.napcatDir === 'string' && body.napcatDir.trim()) {
                        config.napcat.dir = body.napcatDir.trim();
                        data.napcat.dir = config.napcat.dir;
                        log(`NapCat 目录已更新: ${config.napcat.dir}`);
                    }
                    if (typeof body.napcatLauncher === 'string' && body.napcatLauncher.trim()) {
                        config.napcat.launcher = body.napcatLauncher.trim();
                        data.napcat.launcher = config.napcat.launcher;
                        log(`NapCat 启动脚本已更新: ${config.napcat.launcher}`);
                    }
                    fs.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf8');
                    return sendJson(res, 200, {
                        ok: true,
                        adminQQ: config.adminQQ || '',
                        workspace: config.workspace,
                        astrbotDir: config.astrbot.dir,
                        astrbotExe: config.astrbot.exe,
                        astrbotWebui: config.astrbot.webui,
                        napcatWebui: config.napcat.webui,
                        napcatToken: config.napcat.token,
                        napcatDir: config.napcat.dir,
                        napcatLauncher: config.napcat.launcher
                    });
                } catch (error) {
                    log(`保存设置失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/astrbot/plugin/install') {
                try {
                    const sourceDir = path.join(__dirname, 'adapters', 'astrbot');
                    if (!fs.existsSync(sourceDir)) return sendJson(res, 400, { error: '插件包缺少 adapters/astrbot 目录' });
                    const targetDir = path.join(config.astrbot.dir, 'data', 'plugins', 'astrbot_plugin_dsh_bridge');
                    fs.mkdirSync(targetDir, { recursive: true });
                    for (const file of fs.readdirSync(sourceDir)) {
                        const sourceFile = path.join(sourceDir, file);
                        if (!fs.statSync(sourceFile).isFile()) continue;
                        fs.copyFileSync(sourceFile, path.join(targetDir, file));
                    }
                    log(`AstrBot 插件已安装到 ${targetDir}`);
                    return sendJson(res, 200, { ok: true, target: targetDir, note: '重启聊天机器人后生效' });
                } catch (error) {
                    log(`安装 AstrBot 插件失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/persona-template') {
                try {
                    const file = path.join(__dirname, 'templates', 'persona-default.md');
                    if (!fs.existsSync(file)) return sendJson(res, 404, { error: '没有默认模板' });
                    return sendJson(res, 200, { template: fs.readFileSync(file, 'utf8') });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/env') {
                try {
                    return sendJson(res, 200, await checkEnv());
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/setup/detect') {
                const astrbot = findAstrbot();
                const napcat = findNapcat();
                return sendJson(res, 200, {
                    astrbot: {
                        dir: astrbot.dir || config.astrbot.dir,
                        exe: astrbot.exe || config.astrbot.exe,
                        webui: config.astrbot.webui
                    },
                    napcat: {
                        dir: napcat.dir || config.napcat.dir,
                        launcher: napcat.launcher || config.napcat.launcher,
                        webui: config.napcat.webui
                    }
                });
            }

            if (req.method === 'GET' && url.pathname === '/admin/astrbot/setup-status') {
                if (!(await isPortOpen(6185))) {
                    return sendJson(res, 200, { online: false });
                }
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                try {
                    const response = await fetch(config.astrbot.webui + '/api/v1/auth/setup-status', {
                        signal: controller.signal
                    });
                    const data = await response.json();
                    const info = data && data.data ? data.data : {};
                    return sendJson(res, 200, {
                        online: true,
                        setupRequired: Boolean(info.setup_required),
                        skipDefaultPasswordAuth: Boolean(info.skip_default_password_auth),
                        passwordUpgradeRequired: Boolean(info.password_upgrade_required),
                        webui: config.astrbot.webui
                    });
                } catch (error) {
                    return sendJson(res, 200, {
                        online: true,
                        webui: config.astrbot.webui,
                        error: error.name === 'AbortError' ? '读取 AstrBot 登录状态超时' : error.message
                    });
                } finally {
                    clearTimeout(timer);
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/setup/apply') {
                const steps = [];
                const warnings = [];
                try {
                    if (!config.astrbot.dir || !fs.existsSync(config.astrbot.dir)) {
                        return sendJson(res, 400, {
                            ok: false,
                            steps,
                            warnings,
                            error: '未找到 AstrBot 目录，请先在安装页填写或点击自动检测'
                        });
                    }
                    if (!config.astrbot.exe || !fs.existsSync(config.astrbot.exe)) {
                        return sendJson(res, 400, {
                            ok: false,
                            steps,
                            warnings,
                            error: '未找到 AstrBot 启动程序，请先在安装页填写或点击自动检测'
                        });
                    }
                    const sourceDir = path.join(__dirname, 'adapters', 'astrbot');
                    const targetDir = path.join(config.astrbot.dir, 'data', 'plugins', 'astrbot_plugin_dsh_bridge');
                    if (!fs.existsSync(sourceDir)) throw new Error('插件包缺少 adapters/astrbot 目录');
                    fs.mkdirSync(targetDir, { recursive: true });
                    for (const file of fs.readdirSync(sourceDir)) {
                        const sourceFile = path.join(sourceDir, file);
                        if (!fs.statSync(sourceFile).isFile()) continue;
                        fs.copyFileSync(sourceFile, path.join(targetDir, file));
                    }
                    steps.push(`已安装 AstrBot 适配器：${targetDir}`);

                    if (await isPortOpen(6185)) {
                        await stopAstrBot();
                        await new Promise((resolve) => setTimeout(resolve, 1500));
                        steps.push('已停止旧的聊天机器人进程');
                    }
                    const started = await startAstrBot();
                    if (!started.ok) {
                        throw new Error(started.error || '启动 AstrBot 失败');
                    }
                    const astrbotReady = await waitForPort(6185, 90000);
                    if (!astrbotReady) {
                        warnings.push('AstrBot 启动后 90 秒内没有监听 6185 端口，请查看日志');
                    } else {
                        steps.push('聊天机器人已启动并监听 6185');
                    }

                    if (config.napcat.launcher && fs.existsSync(config.napcat.launcher)) {
                        const napcat = await startNapcat();
                        if (!napcat.ok) {
                            warnings.push(napcat.error || 'NapCat 启动失败');
                        } else {
                            const napcatReady = await waitForPort(6099, 30000);
                            if (napcatReady) steps.push('NapCat 已启动并监听 6099');
                            else warnings.push('NapCat 30 秒内没有监听 6099 端口，请查看日志');
                        }
                    } else {
                        warnings.push('未找到 NapCat 启动脚本，跳过 NapCat 启动');
                    }

                    let qr = null;
                    try {
                        qr = await getQrCode();
                        if (qr && qr.link) steps.push('已生成 QQ 登录二维码');
                    } catch (error) {
                        warnings.push(`二维码获取失败：${error.message}`);
                    }
                    return sendJson(res, 200, {
                        ok: true,
                        steps,
                        warnings,
                        qr,
                        astrbotRunning: await isPortOpen(6185),
                        napcatRunning: await isPortOpen(6099)
                    });
                } catch (error) {
                    log(`自动配置失败: ${error.message}`);
                    return sendJson(res, 500, { ok: false, steps, warnings, error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/install') {
                try {
                    const body = JSON.parse(await readBody(req));
                    const component = body.component;
                    if (component === 'uv') {
                        return sendJson(res, 200, runInstall('uv', 'powershell.exe', ['-NoProfile', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex']));
                    }
                    if (component === 'astrbot') {
                        const uv = findUv();
                        if (!uv) return sendJson(res, 400, { error: '先安装 uv' });
                        return sendJson(res, 200, runInstall('astrbot', uv, ['tool', 'install', 'astrbot']));
                    }
                    if (component === 'napcat') {
                        return sendJson(res, 200, await installNapcat());
                    }
                    return sendJson(res, 400, { error: '未知组件' });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/astrbot/start') {
                return sendJson(res, 200, await startAstrBot());
            }

            if (req.method === 'POST' && url.pathname === '/admin/astrbot/stop') {
                return sendJson(res, 200, await stopAstrBot());
            }

            if (req.method === 'POST' && url.pathname === '/admin/astrbot/restart') {
                return sendJson(res, 200, await restartAstrBot());
            }

            if (req.method === 'GET' && url.pathname === '/admin/qr') {
                return sendJson(res, 200, await getQrCode());
            }

            if (req.method === 'GET' && url.pathname === '/admin/qr.png') {
                const requested = url.searchParams.get('link') || '';
                let qr;
                if (requested) {
                    if (requested.length > 2048 || !/^https?:\/\//i.test(requested)) {
                        return sendJson(res, 400, { error: '二维码链接无效' });
                    }
                    qr = { link: requested };
                } else {
                    qr = await getQrCode();
                }
                if (!qr.link) return sendJson(res, 404, qr);
                try {
                    const png = await QRCode.toBuffer(qr.link, {
                        type: 'png',
                        width: 320,
                        margin: 1,
                        errorCorrectionLevel: 'M'
                    });
                    res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
                    return res.end(png);
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/logs') {
                const lines = Number(url.searchParams.get('lines') || 200);
                try {
                    const content = fs.readFileSync(config.logFile, 'utf8').split('\n').slice(-Math.min(Math.max(lines, 1), 1000)).join('\n');
                    return sendJson(res, 200, { log: content });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/personas') {
                try {
                    const data = await astrbotApi('/api/v1/personas');
                    const list = Array.isArray(data.data) ? data.data : [];
                    return sendJson(res, 200, {
                        personas: list.map((item) => ({
                            persona_id: item.persona_id,
                            preview: String(item.system_prompt || '').slice(0, 120)
                        }))
                    });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/persona') {
                const id = url.searchParams.get('id');
                if (!id) return sendJson(res, 400, { error: '缺少 id' });
                try {
                    const data = await astrbotApi('/api/v1/personas/by-id?persona_id=' + encodeURIComponent(id));
                    return sendJson(res, 200, { persona: data.data });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/persona') {
                try {
                    const body = JSON.parse(await readBody(req));
                    if (!body.persona_id) return sendJson(res, 400, { error: '缺少 persona_id' });
                    const data = await astrbotApi('/api/v1/personas/by-id', 'PUT', {
                        persona_id: body.persona_id,
                        system_prompt: body.system_prompt
                    });
                    return sendJson(res, 200, data);
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/persona-create') {
                try {
                    const body = JSON.parse(await readBody(req));
                    if (!body.persona_id) return sendJson(res, 400, { error: '缺少 persona_id' });
                    const data = await astrbotApi('/api/v1/personas', 'POST', {
                        persona_id: body.persona_id,
                        system_prompt: body.system_prompt || '你是一个助手。'
                    });
                    log(`已创建人格: ${body.persona_id}`);
                    return sendJson(res, 200, data);
                } catch (error) {
                    log(`创建人格失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/config') {
                try {
                    const data = await astrbotApi('/api/v1/system-config');
                    return sendJson(res, 200, { config: (data.data && data.data.config) || data.data || {} });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/provider-sources') {
                try {
                    const data = await astrbotApi('/api/v1/provider-sources');
                    const list = data.data && Array.isArray(data.data.provider_sources) ? data.data.provider_sources : [];
                    return sendJson(res, 200, {
                        sources: list.map((item) => ({
                            id: item.id,
                            provider: item.provider,
                            type: item.type,
                            api_base: item.api_base,
                            enable: item.enable,
                            key: Array.isArray(item.key) ? item.key : []
                        }))
                    });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/provider-source') {
                try {
                    const body = JSON.parse(await readBody(req));
                    if (!body.id) return sendJson(res, 400, { error: '缺少 id' });
                    const listData = await astrbotApi('/api/v1/provider-sources');
                    const list = listData.data && Array.isArray(listData.data.provider_sources) ? listData.data.provider_sources : [];
                    const existing = list.find((item) => item.id === body.id);
                    const payload = existing
                        ? { ...existing, source_id: existing.id }
                        : {
                            source_id: body.id,
                            provider: body.provider || 'deepseek',
                            type: body.type || 'openai_chat_completion',
                            provider_type: 'chat_completion',
                            enable: true,
                            key: [],
                            api_base: body.api_base || 'https://api.deepseek.com/v1',
                            timeout: 120,
                            proxy: '',
                            custom_headers: {},
                            custom_extra_body: {}
                        };
                    if (typeof body.api_base === 'string' && body.api_base.trim()) payload.api_base = body.api_base.trim();
                    if (typeof body.key === 'string' && body.key.trim()) payload.key = [body.key.trim()];
                    if (typeof body.provider === 'string' && body.provider.trim()) payload.provider = body.provider.trim();
                    if (typeof body.type === 'string' && body.type.trim()) payload.type = body.type.trim();
                    const data = await astrbotApi('/api/v1/provider-sources/by-id', 'PUT', payload);
                    log(`供应商配置已保存: ${body.id}`);
                    return sendJson(res, 200, data);
                } catch (error) {
                    log(`供应商配置保存失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/providers') {
                try {
                    const data = await astrbotApi('/api/v1/providers');
                    const list = data.data && Array.isArray(data.data.providers) ? data.data.providers : [];
                    return sendJson(res, 200, {
                        providers: list.map((item) => ({
                            id: item.id,
                            provider: item.provider,
                            source_id: item.provider_source_id || '',
                            model: item.model,
                            enable: item.enable,
                            key: Array.isArray(item.key) ? item.key : []
                        }))
                    });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/provider') {
                try {
                    const body = JSON.parse(await readBody(req));
                    if (!body.id) return sendJson(res, 400, { error: '缺少 id' });
                    const listData = await astrbotApi('/api/v1/providers');
                    const list = listData.data && Array.isArray(listData.data.providers) ? listData.data.providers : [];
                    const provider = list.find((item) => item.id === body.id);
                    if (!provider) return sendJson(res, 404, { error: '没有找到该提供商' });
                    const updated = { ...provider, provider_id: body.id };
                    if (typeof body.key === 'string' && body.key.trim()) updated.key = [body.key.trim()];
                    if (typeof body.model === 'string' && body.model.trim()) updated.model = body.model.trim();
                    const data = await astrbotApi('/api/v1/providers/by-id', 'PUT', updated);
                    log(`模型配置已更新: ${body.id}`);
                    return sendJson(res, 200, data);
                } catch (error) {
                    log(`模型配置更新失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'GET' && url.pathname === '/admin/model-settings') {
                try {
                    const configData = await astrbotApi('/api/v1/system-config');
                    const cfg = (configData.data && configData.data.config) || {};
                    const model = (cfg.agent_runner && cfg.agent_runner.config && cfg.agent_runner.config.model) || {};
                    const listData = await astrbotApi('/api/v1/providers');
                    const providers = listData.data && Array.isArray(listData.data.providers) ? listData.data.providers : [];
                    return sendJson(res, 200, {
                        provider_id: model.provider_id || '',
                        fallback_provider_ids: model.fallback_provider_ids || [],
                        request_max_retries: model.request_max_retries,
                        available: providers.map((item) => ({ id: item.id, model: item.model, enable: item.enable, source_id: item.provider_source_id || '' }))
                    });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/model-settings') {
                try {
                    const body = JSON.parse(await readBody(req));
                    const configData = await astrbotApi('/api/v1/system-config');
                    const cfg = (configData.data && configData.data.config) || {};
                    if (!cfg.agent_runner) cfg.agent_runner = { config: { model: {} } };
                    if (!cfg.agent_runner.config) cfg.agent_runner.config = {};
                    if (!cfg.agent_runner.config.model) cfg.agent_runner.config.model = {};
                    if (typeof body.provider_id === 'string' && body.provider_id.trim()) {
                        cfg.agent_runner.config.model.provider_id = body.provider_id.trim();
                    }
                    if (Array.isArray(body.fallback_provider_ids)) {
                        cfg.agent_runner.config.model.fallback_provider_ids = body.fallback_provider_ids
                            .filter((id) => typeof id === 'string' && id.trim())
                            .map((id) => id.trim());
                    }
                    const result = await astrbotApi('/api/v1/system-config', 'PUT', cfg);
                    log(`模型设置已更新: provider=${body.provider_id || '不变'}`);
                    return sendJson(res, 200, result);
                } catch (error) {
                    log(`模型设置更新失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/napcat/start') {
                try {
                    if (await isPortOpen(6099)) return sendJson(res, 200, { ok: true, already: true });
                    if (!fs.existsSync(config.napcat.launcher)) {
                        return sendJson(res, 400, { error: `NapCat 启动脚本不存在: ${config.napcat.launcher}` });
                    }
                    const child = spawn('cmd.exe', ['/c', config.napcat.launcher], {
                        cwd: config.napcat.dir,
                        windowsHide: true,
                        detached: true,
                        stdio: 'ignore'
                    });
                    child.on('error', (error) => {
                        log(`NapCat 子进程错误: ${error.message}`);
                    });
                    child.unref();
                    log(`已启动 NapCat launcher pid=${child.pid}`);
                    return sendJson(res, 200, { ok: true, pid: child.pid, note: '正在启动 NapCat，稍后查看 QQ 登录状态' });
                } catch (error) {
                    log(`启动 NapCat 失败: ${error.message}`);
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/admin/sessions/attach') {
                try {
                    const body = JSON.parse(await readBody(req));
                    const sessionId = body.sessionId;
                    if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
                    await attachWorkspace(sessionId);
                    return sendJson(res, 200, { ok: true, sessionId });
                } catch (error) {
                    return sendJson(res, 500, { error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/shutdown') {
                return sendJson(res, 400, { ok: false, reason: '插件形态下桥接随 DSH 进程启停，不单独关闭' });
            }

            return sendJson(res, 404, { error: '未知接口' });
        } catch (error) {
            log(`请求处理失败: ${error.stack || error.message}`);
            return sendJson(res, 500, { error: error.message });
        }
    });

    server.listen(config.port, '127.0.0.1', () => {
        log(`桥接插件 HTTP 服务监听 http://127.0.0.1:${config.port}`);
    });

    server.on('close', () => {
        closeAllEventStreams();
    });

    ctx.effect(() => () => {
        shuttingDown = true;
        closeAllEventStreams();
        server.close();
        log('桥接插件已停止');
    });

    log('桥接插件已启动');
}
