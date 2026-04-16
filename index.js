import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';

const MODULE_NAME = 'third-party/ST-Generation-Retry-Notifier';
const SETTINGS_KEY = 'generationRetryNotifier';
const DEFAULT_RETRY_STATUS_CODES = '408,409,425,429,500,502,503,504,520,521,522,523,524';
const TARGET_PATHS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/backends/koboldhorde/generate',
    '/api/novelai/generate',
    '/api/horde/generate-text',
]);
const DOM_RETRY_DELAYS_MS = [400, 1200, 2500, 5000];
const NOTIFICATION_TAG = 'stgrn-generation';

const DEFAULT_SETTINGS = {
    retry_enabled: true,
    retry_strategy: 'exponential',
    max_retries: 3,
    base_delay_ms: 3000,
    backoff_factor: 2,
    max_delay_ms: 30000,
    jitter_enabled: false,
    jitter_ratio_percent: 20,
    retry_on_network_error: true,
    retry_status_codes: DEFAULT_RETRY_STATUS_CODES,
    show_retry_toasts: true,
    notify_enabled: true,
    notify_when_focused: false,
};

let isInitialized = false;
let originalFetch = null;
let uiBound = false;
let generationSerial = 0;
let pendingGeneration = null;
let latestMessageIdForGeneration = null;
let generationStoppedByUser = false;
let lastNotifiedMessageKey = null;
let chatMutationObserver = null;
let domNotificationTimers = [];
const domMessageState = new Map();

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }

    const settings = extension_settings[SETTINGS_KEY];
    settings.retry_enabled = settings.retry_enabled ?? DEFAULT_SETTINGS.retry_enabled;
    settings.retry_strategy = normalizeRetryStrategy(settings.retry_strategy);
    settings.max_retries = clampNumber(settings.max_retries, 1, 10, DEFAULT_SETTINGS.max_retries);
    settings.base_delay_ms = clampNumber(settings.base_delay_ms, 100, 600000, DEFAULT_SETTINGS.base_delay_ms);
    settings.backoff_factor = clampFloat(settings.backoff_factor, 1.1, 10, DEFAULT_SETTINGS.backoff_factor);
    settings.max_delay_ms = clampNumber(settings.max_delay_ms, 100, 600000, DEFAULT_SETTINGS.max_delay_ms);
    settings.jitter_enabled = settings.jitter_enabled ?? DEFAULT_SETTINGS.jitter_enabled;
    settings.jitter_ratio_percent = clampNumber(settings.jitter_ratio_percent, 0, 100, DEFAULT_SETTINGS.jitter_ratio_percent);
    settings.retry_on_network_error = settings.retry_on_network_error ?? DEFAULT_SETTINGS.retry_on_network_error;
    settings.retry_status_codes = normalizeStatusCodeList(settings.retry_status_codes);
    settings.show_retry_toasts = settings.show_retry_toasts ?? DEFAULT_SETTINGS.show_retry_toasts;
    settings.notify_enabled = settings.notify_enabled ?? DEFAULT_SETTINGS.notify_enabled;
    settings.notify_when_focused = settings.notify_when_focused ?? DEFAULT_SETTINGS.notify_when_focused;
    return settings;
}

function normalizeRetryStrategy(value) {
    const allowedValues = new Set(['fixed', 'linear', 'exponential']);
    return allowedValues.has(value) ? value : DEFAULT_SETTINGS.retry_strategy;
}

function clampNumber(value, min, max, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(numericValue)));
}

function clampFloat(value, min, max, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, numericValue));
}

function normalizeStatusCodeList(value) {
    const normalized = String(value ?? DEFAULT_RETRY_STATUS_CODES)
        .split(',')
        .map(code => code.trim())
        .filter(Boolean)
        .map(code => Number(code))
        .filter(code => Number.isInteger(code) && code >= 100 && code <= 599);

    return normalized.length ? Array.from(new Set(normalized)).join(',') : DEFAULT_RETRY_STATUS_CODES;
}

