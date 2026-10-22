import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_CONFIG_FILE = path.join(__dirname, 'config.json');
let activeConfigFile = null;

function defaultConfig() {
    const home = os.homedir();
    const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
    const dataDir = path.join(dshHome, 'chatbot-bridge');
    const napcatDir = path.join(dataDir, 'napcat');
    return {
        port: 9412,
        workspace: path.join(home, 'dsh-chatbot-workspace'),
        dshHome,
        provider: '',
        model: '',
        stateFile: path.join(dataDir, 'state.json'),
        logFile: path.join(dataDir, 'bridge.log'),
        astrbotLogFile: path.join(dataDir, 'astrbot.log'),
        installDir: path.join(dataDir, 'downloads'),
        taskTimeoutMinutes: 60,
        approvalTimeoutSeconds: 300,
        adminQQ: '',
        qqPath: '',
        astrbot: {
            dir: '',
            exe: '',
            webui: 'http://127.0.0.1:6185'
        },
        napcat: {
            webui: 'http://127.0.0.1:6099',
            token: '',
            dir: napcatDir,
            launcher: path.join(napcatDir, 'launcher.bat'),
            downloadUrl: 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip'
        }
    };
}

function configCandidates() {
    const defaults = defaultConfig();
    const candidates = [
        process.env.DSH_CHATBOT_BRIDGE_CONFIG,
        PACKAGE_CONFIG_FILE,
        path.join(defaults.dshHome, 'chatbot-bridge', 'config.json')
    ];
    return candidates.filter((candidate) => candidate && fs.existsSync(candidate));
}

function mergeConfig(base, override) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override || {})) {
        if (
            value && typeof value === 'object' && !Array.isArray(value)
            && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
        ) {
            merged[key] = { ...base[key], ...value };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function normalizeConfig(config, defaults) {
    if (!config.workspace) config.workspace = defaults.workspace;
    if (!config.dshHome) config.dshHome = defaults.dshHome;
    if (!config.stateFile) config.stateFile = defaults.stateFile;
    if (!config.logFile) config.logFile = defaults.logFile;
    if (!config.astrbotLogFile) config.astrbotLogFile = defaults.astrbotLogFile;
    if (!config.installDir) config.installDir = defaults.installDir;
    return config;
}

export function getConfigFile() {
    return activeConfigFile || PACKAGE_CONFIG_FILE;
}

export function loadConfig() {
    const defaults = defaultConfig();
    const existing = configCandidates();
    if (existing.length > 0) {
        activeConfigFile = existing[0];
        const saved = JSON.parse(fs.readFileSync(activeConfigFile, 'utf8'));
        return normalizeConfig(mergeConfig(defaults, saved), defaults);
    }
    const target = process.env.DSH_CHATBOT_BRIDGE_CONFIG
        || path.join(defaults.dshHome, 'chatbot-bridge', 'config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(defaults, null, 2), 'utf8');
    activeConfigFile = target;
    console.warn(`[chatbot-bridge] 未找到 config.json，已生成默认配置：${target}`);
    return defaults;
}

export function ensureConfigDirs(config) {
    const directories = [
        path.dirname(getConfigFile()),
        config.workspace,
        path.dirname(config.stateFile),
        path.dirname(config.logFile),
        path.dirname(config.astrbotLogFile),
        config.installDir,
        config.napcat && config.napcat.dir
    ];
    for (const directory of directories) {
        if (directory) fs.mkdirSync(directory, { recursive: true });
    }
}

export { PACKAGE_CONFIG_FILE, defaultConfig, mergeConfig };
