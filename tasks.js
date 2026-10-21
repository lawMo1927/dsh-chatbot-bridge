// 任务与报告管理：队列、状态机、最后一条 assistant 文本收集、产物文件收集
import fs from 'node:fs';
import path from 'node:path';

const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export class TaskManager {
    constructor(workspace) {
        this.workspace = workspace;
        this.tasks = new Map();
        this.queue = [];
        this.pendingReports = new Map();
        this.currentTaskId = null;
        this.lastAssistantText = '';
        this.lastSessionTitle = '';
        this.sessionId = null;
    }

    setSession(sessionId) {
        this.sessionId = sessionId;
    }

    createTask({ prompt, umo, fileUmo }) {
        const id = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const task = {
            id,
            prompt,
            umo,
            fileUmo: fileUmo || umo,
            status: 'queued',
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            lastMessage: null,
            error: null
        };
        this.tasks.set(id, task);
        this.queue.push(id);
        return task;
    }

    nextQueued() {
        while (this.queue.length > 0) {
            const id = this.queue.shift();
            const task = this.tasks.get(id);
            if (task && task.status === 'queued') {
                return task;
            }
        }
        return null;
    }

    markRunning(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return;
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        task.startedAtMs = Date.now();
        this.currentTaskId = taskId;
        this.lastAssistantText = '';
    }

    recordAssistantText(text) {
        if (text) {
            this.lastAssistantText = text;
        }
    }

    recordSessionTitle(title) {
        if (typeof title === 'string' && title.trim()) {
            this.lastSessionTitle = title.trim();
        }
    }

    markFinished({ error } = {}) {
        const task = this.currentTaskId ? this.tasks.get(this.currentTaskId) : null;
        this.currentTaskId = null;
        if (!task) return null;

        if (error) {
            task.status = 'failed';
            task.error = error;
        } else {
            task.status = 'completed';
            task.lastMessage = this.lastAssistantText || '（本轮没有产生文本输出）';
        }
        task.finishedAt = new Date().toISOString();

        const text = error
            ? `任务 ${task.id} 执行失败：${error}`
            : task.lastMessage;
        const files = error ? [] : this.collectArtifacts(task.startedAtMs || 0);
        const sessionTitle = this.lastSessionTitle || 'QQ 桥接会话';
        this.pendingReports.set(task.id, { taskId: task.id, umo: task.umo, fileUmo: task.fileUmo, text, files, sessionTitle });
        this.lastAssistantText = '';
        return task;
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
    }

    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }

    getLastCompletedTask() {
        let latest = null;
        for (const task of this.tasks.values()) {
            if (task.status === 'completed' && (!latest || task.finishedAt > latest.finishedAt)) {
                latest = task;
            }
        }
        return latest;
    }

    describeState() {
        return {
            sessionId: this.sessionId,
            currentTaskId: this.currentTaskId,
            queued: this.queue.length,
            pendingReports: this.pendingReports.size
        };
    }
}