function getRetryableStatusCodes(settings = getSettings()) {
    return new Set(
        String(settings.retry_status_codes)
            .split(',')
            .map(code => Number(code.trim()))
            .filter(code => Number.isInteger(code)),
    );
}

function getNotificationPermission() {
    if (typeof Notification === 'undefined') {
        return 'unsupported';
    }

    return Notification.permission;
}

function updatePermissionStatus() {
    const permission = getNotificationPermission();
    $('#stgrn_permission_status').text(permission);
    $('#stgrn_request_permission').toggle(permission !== 'granted' && permission !== 'unsupported');
}

function syncUi() {
    const settings = getSettings();

    $('#stgrn_retry_enabled').prop('checked', settings.retry_enabled);
    $('#stgrn_retry_strategy').val(settings.retry_strategy);
    $('#stgrn_max_retries').val(String(settings.max_retries));
    $('#stgrn_base_delay_ms').val(String(settings.base_delay_ms));
    $('#stgrn_backoff_factor').val(String(settings.backoff_factor));
    $('#stgrn_max_delay_ms').val(String(settings.max_delay_ms));
    $('#stgrn_jitter_enabled').prop('checked', settings.jitter_enabled);
    $('#stgrn_jitter_ratio_percent').val(String(settings.jitter_ratio_percent));
    $('#stgrn_retry_on_network_error').prop('checked', settings.retry_on_network_error);
    $('#stgrn_retry_status_codes').val(settings.retry_status_codes);
    $('#stgrn_show_retry_toasts').prop('checked', settings.show_retry_toasts);
    $('#stgrn_notify_enabled').prop('checked', settings.notify_enabled);
    $('#stgrn_notify_when_focused').prop('checked', settings.notify_when_focused);

    $('#stgrn_backoff_factor_row').toggleClass('displayNone', settings.retry_strategy !== 'exponential');
    $('#stgrn_jitter_ratio_row').toggleClass('displayNone', !settings.jitter_enabled);
    $('#stgrn_retry_preview').text(buildRetryPreview(settings));
    updatePermissionStatus();
}

function buildRetryPreview(settings = getSettings()) {
    if (!settings.retry_enabled) {
        return '自动重试已关闭';
    }

    const previewAttempts = Math.min(settings.max_retries, 4);
    const pieces = [];

    for (let attempt = 1; attempt <= previewAttempts; attempt++) {
        pieces.push(`第 ${attempt} 次: ${Math.round(getRetryDelay(attempt, settings, { applyJitter: false }))}ms`);
    }

    if (settings.jitter_enabled) {
        pieces.push(`抖动: ±${settings.jitter_ratio_percent}%`);
    }

    return pieces.join(' | ');
}

function updateAndSave(mutator) {
    mutator(getSettings());
    syncUi();
    saveSettingsDebounced();
}

