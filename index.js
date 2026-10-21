// DSH 聊天机器人桥接插件：在 DSH 进程内提供任务派发、结果回传、审批与聊天机器人管理
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TaskManager } from './tasks.js';

export const name = 'dsh-chatbot-bridge';
export const inject = ['sessionController', 'sessions', 'agents', 'approval', 'workspaceRegistry'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
    const file = path.join(__dirname, 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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

function extractAssistantText(event) {
    const blocks = event?.data?.message?.content || [];
    return blocks
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('');
}

export function apply(ctx, pluginConfig) {
    const config = { ...loadConfig(), ...(pluginConfig || {}) };
    const log = createLogger(config.logFile);
    const manager = new TaskManager(config.workspace);
    const pendingApprovals = new Map();
    let approvalSeq = 1;
    let shuttingDown = false;
    let sessionReady = null;
    let spawnState = { astrbot: null };

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

    async function submitPrompt(text, mode) {
        const sessionId = await ensureSession();
        const requestId = `qq-req-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
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
        if (manager.currentTaskId) return;
        const task = manager.nextQueued();
        if (!task) return;
        manager.markRunning(task.id);
        submitPrompt(task.prompt, 'queue')
            .then((info) => {
                log(`任务 ${task.id} 已提交 session=${info.sessionId}`);
            })
            .catch((error) => {
                log(`任务 ${task.id} 提交失败: ${error.message}`);
                manager.markFinished({ error: error.message });
                setImmediate(pumpQueue);
            });
    }

    function completeCurrentTask(reason) {
        if (!manager.currentTaskId) return;
        const finished = manager.markFinished(reason ? { error: reason } : undefined);
        if (finished) {
            log(`任务 ${finished.id} 结束 status=${finished.status}`);
        }
        setImmediate(pumpQueue);
    }

    const eventDisposer = ctx.on('session/event', (session, event) => {
        const sessionId = manager.sessionId;
        if (!sessionId || session.header?.id !== sessionId) return;

        if (event.type === 'assistant/message') {
            const text = extractAssistantText(event);
            manager.recordAssistantText(text);
            return;
        }

        if (event.type === 'session/title') {
            manager.recordSessionTitle(event.data?.title);
            return;
        }

        if (event.type === 'turn/end') {
            const reason = event.data?.reason;
            if (reason === 'error') {
                completeCurrentTask('回合异常结束');
            } else {
                completeCurrentTask();
            }
        }
    });
    ctx.effect(() => eventDisposer);

    const NEVER = new Promise(() => {});

    const approvalDisposer = ctx.on('approval/request', async (req, next) => {
        if (!manager.sessionId) return next();
        const id = `approval_${Date.now()}_${approvalSeq++}`;
        log(`收到审批请求 ${id}: tool=${req.toolName} reason=${req.reason}`);

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

        const qqPromise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingApprovals.delete(id);
                resolve('rejected');
            }, config.approvalTimeoutSeconds * 1000);
            pendingApprovals.set(id, {
                id,
                toolName: String(req.toolName || ''),
                reason: String(req.reason || ''),
                callId: req.callId ? String(req.callId) : '',
                createdAt: new Date().toISOString(),
                resolve: (value) => {
                    clearTimeout(timer);
                    pendingApprovals.delete(id);
                    resolve(value);
                }
            });
        });

        const outcome = await Promise.race([pagePromise, qqPromise]);
        pendingApprovals.delete(id);
        log(`审批 ${id} 结果: ${outcome}`);
        return outcome === 'allow' || outcome === 'allowed-once' ? 'allowed-once' : 'rejected';
    }, { prepend: true });
    ctx.effect(() => approvalDisposer);

    const timeoutTimer = setInterval(() => {
        if (!manager.currentTaskId) return;
        const task = manager.getTask(manager.currentTaskId);
        if (!task || !task.startedAt) return;
        const elapsedMs = Date.now() - Date.parse(task.startedAt);
        if (elapsedMs > config.taskTimeoutMinutes * 60_000) {
            log(`任务 ${task.id} 超时，标记失败`);
            completeCurrentTask(`任务超时（${config.taskTimeoutMinutes} 分钟）`);
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

    async function listSessions() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const value = await ctx.sessionController.list({}, controller.signal);
            const flags = workspaceFlags();
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
                    running: item.running
                }));
            return items;
        } finally {
            clearTimeout(timer);
        }
    }

    async function napcatLogin() {
        const token = config.napcat.token;
        const sha = crypto.createHash('sha256');
        const hash = sha.update(token + '.napcat').digest('hex');
        const login = await fetch(config.napcat.webui + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash })
        }).then((r) => r.json());
        if (login.code !== 0) return null;
        return login.data.Credential;
    }

    async function napcatApi(apiPath, credential, body) {
        const response = await fetch(config.napcat.webui + apiPath, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${credential}`
            },
            body: JSON.stringify(body || {})
        });
        return response.json();
    }

    async function getQqStatus() {
        try {
            const credential = await napcatLogin();
            if (!credential) return { reachable: false };
            const status = await napcatApi('/api/QQLogin/CheckLoginStatus', credential);
            const data = status.data || {};
            return {
                reachable: true,
                isLogin: Boolean(data.isLogin),
                loginPhase: data.loginPhase || '',
                qrcodeurl: data.qrcodeurl || ''
            };
        } catch (error) {
            return { reachable: false, error: error.message };
        }
    }

    async function getQrCode() {
        try {
            const credential = await napcatLogin();
            if (!credential) return { error: 'NapCat 不可达' };
            try {
                await napcatApi('/api/QQLogin/RefreshQRcode', credential);
            } catch (error) {
                // 刷新失败时继续尝试读取现有二维码
            }
            const qr = await napcatApi('/api/QQLogin/GetQQLoginQrcode', credential);
            if (qr.code !== 0 || !qr.data || !qr.data.qrcode) {
                return { error: qr.message || '没有二维码' };
            }
            return { link: qr.data.qrcode };
        } catch (error) {
            return { error: error.message };
        }
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

    async function checkEnv() {
        const uv = findUv();
        const qqPath = findQq();
        return {
            uv: { installed: Boolean(uv), path: uv || '' },
            astrbot: { installed: fs.existsSync(config.astrbot.exe), path: config.astrbot.exe },
            napcat: { installed: fs.existsSync(config.napcat.launcher), dir: config.napcat.dir, launcher: config.napcat.launcher },
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
        const logStream = fs.openSync(config.astrbotLogFile, 'a');
        const child = spawn(config.astrbot.exe, ['run'], {
            cwd: config.astrbot.dir,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', logStream, logStream]
        });
        child.unref();
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
                const task = manager.createTask({ prompt: body.prompt.trim(), umo: body.umo || '', fileUmo: body.fileUmo || '' });
                log(`收到任务 ${task.id} from=${body.umo || 'unknown'}`);
                setImmediate(pumpQueue);
                return sendJson(res, 200, { taskId: task.id, status: 'queued' });
            }

            if (req.method === 'GET' && url.pathname.startsWith('/task/')) {
                const taskId = url.pathname.slice('/task/'.length);
                const task = manager.getTask(taskId);
                if (!task) return sendJson(res, 404, { error: '任务不存在' });
                return sendJson(res, 200, task);
            }

            if (req.method === 'POST' && url.pathname === '/task/cancel') {
                if (!manager.currentTaskId) {
                    return sendJson(res, 200, { ok: false, reason: '当前没有正在执行的任务' });
                }
                const taskId = manager.currentTaskId;
                try {
                    await ctx.sessionController.cancel({ sessionId: manager.sessionId });
                    manager.markFinished({ error: '任务被中断' });
                    log(`任务 ${taskId} 已中断`);
                    setImmediate(pumpQueue);
                    return sendJson(res, 200, { ok: true, taskId });
                } catch (error) {
                    return sendJson(res, 500, { ok: false, error: error.message });
                }
            }

            if (req.method === 'POST' && url.pathname === '/task/continue') {
                const body = JSON.parse(await readBody(req));
                const answer = typeof body.answer === 'string' && body.answer.trim() ? body.answer.trim() : '请继续刚才中断的任务';
                if (manager.currentTaskId) {
                    return sendJson(res, 409, { ok: false, error: '还有任务正在执行' });
                }
                const task = manager.createTask({ prompt: answer, umo: body.umo || '', fileUmo: body.fileUmo || '' });
                log(`继续任务 ${task.id}: ${answer}`);
                setImmediate(pumpQueue);
                return sendJson(res, 200, { ok: true, taskId: task.id });
            }

            if (req.method === 'POST' && url.pathname === '/progress') {
                const body = JSON.parse(await readBody(req));
                const question = typeof body.question === 'string' ? body.question.trim() : '';
                if (manager.currentTaskId) {
                    if (question) {
                        try {
                            await submitPrompt(question, 'steer');
                            log(`进度询问已插话: ${question}`);
                        } catch (error) {
                            log(`进度插话失败: ${error.message}`);
                        }
                    }
                    const task = manager.getTask(manager.currentTaskId);
                    return sendJson(res, 200, {
                        status: 'running',
                        taskId: task ? task.id : null,
                        reply: manager.lastAssistantText || null
                    });
                }
                const last = manager.getLastCompletedTask();
                return sendJson(res, 200, {
                    status: last ? 'completed' : 'idle',
                    taskId: last ? last.id : null,
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
                const pending = Array.from(pendingApprovals.values()).map((item) => ({
                    id: item.id,
                    toolName: item.toolName,
                    reason: item.reason,
                    callId: item.callId,
                    createdAt: item.createdAt
                }));
                return sendJson(res, 200, { pending });
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

            if (req.method === 'POST' && url.pathname === '/sessions/operate') {
                const body = JSON.parse(await readBody(req));
                const sessionId = body.sessionId;
                if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
                if (sessionId === manager.sessionId) {
                    return sendJson(res, 400, { error: '这是机器人自己的会话，请用任务工具操作' });
                }
                if (body.action === 'prompt') {
                    const requestId = `qq-req-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
                    const controller = new AbortController();
                    await ctx.sessionController.prompt({
                        requestId,
                        sessionId,
                        mode: 'queue',
                        content: [{ type: 'text', text: body.prompt || '请继续处理当前任务。' }]
                    }, controller.signal);
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
                const qq = await getQqStatus();
                return sendJson(res, 200, {
                    astrbot: await isPortOpen(6185),
                    napcat: await isPortOpen(6099),
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
                    model: config.model
                });
            }

            if (req.method === 'POST' && url.pathname === '/admin/settings') {
                try {
                    const body = JSON.parse(await readBody(req));
                    if (typeof body.adminQQ === 'string') {
                        config.adminQQ = body.adminQQ.trim();
                        const configFile = path.join(__dirname, 'config.json');
                        const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
                        data.adminQQ = config.adminQQ;
                        fs.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf8');
                        log(`管理员 QQ 已更新: ${config.adminQQ}`);
                    }
                    return sendJson(res, 200, { ok: true, adminQQ: config.adminQQ || '' });
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
                        fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
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
                const qr = await getQrCode();
                if (!qr.link) return sendJson(res, 404, qr);
                try {
                    execFileSync(config.pythonExe, [config.qrScript, qr.link, config.qrImageFile], { timeout: 20000 });
                    const png = fs.readFileSync(config.qrImageFile);
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
                    const child = spawn('cmd.exe', ['/c', config.napcat.launcher], {
                        cwd: config.napcat.dir,
                        windowsHide: true,
                        detached: true,
                        stdio: 'ignore'
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

    ctx.effect(() => () => {
        shuttingDown = true;
        server.close();
        log('桥接插件已停止');
    });

    log('桥接插件已启动');
}
