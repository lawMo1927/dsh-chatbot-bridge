// 任务与报告管理：多会话队列、状态机、回合绑定、最后一条 assistant 文本收集、产物文件收集
import fs from 'node:fs';
import path from 'node:path';

const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_TASK_IDS_PER_SESSION = 50;

export class TaskManager {
    constructor(workspace, reportsFile = '') {
        this.workspace = workspace;
        this.reportsFile = reportsFile;
        this.tasks = new Map();
        this.queue = [];
        this.pendingReports = new Map();
        // sessionId -> 正在执行的任务编号，支持多个会话各自并行
        this.currentBySession = new Map();
        this.sessionTitles = new Map();
        this.assistantTextBySession = new Map();
        this.sessionId = null;
        this.loadReports();
    }

    loadReports() {
        if (!this.reportsFile) return;
        let raw;
        try {
            raw = fs.readFileSync(this.reportsFile, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        const reports = JSON.parse(raw);
        if (!Array.isArray(reports)) throw new Error(`待回传报告文件格式错误: ${this.reportsFile}`);
        for (const report of reports) {
            if (!report || typeof report !== 'object' || !report.taskId) continue;
            this.pendingReports.set(String(report.taskId), report);
        }
    }

    saveReports() {
        if (!this.reportsFile) return;
        const temporary = `${this.reportsFile}.tmp`;
        fs.writeFileSync(
            temporary,
            JSON.stringify(Array.from(this.pendingReports.values()), null, 2),
            'utf8'
        );
        fs.renameSync(temporary, this.reportsFile);
    }

    setSession(sessionId) {
        this.sessionId = sessionId;
    }

    // 默认桥接会话的当前任务，保留旧的单会话字段语义
    get currentTaskId() {
        if (!this.sessionId) return null;
        return this.currentBySession.get(this.sessionId) || null;
    }

    currentTaskFor(sessionId) {
        if (!sessionId) return null;
        return this.currentBySession.get(sessionId) || null;
    }

    runningTasks() {
        const results = [];
        for (const taskId of this.currentBySession.values()) {
            const task = this.tasks.get(taskId);
            if (task && task.status === 'running') results.push(task);
        }
        return results;
    }

    createTask({ prompt, umo, fileUmo, sessionId }) {
        if (!sessionId) throw new Error('创建任务缺少 sessionId');
        const id = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const task = {
            id,
            sessionId,
            prompt,
            umo: umo || '',
            fileUmo: fileUmo || umo || '',
            status: 'queued',
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            startedAtMs: null,
            durationMs: null,
            lastMessage: null,
            error: null,
            phase: '排队等待',
            // 等待回合开始的任务（排队提交），只有匹配到自己的回合才会结束
            awaitTurnStart: false,
            turnNumber: null,
            sessionTitle: this.sessionTitles.get(sessionId) || ''
        };
        this.tasks.set(id, task);
        this.queue.push(id);
        return task;
    }

    nextStartable() {
        this.queue = this.queue.filter((id) => {
            const task = this.tasks.get(id);
            return Boolean(task && task.status === 'queued');
        });
        const index = this.queue.findIndex((id) => {
            const task = this.tasks.get(id);
            return Boolean(task && !this.currentBySession.has(task.sessionId));
        });
        if (index < 0) return null;
        const [id] = this.queue.splice(index, 1);
        return this.tasks.get(id) || null;
    }

    markRunning(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) throw new Error(`任务不存在: ${taskId}`);
        if (task.status !== 'queued') throw new Error(`任务状态不是排队中: ${taskId}`);
        if (this.currentBySession.has(task.sessionId)) {
            throw new Error(`会话 ${task.sessionId} 已有正在执行的任务`);
        }
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        task.startedAtMs = Date.now();
        task.phase = '等待模型响应';
        task.awaitTurnStart = true;
        task.turnNumber = null;
        this.currentBySession.set(task.sessionId, taskId);
        this.assistantTextBySession.set(task.sessionId, '');
        return task;
    }

    // 把提示词追加到正在运行的回合：任务直接进入运行中，并绑定到该回合
    bindRunningTask({ sessionId, prompt, umo, fileUmo, turnNumber }) {
        if (!sessionId) throw new Error('绑定运行中回合缺少 sessionId');
        if (this.currentBySession.has(sessionId)) {
            throw new Error(`会话 ${sessionId} 已有正在执行的任务`);
        }
        const task = this.createTask({ prompt, umo, fileUmo, sessionId });
        const index = this.queue.indexOf(task.id);
        if (index >= 0) this.queue.splice(index, 1);
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        task.startedAtMs = Date.now();
        task.phase = '追加指令';
        task.awaitTurnStart = false;
        task.turnNumber = Number.isInteger(turnNumber) ? turnNumber : null;
        this.currentBySession.set(sessionId, task.id);
        this.assistantTextBySession.set(sessionId, '');
        return task;
    }

    // 排队提交的任务在观察到自己的 turn/start 后绑定回合；追加指令的任务则跟随之后开始的回合
    bindTurn(taskId, turnNumber) {
        const task = taskId ? this.tasks.get(taskId) : null;
        if (!task || task.status !== 'running') return;
        if (!task.awaitTurnStart && task.turnNumber === turnNumber) return;
        task.awaitTurnStart = false;
        task.turnNumber = turnNumber;
        task.phase = `第 ${turnNumber} 回合`;
    }

    recordAssistantText(sessionId, text) {
        if (!sessionId || !text) return;
        this.assistantTextBySession.set(sessionId, text);
    }

    lastAssistantText(sessionId) {
        if (!sessionId) return '';
        return this.assistantTextBySession.get(sessionId) || '';
    }

    recordPhase(taskId, phase) {
        const task = taskId ? this.tasks.get(taskId) : null;
        if (!task || task.status !== 'running') return;
        task.phase = phase;
    }

    recordSessionTitle(sessionId, title) {
        if (!sessionId || typeof title !== 'string' || !title.trim()) return;
        const value = title.trim();
        this.sessionTitles.set(sessionId, value);
        const taskId = this.currentTaskFor(sessionId);
        const task = taskId ? this.tasks.get(taskId) : null;
        if (task) task.sessionTitle = value;
    }

    finishTask(taskId, { error, cancelled = false } = {}) {
        const task = taskId ? this.tasks.get(taskId) : null;
        if (!task) return null;
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return null;
        const index = this.queue.indexOf(task.id);
        if (index >= 0) this.queue.splice(index, 1);

        if (cancelled) {
            task.status = 'cancelled';
            task.error = error || '任务被中断';
        } else if (error) {
            task.status = 'failed';
            task.error = error;
        } else {
            task.status = 'completed';
            task.lastMessage = this.lastAssistantText(task.sessionId) || '（本轮没有产生文本输出）';
        }
        const now = Date.now();
        task.finishedAt = new Date(now).toISOString();
        task.finishedAtMs = now;
        task.durationMs = task.startedAtMs ? now - task.startedAtMs : null;
        task.phase = task.status === 'completed' ? '已完成' : task.status === 'cancelled' ? '已中断' : '已失败';
        if (this.currentBySession.get(task.sessionId) === task.id) {
            this.currentBySession.delete(task.sessionId);
        }

        const text = cancelled
            ? `任务 ${task.id} 已中断`
            : error
                ? `任务 ${task.id} 执行失败：${error}`
                : task.lastMessage;
        const files = error || cancelled ? [] : this.collectArtifacts(task.startedAtMs || 0);
        const sessionTitle = task.sessionTitle || this.sessionTitles.get(task.sessionId) || 'QQ 桥接会话';
        task.sessionTitle = sessionTitle;
        this.pendingReports.set(task.id, {
            taskId: task.id,
            sessionId: task.sessionId,
            umo: task.umo,
            fileUmo: task.fileUmo,
            text,
            files,
            sessionTitle
        });
        this.saveReports();
        this.assistantTextBySession.delete(task.sessionId);
        return task;
    }

    reportForTask(taskId) {
        return this.pendingReports.get(taskId) || null;
    }

    collectArtifacts(sinceMs) {
        const results = [];
        let entries;
        try {
            entries = fs.readdirSync(this.workspace, { withFileTypes: true });
        } catch (error) {
            return results;
        }
        for (const entry of entries) {
            if (!entry.isFile() || entry.name.startsWith('.')) continue;
            const fullPath = path.join(this.workspace, entry.name);
            let stat;
            try {
                stat = fs.statSync(fullPath);
            } catch (error) {
                continue;
            }
            if (stat.mtimeMs < sinceMs - 5000) continue;
            if (stat.size > MAX_ARTIFACT_BYTES) continue;
            results.push({ name: entry.name, path: fullPath, size: stat.size });
        }
        results.sort((a, b) => a.name.localeCompare(b.name));
        return results.slice(0, MAX_ARTIFACTS);
    }

    takeReports() {
        return Array.from(this.pendingReports.values());
    }

    ackReports(taskIds) {
        for (const id of taskIds || []) {
            this.pendingReports.delete(id);
        }
        this.saveReports();
    }

    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }

    listTasks({ sessionId = '', status = '', limit = 50 } = {}) {
        const results = [];
        for (const task of this.tasks.values()) {
            if (sessionId && task.sessionId !== sessionId) continue;
            if (status && task.status !== status) continue;
            results.push(task);
        }
        results.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return results.slice(0, limit);
    }

    taskIdsForSession(sessionId) {
        if (!sessionId) return [];
        const ids = [];
        for (const task of this.tasks.values()) {
            if (task.sessionId === sessionId) ids.push(task.id);
        }
        return ids.slice(-MAX_TASK_IDS_PER_SESSION).reverse();
    }

    taskSummary(task) {
        return {
            taskId: task.id,
            id: task.id,
            sessionId: task.sessionId,
            sessionTitle: task.sessionTitle || this.sessionTitles.get(task.sessionId) || '',
            status: task.status,
            prompt: task.prompt,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            durationMs: task.durationMs,
            error: task.error,
            phase: task.phase
        };
    }

    taskDetail(task) {
        const detail = this.taskSummary(task);
        if (task.lastMessage) {
            detail.lastMessage = task.lastMessage;
        } else if (task.status === 'running') {
            detail.lastMessage = this.lastAssistantText(task.sessionId) || null;
        } else {
            detail.lastMessage = null;
        }
        detail.turnNumber = task.turnNumber;
        return detail;
    }

    getLastCompletedTask(sessionId) {
        const target = sessionId || this.sessionId;
        let latest = null;
        for (const task of this.tasks.values()) {
            if (target && task.sessionId !== target) continue;
            if (task.status !== 'completed') continue;
            if (!latest || Date.parse(task.finishedAt) > Date.parse(latest.finishedAt)) latest = task;
        }
        return latest;
    }

    describeState() {
        return {
            sessionId: this.sessionId,
            currentTaskId: this.currentTaskId,
            queued: this.queue.length,
            pendingReports: this.pendingReports.size,
            running: this.currentBySession.size
        };
    }
}