async function ensureUi() {
    if (!$('#stgrn_settings').length) {
        $('#extensions_settings').append(await renderExtensionTemplateAsync(MODULE_NAME, 'settings'));
    }

    if (uiBound) {
        syncUi();
        return;
    }

    uiBound = true;

    $(document).off('.stgrn');

    $(document).on('change.stgrn', '#stgrn_retry_enabled', function () {
        updateAndSave(settings => { settings.retry_enabled = Boolean($(this).prop('checked')); });
    });

    $(document).on('change.stgrn', '#stgrn_retry_strategy', function () {
        updateAndSave(settings => { settings.retry_strategy = normalizeRetryStrategy($(this).val()); });
    });

    $(document).on('change.stgrn', '#stgrn_max_retries', function () {
        updateAndSave(settings => { settings.max_retries = clampNumber($(this).val(), 1, 10, DEFAULT_SETTINGS.max_retries); });
    });

    $(document).on('change.stgrn', '#stgrn_base_delay_ms', function () {
        updateAndSave(settings => { settings.base_delay_ms = clampNumber($(this).val(), 100, 600000, DEFAULT_SETTINGS.base_delay_ms); });
    });

    $(document).on('change.stgrn', '#stgrn_backoff_factor', function () {
        updateAndSave(settings => { settings.backoff_factor = clampFloat($(this).val(), 1.1, 10, DEFAULT_SETTINGS.backoff_factor); });
    });

    $(document).on('change.stgrn', '#stgrn_max_delay_ms', function () {
        updateAndSave(settings => { settings.max_delay_ms = clampNumber($(this).val(), 100, 600000, DEFAULT_SETTINGS.max_delay_ms); });
    });

    $(document).on('change.stgrn', '#stgrn_jitter_enabled', function () {
        updateAndSave(settings => { settings.jitter_enabled = Boolean($(this).prop('checked')); });
    });

    $(document).on('change.stgrn', '#stgrn_jitter_ratio_percent', function () {
        updateAndSave(settings => { settings.jitter_ratio_percent = clampNumber($(this).val(), 0, 100, DEFAULT_SETTINGS.jitter_ratio_percent); });
    });

    $(document).on('change.stgrn', '#stgrn_retry_on_network_error', function () {
        updateAndSave(settings => { settings.retry_on_network_error = Boolean($(this).prop('checked')); });
    });

    $(document).on('change.stgrn', '#stgrn_retry_status_codes', function () {
        updateAndSave(settings => { settings.retry_status_codes = normalizeStatusCodeList($(this).val()); });
    });

    $(document).on('change.stgrn', '#stgrn_show_retry_toasts', function () {
        updateAndSave(settings => { settings.show_retry_toasts = Boolean($(this).prop('checked')); });
    });

    $(document).on('change.stgrn', '#stgrn_notify_enabled', function () {
        updateAndSave(settings => { settings.notify_enabled = Boolean($(this).prop('checked')); });
    });

    $(document).on('change.stgrn', '#stgrn_notify_when_focused', function () {
        updateAndSave(settings => { settings.notify_when_focused = Boolean($(this).prop('checked')); });
    });

    $(document).on('click.stgrn', '#stgrn_request_permission', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        await requestNotificationPermission();
        syncUi();
    });

    $(document).on('click.stgrn', '#stgrn_test_notification', function (event) {
        event.preventDefault();
        event.stopPropagation();
        sendTestNotification();
    });

    syncUi();
}

async function requestNotificationPermission() {
    if (typeof Notification === 'undefined') {
        toastr.warning('当前浏览器不支持 Notification API。', 'Generation Retry Notifier');
        updatePermissionStatus();
        return;
    }

    try {
        const permission = await Notification.requestPermission();

        if (permission === 'granted') {
            toastr.success('浏览器通知已启用。', 'Generation Retry Notifier');
        } else if (permission === 'denied') {
            toastr.warning('浏览器通知权限被拒绝。', 'Generation Retry Notifier');
        } else {
            toastr.info('浏览器没有授予通知权限。', 'Generation Retry Notifier');
        }
    } catch (error) {
        toastr.error(`请求通知权限失败: ${error?.message || error}`, 'Generation Retry Notifier');
    }

    updatePermissionStatus();
}

function getPathFromRequest(input) {
    const urlString = input instanceof Request ? input.url : String(input);
    const baseUrl = globalThis.location?.origin || 'http://localhost';

    try {
        return new URL(urlString, baseUrl).pathname;
    } catch {
        return '';
    }
}

