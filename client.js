// DSH 客户端插件：侧边栏“聊天机器人”入口与管理页面
window.__ModuleLoader__.load({
    id: "@local/dsh-chatbot-bridge",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        let react = require("react");
        let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

        const PANEL_ID = "chatbot";
        const BRIDGE = "http://127.0.0.1:9412";

        function tabStyle(active) {
            return {
                height: "32px",
                padding: "0 14px",
                borderRadius: "8px",
                border: "1px solid " + (active ? "#4f8cff" : "var(--dsw-alias-border-base)"),
                background: active ? "rgba(79,140,255,0.12)" : "transparent",
                color: active ? "#4f8cff" : "var(--dsw-alias-label-secondary)",
                cursor: "pointer",
                fontSize: "13px"
            };
        }

        const styles = {
            page: {
                height: "100%",
                overflow: "auto",
                padding: "32px 40px",
                color: "var(--dsw-alias-label-primary)",
                background: "var(--dsw-alias-bg-base)",
                fontSize: "14px",
                lineHeight: "1.6"
            },
            title: { fontSize: "24px", fontWeight: 600, marginBottom: "8px" },
            lede: { color: "var(--dsw-alias-label-secondary)", marginBottom: "20px" },
            tabs: { display: "flex", gap: "8px", marginBottom: "24px" },
            card: {
                border: "1px solid var(--dsw-alias-border-base)",
                borderRadius: "12px",
                padding: "20px 24px",
                marginBottom: "16px"
            },
            row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" },
            statusDot: (ok, starting) => ({
                display: "inline-block",
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                marginRight: "10px",
                background: ok ? "#2fbf71" : starting ? "#e6a23c" : "#e05c5c"
            }),
            button: {
                height: "36px",
                padding: "0 18px",
                borderRadius: "8px",
                border: "1px solid var(--dsw-alias-border-base)",
                background: "transparent",
                color: "var(--dsw-alias-label-primary)",
                cursor: "pointer",
                fontSize: "14px",
                marginRight: "10px"
            },
            primaryButton: {
                height: "36px",
                padding: "0 18px",
                borderRadius: "8px",
                border: "none",
                background: "#4f8cff",
                color: "#fff",
                cursor: "pointer",
                fontSize: "14px",
                marginRight: "10px"
            },
            input: {
                width: "100%",
                height: "34px",
                background: "#1b2029",
                color: "var(--dsw-alias-label-primary)",
                border: "1px solid var(--dsw-alias-border-base)",
                borderRadius: "8px",
                padding: "0 10px",
                fontSize: "13px",
                boxSizing: "border-box"
            },
            textarea: {
                width: "100%",
                minHeight: "300px",
                background: "#1b2029",
                color: "var(--dsw-alias-label-primary)",
                border: "1px solid var(--dsw-alias-border-base)",
                borderRadius: "8px",
                padding: "12px",
                fontSize: "13px",
                lineHeight: "1.6",
                fontFamily: "Consolas, monospace",
                resize: "vertical",
                boxSizing: "border-box"
            },
            label: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", marginBottom: "6px" },
            message: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginTop: "12px", wordBreak: "break-all" }
        };

        function ChatbotPanelIcon({ size }) {
            return react.createElement(primitives.IconAgentPresetOutlineRegular, { size });
        }

        function ChatbotPanelPage() {
            const [tab, setTab] = react.useState("process");
            const [status, setStatus] = react.useState(null);
            const [error, setError] = react.useState("");
            const [message, setMessage] = react.useState("");
            const [busy, setBusy] = react.useState(false);
            const [qrImg, setQrImg] = react.useState("");
            const [qrLink, setQrLink] = react.useState("");
            const [logs, setLogs] = react.useState("");

            const [personas, setPersonas] = react.useState([]);
            const [personaId, setPersonaId] = react.useState("");
            const [personaPrompt, setPersonaPrompt] = react.useState("");
            const [personaNew, setPersonaNew] = react.useState(null);

            const [providers, setProviders] = react.useState([]);
            const [providerEdit, setProviderEdit] = react.useState(null);
            const [providerSources, setProviderSources] = react.useState([]);
            const [sourceEdit, setSourceEdit] = react.useState(null);
            const [sourceNew, setSourceNew] = react.useState(null);
            const [modelSettings, setModelSettings] = react.useState(null);
            const [modelSelection, setModelSelection] = react.useState({ provider_id: "", fallback: [] });
            const [env, setEnv] = react.useState(null);
            const [adminQQ, setAdminQQ] = react.useState("");
            const [workspace, setWorkspace] = react.useState("");
            const [advanced, setAdvanced] = react.useState({ astrbotDir: "", astrbotExe: "", napcatWebui: "", napcatToken: "" });
            const [starting, setStarting] = react.useState(false);
            const [settingsLoaded, setSettingsLoaded] = react.useState(false);

            const api = async (path, options) => {
                const response = await fetch(BRIDGE + path, options);
                return response.json();
            };

            const postJson = async (path, payload) => {
                return api(path, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            };

            const refresh = react.useCallback(async () => {
                try {
                    const data = await api("/admin/status");
                    setStatus(data);
                    setError("");
                } catch (err) {
                    setStatus(null);
                    setError("桥接服务不可达：" + String(err));
                }
            }, []);

            const run = async (path) => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await api(path, { method: "POST" });
                    setMessage(JSON.stringify(data));
                    await refresh();
                } catch (err) {
                    setMessage("操作失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const startBot = async () => {
                setStarting(true);
                setMessage("正在启动聊天机器人...");
                try {
                    await api("/admin/astrbot/start", { method: "POST" });
                    const deadline = Date.now() + 90000;
                    let started = false;
                    while (Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                        const data = await api("/admin/status");
                        if (data.astrbot) {
                            started = true;
                            setMessage("聊天机器人已启动");
                            await refresh();
                            break;
                        }
                    }
                    if (!started) {
                        setMessage("启动超时：90 秒内端口 6185 未监听，请查看日志或检查启动程序路径");
                        await refresh();
                    }
                } catch (err) {
                    setMessage("启动失败：" + String(err));
                } finally {
                    setStarting(false);
                }
            };

            const loadQr = async () => {
                setBusy(true);
                try {
                    const data = await api("/admin/qr");
                    if (data.link) {
                        setQrLink(data.link);
                        setQrImg(BRIDGE + "/admin/qr.png?t=" + Date.now());
                        setMessage("二维码已加载");
                    } else {
                        setMessage("获取二维码失败：" + (data.error || "未知错误"));
                    }
                } catch (err) {
                    setMessage("获取二维码失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const loadLogs = async () => {
                try {
                    const data = await api("/admin/logs?lines=200");
                    setLogs(data.log || data.error || "（无日志）");
                } catch (err) {
                    setLogs("读取日志失败：" + String(err));
                }
            };

            const loadEnv = async () => {
                try {
                    const data = await api("/admin/env");
                    setEnv(data);
                } catch (err) {
                    setMessage("环境检测失败：" + String(err));
                }
            };

            const installComponent = async (component) => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/install", { component });
                    setMessage(data.started ? "已开始安装 " + component : "无法安装：" + (data.reason || JSON.stringify(data)));
                    await loadEnv();
                } catch (err) {
                    setMessage("安装请求失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const loadSettings = async () => {
                try {
                    const data = await api("/admin/settings");
                    setAdminQQ(data.adminQQ || "");
                    setWorkspace(data.workspace || "");
                    setAdvanced({
                        astrbotDir: data.astrbotDir || "",
                        astrbotExe: data.astrbotExe || "",
                        napcatWebui: data.napcatWebui || "",
                        napcatToken: data.napcatToken || ""
                    });
                    setSettingsLoaded(true);
                } catch (err) {
                    setMessage("加载设置失败：" + String(err));
                }
            };

            const saveAdminQQ = async () => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/settings", { adminQQ });
                    setMessage(data.ok ? "管理员已保存，重启聊天机器人后生效" : "保存失败：" + JSON.stringify(data));
                    await loadSettings();
                } catch (err) {
                    setMessage("保存管理员失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const saveWorkspace = async () => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/settings", { workspace });
                    setMessage(data.ok ? "工作区已保存，新建会话使用新目录" : "保存失败：" + JSON.stringify(data));
                    await loadSettings();
                } catch (err) {
                    setMessage("保存工作区失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const saveAdvanced = async () => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/settings", advanced);
                    setMessage(data.ok ? "高级设置已保存" : "保存失败：" + JSON.stringify(data));
                    await loadSettings();
                } catch (err) {
                    setMessage("保存高级设置失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const loadPersonaTemplate = async () => {
                try {
                    const data = await api("/admin/persona-template");
                    if (data.template) {
                        setPersonaPrompt(data.template);
                        setMessage("已载入默认模板，保存后生效");
                    } else {
                        setMessage(data.error || "没有默认模板");
                    }
                } catch (err) {
                    setMessage("载入模板失败：" + String(err));
                }
            };

            const installAstrbotPlugin = async () => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/astrbot/plugin/install", {});
                    setMessage(data.ok ? "插件已安装到 AstrBot，重启聊天机器人后生效" : "安装失败：" + (data.error || JSON.stringify(data)));
                    await loadEnv();
                } catch (err) {
                    setMessage("安装失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const loadPersonas = async () => {
                try {
                    const data = await api("/admin/personas");
                    const list = data.personas || [];
                    setPersonas(list);
                    if (list.length > 0 && !personaId) {
                        await selectPersona(list[0].persona_id);
                    }
                } catch (err) {
                    setMessage("加载人格列表失败：" + String(err));
                }
            };

            const selectPersona = async (id) => {
                setPersonaId(id);
                setMessage("");
                try {
                    const data = await api("/admin/persona?id=" + encodeURIComponent(id));
                    setPersonaPrompt(data.persona ? String(data.persona.system_prompt || "") : "");
                } catch (err) {
                    setMessage("加载人格详情失败：" + String(err));
                }
            };

            const savePersona = async () => {
                if (!personaId) return;
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/persona", { persona_id: personaId, system_prompt: personaPrompt });
                    setMessage(data.status === "ok" ? "人格已保存，重新对话后生效" : "保存失败：" + JSON.stringify(data));
                } catch (err) {
                    setMessage("保存人格失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const createPersona = async () => {
                if (!personaNew || !personaNew.id) {
                    setMessage("请填写人格 ID");
                    return;
                }
                setBusy(true);
                setMessage("");
                try {
                    const newId = personaNew.id;
                    const data = await postJson("/admin/persona-create", { persona_id: newId, system_prompt: "你是一个助手。" });
                    if (data.status === "ok") {
                        setMessage("人格已创建，现在可以编辑内容");
                        setPersonaNew(null);
                        await loadPersonas();
                        await selectPersona(newId);
                    } else {
                        setMessage("创建失败：" + JSON.stringify(data));
                    }
                } catch (err) {
                    setMessage("创建人格失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const loadProviders = async () => {
                try {
                    const data = await api("/admin/providers");
                    setProviders(data.providers || []);
                } catch (err) {
                    setMessage("加载模型列表失败：" + String(err));
                }
                await loadModelSettings();
                await loadSources();
            };

            const loadSources = async () => {
                try {
                    const data = await api("/admin/provider-sources");
                    setProviderSources(data.sources || []);
                } catch (err) {
                    setMessage("加载供应商失败：" + String(err));
                }
            };

            const saveSource = async () => {
                if (!sourceEdit) return;
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/provider-source", { id: sourceEdit.id, api_base: sourceEdit.api_base, key: sourceEdit.key });
                    setMessage(data.status === "ok" ? "供应商配置已保存" : "保存失败：" + JSON.stringify(data));
                    setSourceEdit(null);
                    await loadSources();
                } catch (err) {
                    setMessage("保存供应商失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const addSource = async () => {
                if (!sourceNew || !sourceNew.id) {
                    setMessage("请填写供应商名称");
                    return;
                }
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/provider-source", sourceNew);
                    setMessage(data.status === "ok" ? "供应商已添加" : "添加失败：" + JSON.stringify(data));
                    setSourceNew(null);
                    await loadSources();
                } catch (err) {
                    setMessage("添加供应商失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const loadModelSettings = async () => {
                try {
                    const data = await api("/admin/model-settings");
                    setModelSettings(data);
                    setModelSelection({ provider_id: data.provider_id || "", fallback: data.fallback_provider_ids || [] });
                } catch (err) {
                    setMessage("加载模型设置失败：" + String(err));
                }
            };

            const saveModelSelection = async () => {
                setBusy(true);
                setMessage("");
                try {
                    const data = await postJson("/admin/model-settings", {
                        provider_id: modelSelection.provider_id,
                        fallback_provider_ids: modelSelection.fallback
                    });
                    setMessage(data.status === "ok" ? "模型设置已保存，实时生效" : "保存失败：" + JSON.stringify(data));
                    await loadModelSettings();
                } catch (err) {
                    setMessage("保存模型设置失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            const saveProvider = async () => {
                if (!providerEdit) return;
                setBusy(true);
                setMessage("");
                try {
                    const payload = { id: providerEdit.id };
                    if (providerEdit.key) payload.key = providerEdit.key;
                    if (providerEdit.model) payload.model = providerEdit.model;
                    const data = await postJson("/admin/provider", payload);
                    setMessage(data.status === "ok" ? "模型配置已保存" : "保存失败：" + JSON.stringify(data));
                    setProviderEdit(null);
                    await loadProviders();
                } catch (err) {
                    setMessage("保存模型配置失败：" + String(err));
                } finally {
                    setBusy(false);
                }
            };

            react.useEffect(() => {
                if (tab === "process") {
                    refresh();
                    loadSettings();
                    const timer = setInterval(refresh, 5000);
                    return () => clearInterval(timer);
                }
                if (tab === "persona") loadPersonas();
                if (tab === "model") loadProviders();
                if (tab === "logs") loadLogs();
                if (tab === "install") {
                    loadEnv();
                    const timer = setInterval(loadEnv, 2000);
                    return () => clearInterval(timer);
                }
            }, [tab]);

            const astrbotOk = status ? Boolean(status.astrbot) : false;
            const napcatOk = status ? Boolean(status.napcat) : false;
            const qqOk = status && status.qq ? Boolean(status.qq.isLogin) : false;
            const qqReachable = status && status.qq ? Boolean(status.qq.reachable) : false;
            const qqStarting = status && status.qq ? Boolean(status.qq.starting) : false;

            const tabs = [
                ["process", "进程"],
                ["install", "安装"],
                ["persona", "人格"],
                ["model", "模型与 API"],
                ["logs", "日志"]
            ];

            const adminCard = react.createElement(
                "div",
                { style: styles.card },
                react.createElement("div", { style: styles.label }, "管理员 QQ"),
                react.createElement(
                    "div",
                    { style: { display: "flex", gap: "10px", alignItems: "center" } },
                    react.createElement("input", {
                        style: { ...styles.input, flex: 1, minWidth: 0 },
                        placeholder: "机器人只响应这个 QQ 号发起的任务",
                        value: adminQQ,
                        onChange: (event) => setAdminQQ(event.target.value)
                    }),
                    react.createElement("button", {
                        style: { ...styles.primaryButton, flexShrink: 0, marginRight: 0 },
                        disabled: busy,
                        onClick: saveAdminQQ
                    }, "保存")
                ),
                react.createElement("div", { style: { ...styles.label, marginTop: "16px" } }, "工作区目录"),
                react.createElement(
                    "div",
                    { style: { display: "flex", gap: "10px", alignItems: "center" } },
                    react.createElement("input", {
                        style: { ...styles.input, flex: 1, minWidth: 0 },
                        placeholder: "机器人执行任务的目录，例如 D:\\bot-workspace",
                        value: workspace,
                        onChange: (event) => setWorkspace(event.target.value)
                    }),
                    react.createElement("button", {
                        style: { ...styles.primaryButton, flexShrink: 0, marginRight: 0 },
                        disabled: busy,
                        onClick: saveWorkspace
                    }, "保存")
                ),
                react.createElement(
                    "div",
                    { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginTop: "8px" } },
                    settingsLoaded ? "管理员修改后需要重启聊天机器人；工作区对之后新建的会话生效" : "正在读取设置..."
                )
            );

            const processTab = react.createElement(
                "div",
                null,
                adminCard,
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement(
                            "div",
                            null,
                            react.createElement(
                                "div",
                                { style: { fontWeight: 600 } },
                                react.createElement("span", { style: styles.statusDot(astrbotOk) }),
                                "聊天机器人进程"
                            ),
                            react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } },
                                astrbotOk ? "在线（端口 6185）" : "离线")
                        ),
                        react.createElement(
                            "div",
                            null,
                            react.createElement("button", {
                                style: styles.primaryButton,
                                disabled: busy || astrbotOk || starting,
                                onClick: startBot
                            }, starting ? "正在启动..." : "启动"),
                            react.createElement("button", {
                                style: styles.button,
                                disabled: busy || !astrbotOk,
                                onClick: () => run("/admin/astrbot/stop")
                            }, "停止"),
                            react.createElement("button", {
                                style: styles.button,
                                disabled: busy,
                                onClick: () => run("/admin/astrbot/restart")
                            }, "重启")
                        )
                    )
                ),
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement(
                            "div",
                            null,
                            react.createElement(
                                "div",
                                { style: { fontWeight: 600 } },
                                react.createElement("span", { style: styles.statusDot(napcatOk) }),
                                "NapCat 协议端"
                            ),
                            react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } },
                                napcatOk ? "运行中（端口 6099）" : "未运行")
                        ),
                        react.createElement(
                            "div",
                            null,
                            react.createElement("button", {
                                style: styles.button,
                                disabled: busy,
                                onClick: () => run("/admin/napcat/start")
                            }, "启动 NapCat")
                        )
                    )
                ),
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement(
                            "div",
                            null,
                            react.createElement(
                                "div",
                                { style: { fontWeight: 600 } },
                                react.createElement("span", { style: styles.statusDot(qqOk, qqStarting) }),
                                "QQ 登录状态"
                            ),
                            react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } },
                                !qqReachable ? (qqStarting ? "正在启动" : "NapCat 不可达") : qqOk ? "已登录" : "未登录，需要扫码")
                        ),
                        react.createElement(
                            "div",
                            null,
                            react.createElement("button", {
                                style: styles.button,
                                disabled: busy,
                                onClick: loadQr
                            }, "获取二维码")
                        )
                    ),
                    qrImg
                        ? react.createElement("img", {
                            src: qrImg,
                            alt: "QQ 登录二维码",
                            style: {
                                marginTop: "12px",
                                width: "220px",
                                height: "220px",
                                borderRadius: "8px",
                                border: "1px solid var(--dsw-alias-border-base)",
                                background: "#ffffff"
                            }
                        })
                        : null,
                    qrLink
                        ? react.createElement(
                            "div",
                            { style: { marginTop: "12px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", wordBreak: "break-all" } },
                            "二维码链接：",
                            react.createElement("a", { href: qrLink, target: "_blank", rel: "noreferrer", style: { color: "#4f8cff" } }, qrLink)
                        )
                        : null
                ),
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement("div", { style: { fontWeight: 600 } }, "桥接服务"),
                        react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } },
                            status ? "运行中 · 端口 9412" : "不可达")
                    )
                )
            );

            const personaTab = react.createElement(
                "div",
                null,
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: { ...styles.row, marginBottom: "8px" } },
                        react.createElement("div", { style: styles.label }, "选择人格"),
                        react.createElement("button", {
                            style: styles.button,
                            disabled: busy,
                            onClick: () => setPersonaNew(personaNew ? null : { id: "" })
                        }, personaNew ? "收起" : "新建人格")
                    ),
                    personaNew
                        ? react.createElement(
                            "div",
                            { style: { display: "flex", gap: "10px", marginBottom: "12px" } },
                            react.createElement("input", {
                                style: { ...styles.input, flex: 1, minWidth: 0 },
                                placeholder: "人格 ID，例如 kefu",
                                value: personaNew.id,
                                onChange: (event) => setPersonaNew({ ...personaNew, id: event.target.value })
                            }),
                            react.createElement("button", {
                                style: { ...styles.primaryButton, flexShrink: 0, marginRight: 0 },
                                disabled: busy,
                                onClick: createPersona
                            }, "创建")
                        )
                        : null,
                    react.createElement(
                        "div",
                        { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px" } },
                        personas.length === 0
                            ? react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px" } }, "没有读取到人格，先启动聊天机器人进程")
                            : personas.map((item) => react.createElement("button", {
                                key: item.persona_id,
                                style: tabStyle(item.persona_id === personaId),
                                onClick: () => selectPersona(item.persona_id)
                            }, item.persona_id))
                    ),
                    react.createElement("div", { style: styles.label }, "人格系统提示词"),
                    react.createElement("textarea", {
                        style: styles.textarea,
                        value: personaPrompt,
                        onChange: (event) => setPersonaPrompt(event.target.value)
                    }),
                    react.createElement(
                        "div",
                        { style: { marginTop: "12px" } },
                        react.createElement("button", {
                            style: styles.primaryButton,
                            disabled: busy || !personaId,
                            onClick: savePersona
                        }, "保存人格"),
                        react.createElement("button", {
                            style: styles.button,
                            disabled: busy,
                            onClick: loadPersonaTemplate
                        }, "载入默认模板"),
                        react.createElement("button", {
                            style: styles.button,
                            disabled: busy,
                            onClick: () => selectPersona(personaId)
                        }, "放弃修改")
                    )
                )
            );

            const modelTab = (() => {
                const available = modelSettings && modelSettings.available ? modelSettings.available : [];
                const fallbackList = modelSelection.fallback || [];
                const groupedAvailable = (() => {
                    const groups = {};
                    for (const item of available) {
                        const source = item.source_id || "其他";
                        if (!groups[source]) groups[source] = [];
                        groups[source].push(item);
                    }
                    return Object.entries(groups);
                })();

                const iconStyle = {
                    width: "32px",
                    height: "32px",
                    borderRadius: "8px",
                    background: "rgba(79,140,255,0.12)",
                    border: "1px solid var(--dsw-alias-border-base)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#4f8cff",
                    fontSize: "13px",
                    fontWeight: 600
                };

                const sourceRow = (item) => react.createElement(
                    "div",
                    { key: item.id, style: { borderTop: "1px solid var(--dsw-alias-border-base)" } },
                    react.createElement(
                        "div",
                        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "14px 0" } },
                        react.createElement(
                            "div",
                            { style: { display: "flex", alignItems: "center", gap: "12px" } },
                            react.createElement("div", { style: iconStyle }, item.id.slice(0, 1).toUpperCase()),
                            react.createElement(
                                "div",
                                null,
                                react.createElement("div", { style: { fontWeight: 600, fontSize: "14px" } }, item.id),
                                react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } },
                                    (item.api_base || "（未设置 API 地址）") + " · " +
                                    (Array.isArray(item.key) && item.key.length > 0 ? String(item.key[0]).slice(0, 8) + "..." : "未配置 Key"))
                            )
                        ),
                        react.createElement("button", {
                            style: styles.button,
                            disabled: busy,
                            onClick: () => setSourceEdit(sourceEdit && sourceEdit.id === item.id ? null : { id: item.id, api_base: item.api_base || "", key: "" })
                        }, sourceEdit && sourceEdit.id === item.id ? "收起" : "配置")
                    ),
                    sourceEdit && sourceEdit.id === item.id
                        ? react.createElement(
                            "div",
                            { style: { paddingBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" } },
                            react.createElement("div", { style: styles.label }, "API 地址"),
                            react.createElement("input", {
                                style: styles.input,
                                value: sourceEdit.api_base,
                                onChange: (event) => setSourceEdit({ ...sourceEdit, api_base: event.target.value })
                            }),
                            react.createElement("div", { style: styles.label }, "API Key（留空不修改）"),
                            react.createElement("input", {
                                style: styles.input,
                                type: "password",
                                placeholder: "新的 API Key",
                                value: sourceEdit.key,
                                onChange: (event) => setSourceEdit({ ...sourceEdit, key: event.target.value })
                            }),
                            react.createElement(
                                "div",
                                { style: { marginTop: "4px" } },
                                react.createElement("button", { style: styles.primaryButton, disabled: busy, onClick: saveSource }, "保存"),
                                react.createElement("button", { style: styles.button, disabled: busy, onClick: () => setSourceEdit(null) }, "取消")
                            )
                        )
                        : null
                );

                const addSourceCard = react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement("div", { style: { fontWeight: 600 } }, "添加供应商"),
                        react.createElement("button", {
                            style: styles.button,
                            disabled: busy,
                            onClick: () => setSourceNew(sourceNew ? null : { id: "", api_base: "https://api.deepseek.com/v1", key: "", provider: "deepseek", type: "openai_chat_completion" })
                        }, sourceNew ? "收起" : "添加")
                    ),
                    sourceNew
                        ? react.createElement(
                            "div",
                            { style: { marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" } },
                            react.createElement("div", { style: styles.label }, "名称（唯一标识，例如 openrouter）"),
                            react.createElement("input", {
                                style: styles.input,
                                value: sourceNew.id,
                                onChange: (event) => setSourceNew({ ...sourceNew, id: event.target.value })
                            }),
                            react.createElement("div", { style: styles.label }, "API 地址"),
                            react.createElement("input", {
                                style: styles.input,
                                value: sourceNew.api_base,
                                onChange: (event) => setSourceNew({ ...sourceNew, api_base: event.target.value })
                            }),
                            react.createElement("div", { style: styles.label }, "API Key"),
                            react.createElement("input", {
                                style: styles.input,
                                type: "password",
                                value: sourceNew.key,
                                onChange: (event) => setSourceNew({ ...sourceNew, key: event.target.value })
                            }),
                            react.createElement(
                                "div",
                                null,
                                react.createElement("button", { style: styles.primaryButton, disabled: busy, onClick: addSource }, "添加"),
                                react.createElement("button", { style: styles.button, disabled: busy, onClick: () => setSourceNew(null) }, "取消")
                            )
                        )
                        : null
                );

                return react.createElement(
                    "div",
                    null,
                    react.createElement(
                        "div",
                        { style: styles.card },
                        react.createElement("div", { style: styles.label }, "当前模型"),
                        react.createElement("select", {
                            style: styles.input,
                            value: modelSelection.provider_id,
                            onChange: (event) => setModelSelection({ ...modelSelection, provider_id: event.target.value })
                        },
                            react.createElement("option", { value: "" }, "（未设置）"),
                            groupedAvailable.map(([source, items]) => react.createElement(
                                "optgroup",
                                { key: source, label: source },
                                items.map((item) => react.createElement("option", { key: item.id, value: item.id }, item.model || item.id))
                            ))
                        ),
                        react.createElement("div", { style: { ...styles.label, marginTop: "16px" } }, "降级列表（按勾选顺序补位）"),
                        available.filter((item) => item.id !== modelSelection.provider_id).map((item) => react.createElement(
                            "label",
                            { key: item.id, style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", fontSize: "13px" } },
                            react.createElement("input", {
                                type: "checkbox",
                                checked: fallbackList.includes(item.id),
                                onChange: (event) => {
                                    const next = new Set(fallbackList);
                                    if (event.target.checked) next.add(item.id); else next.delete(item.id);
                                    setModelSelection({ ...modelSelection, fallback: Array.from(next) });
                                }
                            }),
                            item.id,
                            fallbackList.includes(item.id)
                                ? react.createElement("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-secondary)" } }, "第 " + (fallbackList.indexOf(item.id) + 1) + " 顺位")
                                : null
                        )),
                        react.createElement(
                            "div",
                            { style: { marginTop: "14px" } },
                            react.createElement("button", { style: styles.primaryButton, disabled: busy, onClick: saveModelSelection }, "保存模型设置")
                        )
                    ),
                    react.createElement(
                        "div",
                        { style: styles.card },
                        react.createElement("div", { style: styles.label }, "供应商"),
                        providerSources.length === 0
                            ? react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px" } }, "没有读取到供应商，先启动聊天机器人进程")
                            : providerSources.map(sourceRow)
                    ),
                    addSourceCard
                );
            })();

            const logsTab = react.createElement(
                "div",
                null,
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement("div", { style: { fontWeight: 600 } }, "运行日志"),
                        react.createElement("button", {
                            style: styles.button,
                            disabled: busy,
                            onClick: loadLogs
                        }, "刷新")
                    ),
                    react.createElement("pre", {
                        style: {
                            marginTop: "12px",
                            maxHeight: "480px",
                            overflow: "auto",
                            background: "#0b0d12",
                            border: "1px solid var(--dsw-alias-border-base)",
                            borderRadius: "8px",
                            padding: "12px",
                            fontSize: "12px",
                            lineHeight: "1.5",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-all"
                        }
                    }, logs || "（加载中）")
                )
            );

            const envItems = env ? [
                ["uv", "uv 包管理器", env.uv.installed],
                ["astrbot", "AstrBot 聊天机器人", env.astrbot.installed],
                ["napcat", "NapCat 协议端", env.napcat.installed],
                ["qq", "QQ 客户端", env.qq.installed]
            ] : [];

            const installTab = react.createElement(
                "div",
                null,
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement("div", { style: styles.label }, "环境检测"),
                    envItems.length === 0
                        ? react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px" } }, "检测中...")
                        : envItems.map(([key, label, ok]) => react.createElement(
                            "div",
                            { key, style: { ...styles.row, padding: "10px 0", borderTop: "1px solid var(--dsw-alias-border-base)" } },
                            react.createElement(
                                "div",
                                null,
                                react.createElement("span", { style: styles.statusDot(ok) }),
                                label
                            ),
                            react.createElement(
                                "div",
                                null,
                                react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginRight: "12px" } },
                                    ok ? "已安装" : ((env.install && env.install[key]) === "running" ? "安装中..." : (env.install && env.install[key]) === "failed" ? "安装失败" : "未安装")),
                                !ok && key !== "qq"
                                    ? react.createElement("button", {
                                        style: styles.primaryButton,
                                        disabled: busy || (env.install && env.install[key] === "running"),
                                        onClick: () => installComponent(key)
                                    }, "安装")
                                    : null
                            )
                        ))
                ),
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement(
                        "div",
                        { style: styles.row },
                        react.createElement(
                            "div",
                            null,
                            react.createElement("div", { style: { fontWeight: 600 } }, "AstrBot 桥接插件"),
                            react.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" } },
                                "把任务转交能力装进聊天机器人，安装到 AstrBot 插件目录")
                        ),
                        react.createElement("button", {
                            style: styles.primaryButton,
                            disabled: busy || !(env && env.astrbot && env.astrbot.installed),
                            onClick: installAstrbotPlugin
                        }, "安装")
                    )
                ),
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement("div", { style: styles.label }, "说明"),
                    react.createElement(
                        "div",
                        { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "1.8" } },
                        "uv 用于安装 AstrBot，缺失时可以点安装自动完成。",
                        react.createElement("br", null),
                        "QQ 客户端需要手动安装，检测常见目录与运行中的进程。",
                        react.createElement("br", null),
                        "NapCat 会从 GitHub 下载最新发布包并解压到配置目录，网络慢时可能失败，可重试。",
                        react.createElement("br", null),
                        "全部就绪后到“进程”页启动进程，并用二维码扫码登录。"
                    )
                ),
                react.createElement(
                    "div",
                    { style: styles.card },
                    react.createElement("div", { style: styles.label }, "高级设置"),
                    react.createElement("div", { style: { ...styles.label, marginTop: "4px" } }, "聊天机器人目录"),
                    react.createElement("input", {
                        style: styles.input,
                        value: advanced.astrbotDir,
                        onChange: (event) => setAdvanced({ ...advanced, astrbotDir: event.target.value })
                    }),
                    react.createElement("div", { style: { ...styles.label, marginTop: "10px" } }, "聊天机器人启动程序"),
                    react.createElement("input", {
                        style: styles.input,
                        value: advanced.astrbotExe,
                        onChange: (event) => setAdvanced({ ...advanced, astrbotExe: event.target.value })
                    }),
                    react.createElement("div", { style: { ...styles.label, marginTop: "10px" } }, "NapCat 管理地址"),
                    react.createElement("input", {
                        style: styles.input,
                        value: advanced.napcatWebui,
                        onChange: (event) => setAdvanced({ ...advanced, napcatWebui: event.target.value })
                    }),
                    react.createElement("div", { style: { ...styles.label, marginTop: "10px" } }, "NapCat token"),
                    react.createElement("input", {
                        style: styles.input,
                        type: "password",
                        value: advanced.napcatToken,
                        onChange: (event) => setAdvanced({ ...advanced, napcatToken: event.target.value })
                    }),
                    react.createElement(
                        "div",
                        { style: { marginTop: "14px" } },
                        react.createElement("button", {
                            style: styles.primaryButton,
                            disabled: busy,
                            onClick: saveAdvanced
                        }, "保存高级设置")
                    )
                ),
                env && env.installLog && Object.keys(env.installLog).length > 0
                    ? react.createElement(
                        "div",
                        { style: styles.card },
                        react.createElement("div", { style: styles.label }, "最近安装输出"),
                        react.createElement("pre", {
                            style: {
                                maxHeight: "200px",
                                overflow: "auto",
                                background: "#0b0d12",
                                border: "1px solid var(--dsw-alias-border-base)",
                                borderRadius: "8px",
                                padding: "12px",
                                fontSize: "12px",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all"
                            }
                        }, Object.entries(env.installLog).map(([k, v]) => k + ":\n" + v).join("\n\n"))
                    )
                    : null
            );

            let content = processTab;
            if (tab === "install") content = installTab;
            if (tab === "persona") content = personaTab;
            if (tab === "model") content = modelTab;
            if (tab === "logs") content = logsTab;

            return react.createElement(
                "div",
                { style: styles.page },
                react.createElement("div", { style: styles.title }, "聊天机器人"),
                react.createElement("div", { style: styles.lede }, "启动进程、管理 QQ 登录、调整人格与模型配置。"),
                react.createElement(
                    "div",
                    { style: styles.tabs },
                    tabs.map(([key, label]) => react.createElement("button", {
                        key,
                        style: tabStyle(tab === key),
                        onClick: () => setTab(key)
                    }, label))
                ),
                error ? react.createElement("div", { style: { color: "#e05c5c", marginBottom: "16px" } }, error) : null,
                content,
                message ? react.createElement("div", { style: styles.message }, message) : null
            );
        }

        const apply = (ctx) => {
            ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 1,
                label: () => "聊天机器人"
            }, ChatbotPanelIcon));
            ctx.slots.inject("main", function* () {
                yield ctx.slots.register({
                    name: "main",
                    key: PANEL_ID
                }, ChatbotPanelPage);
            });
        };

        const inject = ["slots"];

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