function getMethod(input, init) {
    return String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function shouldRetryRequest(input, init) {
    const settings = getSettings();

    if (!settings.retry_enabled || getMethod(input, init) !== 'POST') {
        return false;
    }

    return TARGET_PATHS.has(getPathFromRequest(input));
}

function cloneFetchInput(input) {
    return input instanceof Request ? input.clone() : input;
}

function cloneFetchInit(init) {
    if (!init) {
        return undefined;
    }

    return {
        ...init,
        headers: init.headers,
    };
}

function shouldAbort(error) {
    return error?.name === 'AbortError' || error instanceof DOMException && error.name === 'AbortError';
}

function getRetryDelay(attemptNumber, settings = getSettings(), { applyJitter = true } = {}) {
    let delayMs = settings.base_delay_ms;

    if (settings.retry_strategy === 'linear') {
        delayMs = settings.base_delay_ms * attemptNumber;
    } else if (settings.retry_strategy === 'exponential') {
        delayMs = settings.base_delay_ms * (settings.backoff_factor ** (attemptNumber - 1));
    }

    delayMs = Math.min(settings.max_delay_ms, delayMs);

    if (applyJitter && settings.jitter_enabled && settings.jitter_ratio_percent > 0) {
        const jitterRatio = settings.jitter_ratio_percent / 100;
        const jitterOffset = (Math.random() * 2 - 1) * jitterRatio * delayMs;
        delayMs = Math.max(0, delayMs + jitterOffset);
    }

    return delayMs;
}

function showRetryToast(message, settings = getSettings()) {
    if (settings.show_retry_toasts) {
        toastr.warning(message, 'Generation Retry Notifier');
    }
}

async function waitWithAbort(delayMs, signal) {
    if (!signal) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return;
    }

    if (signal.aborted) {
        throw new DOMException('The request was aborted.', 'AbortError');
    }

    await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);

        function onAbort() {
            clearTimeout(timeoutId);
            signal.removeEventListener('abort', onAbort);
            reject(new DOMException('The request was aborted.', 'AbortError'));
        }

        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function beginGenerationTracking() {
    generationSerial += 1;
    pendingGeneration = generationSerial;
    latestMessageIdForGeneration = null;
    generationStoppedByUser = false;
    clearDomNotificationTimers();
}

async function retryingFetch(input, init) {
    const settings = getSettings();
    const maxRetries = settings.max_retries;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const path = getPathFromRequest(input);

    if (!pendingGeneration) {
        beginGenerationTracking();
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await originalFetch(cloneFetchInput(input), cloneFetchInit(init));

            if (response.ok || !getRetryableStatusCodes(settings).has(response.status) || attempt === maxRetries) {
                return response;
            }

            const attemptNumber = attempt + 1;
            const delayMs = getRetryDelay(attemptNumber, settings);
            showRetryToast(`请求失败（HTTP ${response.status}），${Math.round(delayMs)}ms 后重试 ${attemptNumber}/${maxRetries}`, settings);
            await waitWithAbort(delayMs, signal);
        } catch (error) {
            if (shouldAbort(error) || !settings.retry_on_network_error || attempt === maxRetries) {
                throw error;
            }

            const attemptNumber = attempt + 1;
            const delayMs = getRetryDelay(attemptNumber, settings);
            showRetryToast(`请求异常，${Math.round(delayMs)}ms 后重试 ${attemptNumber}/${maxRetries}`, settings);
            await waitWithAbort(delayMs, signal);
        }
    }

    console.warn('[STGRN] unexpected retry loop exit', path);
}

function installFetchPatch() {
    if (originalFetch) {
        return;
    }

    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function wrappedFetch(input, init) {
        if (!shouldRetryRequest(input, init)) {
            return originalFetch(cloneFetchInput(input), cloneFetchInit(init));
        }

        return retryingFetch(input, init);
    };
}

function uninstallFetchPatch() {
    if (!originalFetch) {
        return;
    }

    globalThis.fetch = originalFetch;
    originalFetch = null;
}

function shouldNotify() {
    const settings = getSettings();

    if (!settings.notify_enabled || getNotificationPermission() !== 'granted') {
        return false;
    }

    if (settings.notify_when_focused) {
        return true;
    }

    return document.hidden || !document.hasFocus();
}

function summarizeMessage(message) {
    const text = String(message?.mes ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function dispatchNotification({ title, body, tag = NOTIFICATION_TAG }) {
    if (getNotificationPermission() !== 'granted') {
        return false;
    }

    const notification = new Notification(title, {
        body,
        tag,
        renotify: true,
    });

    notification.onclick = () => {
        if (typeof globalThis.focus === 'function') {
            globalThis.focus();
        }
        notification.close();
    };

    return true;
}

function sendTestNotification() {
    const sent = dispatchNotification({
        title: 'Generation Retry Notifier 测试通知',
        body: `这是一条测试通知。\n时间: ${new Date().toLocaleString()}`,
        tag: `stgrn-test-${Date.now()}`,
    });

    if (sent) {
        toastr.success('测试通知已触发，请检查浏览器或系统通知中心。', 'Generation Retry Notifier');
    } else {
        updatePermissionStatus();
    }
}

function getMessageNotificationKey(message, messageId) {
    return JSON.stringify({
        messageId,
        mes: String(message?.mes ?? '').slice(0, 200),
        send_date: message?.send_date ?? null,
        gen_finished: message?.gen_finished ?? null,
    });
}

function notifyWithMessageData(messageId, message) {
    if (!shouldNotify() || !message || !message.mes) {
        return false;
    }

    const messageKey = getMessageNotificationKey(message, messageId);
    if (messageKey === lastNotifiedMessageKey) {
        return false;
    }

    const title = message.name ? `${message.name} 回复完成` : 'SillyTavern 生成完成';
    const sent = dispatchNotification({
        title,
        body: summarizeMessage(message),
    });

    if (sent) {
        lastNotifiedMessageKey = messageKey;
    }

    return sent;
}

function getAssistantCandidates() {
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const elements = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
    const candidates = [];

    for (const element of elements) {
        const messageId = Number(element.getAttribute('mesid'));
        const isUser = element.getAttribute('is_user') === 'true';
        const classes = element.className || '';
        const text = element.querySelector('.mes_text')?.textContent?.trim() ?? '';

        if (Number.isNaN(messageId) || isUser || classes.includes('smallSysMes')) {
            continue;
        }

        const contextMessage = chat[messageId];
        const extraType = contextMessage?.extra?.type ?? null;
        const isSmallSys = Boolean(contextMessage?.extra?.isSmallSys);
        const isSystemLike = contextMessage?.is_system || isSmallSys || extraType === 'welcome_prompt';

        if (isSystemLike) {
            continue;
        }

        candidates.push({
            messageId,
            text,
            message: contextMessage && contextMessage.mes ? contextMessage : {
                mes: text,
                name: element.getAttribute('ch_name') || 'Assistant',
                send_date: null,
                gen_finished: null,
            },
        });
    }

    return candidates;
}

function snapshotDomMessages() {
    domMessageState.clear();

    for (const candidate of getAssistantCandidates()) {
        domMessageState.set(candidate.messageId, String(candidate.text ?? '').trim());
    }
}

function clearDomNotificationTimers() {
    for (const timerId of domNotificationTimers) {
        clearTimeout(timerId);
    }

    domNotificationTimers = [];
}

function scheduleDelayedDomNotification(messageId, delayMs) {
    const timerId = setTimeout(() => {
        domNotificationTimers = domNotificationTimers.filter(id => id !== timerId);

        if (!pendingGeneration) {
            return;
        }

        const candidate = getAssistantCandidates().find(item => item.messageId === messageId);
        const text = String(candidate?.text ?? '').trim();

        if (!text || ['...', '…'].includes(text)) {
            return;
        }

        notifyWithMessageData(candidate.messageId, candidate.message);
    }, delayMs);

    domNotificationTimers.push(timerId);
}

function scanDomForNotifications() {
    if (!pendingGeneration) {
        snapshotDomMessages();
        return;
    }

    for (const candidate of getAssistantCandidates()) {
        const currentText = String(candidate.text ?? '').trim();
        const previousText = domMessageState.get(candidate.messageId);
        domMessageState.set(candidate.messageId, currentText);

        if (previousText === currentText) {
            continue;
        }

        if (!currentText || ['...', '…'].includes(currentText)) {
            for (const delayMs of DOM_RETRY_DELAYS_MS) {
                scheduleDelayedDomNotification(candidate.messageId, delayMs);
            }
            continue;
        }

        notifyWithMessageData(candidate.messageId, candidate.message);
    }
}

function startChatObserver() {
    const chatRoot = document.getElementById('chat');

    if (!chatRoot) {
        return;
    }

    if (chatMutationObserver) {
        chatMutationObserver.disconnect();
    }

    snapshotDomMessages();
    chatMutationObserver = new MutationObserver(() => {
        scanDomForNotifications();
    });

    chatMutationObserver.observe(chatRoot, {
        childList: true,
        subtree: true,
        characterData: true,
    });
}

function getLatestAssistantMessage() {
    const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];

    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];

        if (!message || message.is_user || !message.mes) {
            continue;
        }

        const extraType = message?.extra?.type ?? null;
        const isSmallSys = Boolean(message?.extra?.isSmallSys);
        if (message?.is_system || isSmallSys || extraType === 'welcome_prompt') {
            continue;
        }

        return { messageId: index, message };
    }

    return null;
}

function onGenerationStarted(type, _params, isDryRun) {
    if (isDryRun || ['quiet', 'impersonate'].includes(type)) {
        return;
    }

    beginGenerationTracking();
}

function onMessageReceived(messageId, type) {
    if (!pendingGeneration || ['command', 'extension', 'quiet', 'impersonate'].includes(type)) {
        return;
    }

    latestMessageIdForGeneration = messageId;
}

function onGenerationStopped() {
    if (!pendingGeneration) {
        return;
    }

    generationStoppedByUser = true;
    clearDomNotificationTimers();
    pendingGeneration = null;
    latestMessageIdForGeneration = null;
}

function onGenerationEnded() {
    if (!pendingGeneration || generationStoppedByUser) {
        clearDomNotificationTimers();
        pendingGeneration = null;
        latestMessageIdForGeneration = null;
        generationStoppedByUser = false;
        return;
    }

    if (latestMessageIdForGeneration !== null) {
        notifyWithMessageData(latestMessageIdForGeneration, getContext().chat?.[latestMessageIdForGeneration]);
    } else {
        const latestMessage = getLatestAssistantMessage();
        if (latestMessage) {
            notifyWithMessageData(latestMessage.messageId, latestMessage.message);
        }
    }

    clearDomNotificationTimers();
    pendingGeneration = null;
    latestMessageIdForGeneration = null;
    generationStoppedByUser = false;
    snapshotDomMessages();
}

async function init() {
    if (isInitialized) {
        await ensureUi();
        return;
    }

    getSettings();
    installFetchPatch();
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    isInitialized = true;
    await ensureUi();
    startChatObserver();
}

function cleanup() {
    if (!isInitialized) {
        return;
    }

    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    uninstallFetchPatch();
    $(document).off('.stgrn');
    clearDomNotificationTimers();

    if (chatMutationObserver) {
        chatMutationObserver.disconnect();
        chatMutationObserver = null;
    }

    $('#stgrn_settings').remove();
    uiBound = false;
    pendingGeneration = null;
    latestMessageIdForGeneration = null;
    generationStoppedByUser = false;
    lastNotifiedMessageKey = null;
    domMessageState.clear();
    isInitialized = false;
}

export async function activate() {
    await init();
}

export async function enable() {
    await init();
}

export async function disable() {
    cleanup();
}
