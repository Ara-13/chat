const pathParts = window.location.pathname.split('/');
const activeChatId = pathParts[2];
let chatInfo = {
    name: '',
    membersCount: 0,
    members : [],
    memberDetails: {},
    currentMember: null,
    onlineMembers: [],
    onlineCount: 0,
};

function setChatTheme(theme) {
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = normalizedTheme;
}

setChatTheme(localStorage.getItem('chat-theme'));

function applyChatInfo(data) {
    chatInfo.name = data.name || '';
    const rawMembers = Array.isArray(data.members) ? data.members : [];
    chatInfo.members = [...new Set(rawMembers
        .map(member => typeof member === 'string' ? member : member?.username || member?.name)
        .filter(Boolean))];
    chatInfo.memberDetails = Object.fromEntries(rawMembers
        .filter(member => member && typeof member === 'object' && member.username)
        .map(member => [member.username, member]));
    chatInfo.currentMember = data.current_member
        || chatInfo.memberDetails[currentUsername]
        || null;
    chatInfo.membersCount = Number.isFinite(Number(data.members_count))
        ? Number(data.members_count)
        : chatInfo.members.length;
    updateChatHeader();
    applyComposerPermissions();
}

async function ensureChatMembership() {
    const token = localStorage.getItem('token');
    if (!token) {
        location.replace('/auth/login');
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(activeChatId)}/info`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (res.status === 401) {
            location.replace('/auth/login');
            return;
        }

        if (!res.ok) {
            console.error('Chat info error');
            return;
        }

        const data = await res.json();
        applyChatInfo(data);
        if (!data.is_member) {
            location.replace(`/rooms/join/${activeChatId}`);
        }
    } catch (err) {
        console.error('Membership check failed', err);
    }
}

async function openGroupMembers() {
    const trigger = document.getElementById('groupProfileTrigger');
    if (trigger) trigger.disabled = true;

    try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(activeChatId)}/info`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.status === 401) {
            location.replace('/auth/login');
            return;
        }

        if (!response.ok) throw new Error('دریافت اعضای گروه انجام نشد');
        applyChatInfo(await response.json());
        createMembersModal(chatInfo.members);
    } catch (error) {
        if (chatInfo.members.length) createMembersModal(chatInfo.members);
        else window.alert(error.message || 'خطا در دریافت اعضای گروه');
    } finally {
        if (trigger) trigger.disabled = false;
    }
}

const token = localStorage.getItem('token');
if (!token) {
    location.replace('/auth/login');
    throw new Error('Not authenticated');
}

let currentUsername = null;
let socket = null;
let socketReconnectTimer = null;
let shouldReconnectSocket = true;
const SOCKET_RECONNECT_DELAY = 5_000;
let isLazyLoading = false;
let isBatchRendering = false;
let pendingReplies = [];
let savedScrollPositions = {};
let hasRestoredInitialPositions = false;
const seenMessageIds = new Set();
let initialUnreadMessageId = null;
let stateSyncTimer = null;
let positionSaveTimer = null;
let activeHistoryFilter = 'all';
const historyScrollPositions = { all: null, music: null, file: null };
const historyPages = {
    all: { cursor: null, hasMore: true, loaded: false },
    music: { cursor: null, hasMore: true, loaded: false },
    file: { cursor: null, hasMore: true, loaded: false }
};
const replyNavigationTargets = { main: null };
const pinnedMessages = new Map();
let visiblePinnedMessageId = null;
let attentionMessageIds = [];
let pendingAttentionMessageId = null;
let mentionSuggestionState = { start: -1, end: -1, matches: [], activeIndex: 0 };

function loadPendingReplies() {
    const stillPending = [];

    pendingReplies.forEach(item => {
        const { messageElement, replyData } = item;
        const container = document.getElementById('messagesContainer');

        if (!container) {
            stillPending.push(item);
            return;
        }

        const target = document.querySelector(
            `[data-message-id="${replyData.id}"]`
        );

        const messageContent = messageElement.querySelector('.message-content');

        // از ساخت چندباره ریپلای جلوگیری کن.
        if (messageElement.querySelector('.message-reply-indicator')) {
            return;
        }

        // اطلاعات خلاصه‌ی ریپلای همراه پیام از سرور می‌آید؛ حتی اگر پیام مرجع
        // هنوز در صفحه لود نشده باشد، باکس ریپلای باید فوراً دیده شود.
        const replyIndicator = document.createElement('div');
        replyIndicator.className = 'message-reply-indicator';
        replyIndicator.setAttribute('data-reply-to', replyData.id);
        if (target) replyIndicator.classList.add('resolved');
        applyUserTheme(replyIndicator, replyData.sender, 'reply');
        const replySender = document.createElement('div');
        replySender.className = 'reply-sender';
        const replyIcon = document.createElement('i');
        replyIcon.className = 'fas fa-reply';
        replySender.append(replyIcon, document.createTextNode(replyData.sender || 'ناشناس'));

        const replyText = document.createElement('div');
        replyText.className = 'reply-text';
        replyText.textContent = replyData.text || '';
        replyIndicator.append(replySender, replyText);

        replyIndicator.addEventListener('click', () => {
            scrollToMessage(replyData.id, 'main', messageElement.dataset.messageId);
        });

        const messageBubble = messageElement.querySelector('.message-bubble');
        if (messageContent && messageBubble) {
            messageBubble.insertBefore(replyIndicator, messageBubble.firstChild);
        } else {
            (messageBubble || messageElement).insertAdjacentElement('afterbegin', replyIndicator);
        }
    });

    // 🔴 نکته حیاتی
    pendingReplies = stillPending;
}

try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    currentUsername = payload.username;
} catch (e) {
    console.error('Invalid token payload');
}

async function initChatSocket() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    await ensureChatMembership();

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${location.host}/ws?chat_id=${activeChatId}&token=${token}`;

    updateConnectionStatus('connecting');
    const activeSocket = new WebSocket(wsUrl);
    socket = activeSocket;
    window.socket = socket;

    socket.onopen = () => {
        if (socket !== activeSocket) return;
        console.log('WS connected');
        clearTimeout(socketReconnectTimer);
        socketReconnectTimer = null;
        updateConnectionStatus('connected');
        pendingReplies = [];
    };

    socket.onmessage = (e) => {
        if (socket !== activeSocket) return;
        console.log('WS RAW:', JSON.parse(e.data));
        let payload;
        try {
            payload = JSON.parse(e.data);
        } catch (err) {
            console.error('Invalid WS message', e.data);
            return;
        }

        const {
            event, data, positions, hasMore, cursor,
            filter = 'all', reset = false, pinnedMessages: initialPinnedMessages,
            unreadMessageId, attentionMessageIds: initialAttentionMessageIds, error
        } = payload;

        if (event === 'error' && pendingAttentionMessageId) {
            if (error?.code === 'MESSAGE_NOT_FOUND') consumeAttentionMessage(pendingAttentionMessageId);
            pendingAttentionMessageId = null;
            updateAttentionJumpButton();
            return;
        }

        if (event === 'error') {
            const permissionErrors = {
                MESSAGE_RESTRICTED: 'ارسال پیام متنی شما توسط ادمین غیرفعال شده است.',
                MEDIA_RESTRICTED: 'ارسال محتوای شما توسط ادمین غیرفعال شده است.',
                MEMBERSHIP_REVOKED: 'شما دیگر عضو این گروه نیستید.'
            };
            if (permissionErrors[error?.code]) window.alert(permissionErrors[error.code]);
            return;
        }

        // =========================
        // LOAD_MORE
        // =========================
        if (event === 'load_more') {
            const pageState = historyPages[filter];
            if (!pageState) return;
            if (!Array.isArray(data) || data.length === 0) {
                pageState.hasMore = false;
                pageState.loaded = true;
                isLazyLoading = false;
                applyHistoryFilter();
                return;
            }
            pageState.hasMore = hasMore !== false;
            pageState.cursor = cursor || null;
            pageState.loaded = true;

            // مرتب‌سازی
            data.sort((a, b) => {
                const timeDifference = new Date(a.createdAt) - new Date(b.createdAt);
                return timeDifference || String(a.id).localeCompare(String(b.id));
            });

            isBatchRendering = true;
            const container = document.getElementById('messagesContainer');
            const previousHeight = container.scrollHeight;

            // prepend صحیح (قدیمی‌ترها بالا)
            data.forEach(msg => {
                renderMessageFromServer(msg, false, filter);
            });

            isBatchRendering = false;
            applyHistoryFilter();
            if (!reset) {
                const addedHeight = container.scrollHeight - previousHeight;
                if (addedHeight > 0) container.scrollTop += addedHeight;
            } else {
                container.scrollTop = container.scrollHeight;
            }
            isLazyLoading = false;
            scheduleViewportStateSync();

            return;
        }

        // =========================
        // HISTORY
        // =========================
        if (event === 'history') {
            const shouldRestoreInitialPosition = !hasRestoredInitialPositions;
            historyPages.all.hasMore = hasMore !== false;
            historyPages.all.cursor = cursor || null;
            historyPages.all.loaded = true;
            savedScrollPositions = positions && typeof positions === 'object' ? positions : {};
            initialUnreadMessageId = unreadMessageId || null;
            attentionMessageIds = Array.isArray(initialAttentionMessageIds)
                ? [...new Set(initialAttentionMessageIds.filter(id => typeof id === 'string'))]
                : [];
            pendingAttentionMessageId = null;
            updateAttentionJumpButton();
            pinnedMessages.clear();
            if (Array.isArray(initialPinnedMessages)) {
                initialPinnedMessages.forEach(message => pinnedMessages.set(message.id, message));
            }
            renderPinnedMessageBar();
            if (!Array.isArray(data) || data.length === 0) {
                loadPendingReplies();
                hasRestoredInitialPositions = true;
                applyHistoryFilter();
                return;
            }

            isBatchRendering = true;

            data.sort((a, b) => {
                const timeDifference = new Date(a.createdAt) - new Date(b.createdAt);
                return timeDifference || String(a.id).localeCompare(String(b.id));
            });

            data.forEach(msg => {
                renderMessageFromServer(msg, false);
            });

            requestAnimationFrame(() => {
                if (shouldRestoreInitialPosition) restoreAllScrollPositions();
                scheduleViewportStateSync();
            });

            isBatchRendering = false;
            applyHistoryFilter();
            isLazyLoading = false;
            loadPendingReplies();
            return;
        }

        // =========================
        // MESSAGE REALTIME
        // =========================
        if (event === 'message') {
            const container = document.getElementById('messagesContainer');
            const shouldFollow = data?.sender === currentUsername || isNearBottom(container);
            renderMessageFromServer(data, shouldFollow, 'all');
            applyHistoryFilter();
            scheduleViewportStateSync();
            return;
        }

        if (event === 'attention_message') {
            if (!data?.id) return;
            renderMessageFromServer(data, false, 'all');
            applyHistoryFilter();
            if (pendingAttentionMessageId === data.id) {
                pendingAttentionMessageId = null;
                consumeAttentionMessage(data.id);
                window.requestAnimationFrame(() => scrollToMessage(data.id, 'main'));
            }
            return;
        }

        if (event === 'messages_seen') {
            applySeenReceipt(data);
            return;
        }

        if (event === 'message_updated') {
            updateMessageInDom(data);
            return;
        }

        if (event === 'message_deleted') {
            removeMessageFromDom(data?.id);
            return;
        }

        if (event === 'member_permissions_updated') {
            applyMemberPermissionsUpdate(data);
            return;
        }

        if (event === 'member_removed') {
            handleMemberRemoved(data);
            return;
        }

        if (event === 'message_reaction') {
            updateMessageReactionInDom(data);
            return;
        }

        if (event === 'message_pin_updated') {
            updateMessagePinInDom(data);
            return;
        }

        if (event === 'presence') {
            updateOnlineMembers(data);
            return;
        }
    };

    socket.onerror = (err) => {
        if (socket !== activeSocket) return;
        console.error('WS error', err);
        updateConnectionStatus('disconnected');
        scheduleSocketReconnect();
    };

    socket.onclose = event => {
        if (socket !== activeSocket) return;
        console.warn('WS closed');
        if (event.code === 4003) {
            shouldReconnectSocket = false;
            location.replace(`/rooms/join/${encodeURIComponent(activeChatId)}`);
            return;
        }
        updateConnectionStatus('disconnected');
        scheduleSocketReconnect();
    };
}

function scheduleSocketReconnect() {
    if (!shouldReconnectSocket || socketReconnectTimer) return;

    socketReconnectTimer = window.setTimeout(() => {
        socketReconnectTimer = null;
        if (!shouldReconnectSocket) return;
        updateConnectionStatus('connecting');
        initChatSocket();
    }, SOCKET_RECONNECT_DELAY);
}

// ==============================================
// متغیرهای عمومی و انتخاب المان‌ها
// ==============================================
const chatArea = document.getElementById('chatArea');

// متغیرهای وضعیت
let currentReply = { page: null, messageId: null, sender: null, text: null };
let currentFile = { page: null, file: null, fileName: null, fileSize: null };
let currentEditing = null;
let isSendingMessage = false;
const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;
let isDragging = false;
let dragStartX = 0;
let currentDragMessage = null;
let currentAudio = null;
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceRecordingStartedAt = 0;
let voiceRecordingTimer = null;
let discardVoiceRecording = false;
let isStartingVoiceRecording = false;

// ==============================================
// تابع‌های کمکی عمومی
// ==============================================
function updateChatHeader() {
    const groupName = chatInfo.name || 'گروه';
    const title = document.getElementById('groupTitle');
    const members = document.getElementById('groupMembersCount');
    const avatarLetter = document.getElementById('groupAvatarLetter');
    const trigger = document.getElementById('groupProfileTrigger');

    if (title) title.textContent = groupName;
    if (members) members.textContent = `${chatInfo.membersCount.toLocaleString('fa-IR')} عضو`;
    if (avatarLetter) avatarLetter.textContent = groupName.trim().charAt(0) || 'گ';
    if (trigger) trigger.setAttribute('aria-label', `نمایش اعضای ${groupName}`);
}

function updateOnlineMembers(data) {
    const wrapper = document.getElementById('groupOnlineCount');
    const text = document.getElementById('groupOnlineCountText');
    if (!wrapper || !text) return;

    const onlineMembers = Array.isArray(data?.onlineMembers)
        ? [...new Set(data.onlineMembers.filter(Boolean))]
        : [];
    const onlineCount = Number.isFinite(Number(data?.onlineCount))
        ? Math.max(0, Number(data.onlineCount))
        : onlineMembers.length;

    chatInfo.onlineMembers = onlineMembers;
    chatInfo.onlineCount = onlineCount;

    text.textContent = `${onlineCount.toLocaleString('fa-IR')} آنلاین`;
    wrapper.hidden = false;
    wrapper.title = onlineMembers.length
        ? `آنلاین: ${onlineMembers.join('، ')}`
        : 'هیچ عضوی آنلاین نیست';
    wrapper.setAttribute('aria-label', wrapper.title);
    updateMembersModalPresence();
}

function updateMembersModalPresence() {
    const modal = document.getElementById('chatMembersModal');
    if (!modal) return;

    const onlineMembers = new Set(chatInfo.onlineMembers);
    modal.querySelectorAll('li[data-username]').forEach(item => {
        const isOnline = onlineMembers.has(item.dataset.username);
        item.classList.toggle('online', isOnline);
        const badge = item.querySelector('.member-online-status');
        if (badge) badge.hidden = !isOnline;
    });

    const count = modal.querySelector('.members-count-label');
    if (count) {
        count.textContent = `${chatInfo.membersCount.toLocaleString('fa-IR')} عضو · ${chatInfo.onlineCount.toLocaleString('fa-IR')} آنلاین`;
    }
}

function canCurrentMember(permission) {
    return chatInfo.currentMember?.[permission] !== false;
}

function applyComposerPermissions() {
    const input = document.getElementById('messageInput');
    const attachmentButton = document.getElementById('attachmentBtn');
    const canSendMessages = canCurrentMember('can_send_messages');
    const canSendMedia = canCurrentMember('can_send_media');

    if (input) {
        input.disabled = !canSendMessages;
        input.placeholder = canSendMessages
            ? 'پیام بنویسید…'
            : 'ارسال پیام متنی توسط ادمین غیرفعال شده است';
    }
    if (attachmentButton) {
        attachmentButton.disabled = !canSendMedia || isSendingMessage;
        attachmentButton.title = canSendMedia
            ? 'ضمیمه فایل'
            : 'ارسال محتوا توسط ادمین غیرفعال شده است';
    }
    if (!canSendMedia && currentFile.file) clearFilePreview('chat');
    if (input) syncComposerState(input);
}

function applyMemberPermissionsUpdate(member) {
    if (!member?.username) return;
    chatInfo.memberDetails[member.username] = member;
    if (member.username === currentUsername) {
        chatInfo.currentMember = member;
        applyComposerPermissions();
    }
    if (document.getElementById('chatMembersModal')) createMembersModal(chatInfo.members);
}

function handleMemberRemoved(data) {
    if (!data?.username) return;
    chatInfo.members = chatInfo.members.filter(username => username !== data.username);
    delete chatInfo.memberDetails[data.username];
    chatInfo.membersCount = chatInfo.members.length;
    updateChatHeader();

    if (data.username === currentUsername) {
        shouldReconnectSocket = false;
        window.alert('شما توسط ادمین از گروه حذف شدید.');
        location.replace(`/rooms/join/${encodeURIComponent(activeChatId)}`);
        return;
    }
    if (document.getElementById('chatMembersModal')) createMembersModal(chatInfo.members);
}

function updateConnectionStatus(state) {
    const status = document.getElementById('connectionStatus');
    if (!status) return;

    const labels = {
        connecting: 'در حال تلاش برای اتصال',
        connected: 'متصل',
        disconnected: 'قطع‌شده — در حال تلاش برای اتصال'
    };
    const normalizedState = Object.hasOwn(labels, state) ? state : 'disconnected';
    status.classList.remove('connecting', 'connected', 'disconnected');
    status.classList.add(normalizedState);
    const avatarDot = document.querySelector('.online-dot');
    avatarDot?.classList.remove('connecting', 'connected', 'disconnected');
    avatarDot?.classList.add(normalizedState);
    const label = status.querySelector('.connection-status-label');
    if (label) label.textContent = labels[normalizedState];
    status.title = `وضعیت WebSocket: ${labels[normalizedState]}`;
}
// تاریخ و زمان پیام (فرمت واحد)
function formatMessageDateTime(date = new Date()) {
    return new Intl.DateTimeFormat('fa-IR', {
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

function getLocalDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDayDivider(date = new Date()) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const dateKey = getLocalDateKey(date);
    if (dateKey === getLocalDateKey(today)) return 'امروز';
    if (dateKey === getLocalDateKey(yesterday)) return 'دیروز';

    const options = {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    };

    if (date.getFullYear() !== today.getFullYear()) {
        options.year = 'numeric';
    }

    return new Intl.DateTimeFormat('fa-IR', options).format(date);
}

function rebuildDateDividers(container) {
    container.querySelectorAll('.date-divider, .unread-divider').forEach(divider => divider.remove());

    let previousDateKey = null;
    const messages = Array.from(container.querySelectorAll('.message:not(.filter-hidden)'));
    const earliestLoadedUnread = messages.find(message => message.dataset.wasUnreadAtOpen === 'true');
    if (activeHistoryFilter === 'all' && earliestLoadedUnread) {
        initialUnreadMessageId = earliestLoadedUnread.dataset.messageId;
    }

    messages.forEach(message => {
        const date = new Date(message.getAttribute('data-created-at'));
        if (Number.isNaN(date.getTime())) return;

        const dateKey = getLocalDateKey(date);
        if (dateKey === previousDateKey) return;

        const divider = document.createElement('div');
        divider.className = 'date-divider';
        divider.setAttribute('role', 'separator');
        divider.setAttribute('data-date-key', dateKey);
        divider.textContent = formatDayDivider(date);
        container.insertBefore(divider, message);
        previousDateKey = dateKey;

        if (activeHistoryFilter === 'all' && message.dataset.messageId === initialUnreadMessageId) {
            insertUnreadDivider(container, message);
        }
    });

    const unreadTarget = initialUnreadMessageId
        ? container.querySelector(`[data-message-id="${CSS.escape(initialUnreadMessageId)}"]`)
        : null;
    if (activeHistoryFilter === 'all' && unreadTarget && !unreadTarget.previousElementSibling?.classList.contains('unread-divider')) {
        insertUnreadDivider(container, unreadTarget);
    }
}

function insertUnreadDivider(container, targetMessage) {
    const divider = document.createElement('div');
    divider.className = 'unread-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', 'پیام‌های خوانده‌نشده');
    divider.innerHTML = '<span>پیام‌های خوانده‌نشده</span>';
    container.insertBefore(divider, targetMessage);
}

function messageMatchesHistoryFilter(message, filter = activeHistoryFilter) {
    if (filter === 'all') {
        return (message.dataset.loadedFor || '').split(' ').includes('all');
    }
    return message.dataset.messageType === filter;
}

function applyHistoryFilter() {
    const container = document.getElementById('messagesContainer');
    if (!container) return;

    container.querySelectorAll('.message').forEach(message => {
        message.classList.toggle('filter-hidden', !messageMatchesHistoryFilter(message));
    });
    const hasVisibleMessages = Boolean(container.querySelector('.message:not(.filter-hidden)'));
    const pageState = historyPages[activeHistoryFilter];
    container.classList.toggle('filter-empty', !hasVisibleMessages);
    container.dataset.emptyLabel = pageState.loaded
        ? (activeHistoryFilter === 'all' ? 'هنوز پیامی فرستاده نشده است' : 'موردی در این گفت‌وگو پیدا نشد')
        : 'در حال بارگذاری…';
    rebuildDateDividers(container);
}

function setHistoryFilter(filter) {
    if (!historyPages[filter]) return;
    const container = document.getElementById('messagesContainer');
    historyScrollPositions[activeHistoryFilter] = container?.scrollTop ?? null;
    activeHistoryFilter = filter;
    const isFiltered = filter !== 'all';
    const labels = { music: 'موسیقی‌های ارسال‌شده در همین گفت‌وگو', file: 'فایل‌های ارسال‌شده در همین گفت‌وگو' };

    chatArea.classList.toggle('filtered-view', isFiltered);
    const banner = document.getElementById('historyFilter');
    const label = document.getElementById('historyFilterLabel');
    if (banner) banner.hidden = !isFiltered;
    if (label) label.textContent = labels[filter] || '';

    ['music', 'file'].forEach(name => {
        const button = document.getElementById(`${name}Btn`);
        const active = filter === name;
        button?.classList.toggle('active', active);
        button?.setAttribute('aria-pressed', String(active));
    });

    applyHistoryFilter();
    if (historyScrollPositions[filter] == null) {
        container.scrollTop = container.scrollHeight;
    } else {
        container.scrollTop = historyScrollPositions[filter];
    }

    const pageState = historyPages[filter];
    if (!pageState.loaded && socket?.readyState === WebSocket.OPEN) {
        isLazyLoading = true;
        socket.send(JSON.stringify({ event: 'load_more', filter, reset: true }));
    } else {
        scheduleViewportStateSync();
    }
    adjustMessagesHeight();
}

function getUserTheme(username = '') {
    const value = String(username || 'ناشناس');
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    const hue = (hash >>> 0) % 360;
    return {
        color: `hsl(${hue} 68% 40%)`,
        soft: `hsl(${hue} 78% 95%)`
    };
}

function applyUserTheme(element, username, namespace = 'user') {
    const theme = getUserTheme(username);
    element.style.setProperty(`--${namespace}-color`, theme.color);
    element.style.setProperty(`--${namespace}-soft`, theme.soft);
}

function isMentionBoundary(character) {
    return !character || !/[\p{L}\p{N}_]/u.test(character);
}

function getMentionRanges(content) {
    const ranges = [];
    const members = [...new Set(chatInfo.members.filter(Boolean))]
        .sort((a, b) => b.length - a.length);

    members.forEach(username => {
        const token = `@${username}`;
        const searchableContent = content.toLocaleLowerCase();
        const searchableToken = token.toLocaleLowerCase();
        let fromIndex = 0;
        while (fromIndex < content.length) {
            const start = searchableContent.indexOf(searchableToken, fromIndex);
            if (start < 0) break;
            const end = start + token.length;
            if (isMentionBoundary(content[start - 1]) && isMentionBoundary(content[end])) {
                ranges.push({ start, end, username });
            }
            fromIndex = Math.max(end, start + 1);
        }
    });

    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    return ranges.filter((range, index, all) => !index || range.start >= all[index - 1].end);
}

function renderMessageContent(element, content = '') {
    const text = String(content || '');
    const ranges = getMentionRanges(text);
    if (!ranges.length) {
        element.textContent = text;
        return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    ranges.forEach(range => {
        if (range.start > cursor) fragment.append(document.createTextNode(text.slice(cursor, range.start)));
        const mention = document.createElement('span');
        mention.className = 'message-mention';
        mention.dataset.username = range.username;
        mention.textContent = text.slice(range.start, range.end);
        fragment.append(mention);
        cursor = range.end;
    });
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    element.replaceChildren(fragment);
}

function getMentionQuery(input) {
    const caret = input.selectionStart;
    if (!Number.isInteger(caret)) return null;
    const beforeCaret = input.value.slice(0, caret);
    const match = beforeCaret.match(/(^|[^\p{L}\p{N}_@])@([^\s@]*)$/u);
    if (!match) return null;
    return {
        query: match[2].toLocaleLowerCase('fa'),
        start: caret - match[2].length - 1,
        end: caret
    };
}

function closeMentionSuggestions() {
    const list = document.getElementById('mentionSuggestions');
    if (list) {
        list.hidden = true;
        list.replaceChildren();
    }
    mentionSuggestionState = { start: -1, end: -1, matches: [], activeIndex: 0 };
}

function selectMentionSuggestion(index = mentionSuggestionState.activeIndex) {
    const input = document.getElementById('messageInput');
    const username = mentionSuggestionState.matches[index];
    if (!input || !username) return false;

    const before = input.value.slice(0, mentionSuggestionState.start);
    const after = input.value.slice(mentionSuggestionState.end);
    const insertion = `@${username} `;
    input.value = before + insertion + after;
    const caret = before.length + insertion.length;
    input.setSelectionRange(caret, caret);
    closeMentionSuggestions();
    autoResizeTextarea(input);
    syncComposerState(input);
    input.focus();
    return true;
}

function renderMentionSuggestions(input) {
    const list = document.getElementById('mentionSuggestions');
    const mention = getMentionQuery(input);
    if (!list || !mention) {
        closeMentionSuggestions();
        return;
    }

    const matches = chatInfo.members
        .filter(username => username !== currentUsername)
        .filter(username => username.toLocaleLowerCase('fa').includes(mention.query))
        .slice(0, 8);
    if (!matches.length) {
        closeMentionSuggestions();
        return;
    }

    mentionSuggestionState = { ...mention, matches, activeIndex: 0 };
    list.replaceChildren(...matches.map((username, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `mention-suggestion${index === 0 ? ' active' : ''}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === 0));
        option.textContent = username;
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => selectMentionSuggestion(index));
        return option;
    }));
    list.hidden = false;
}

function moveMentionSuggestion(direction) {
    const state = mentionSuggestionState;
    if (!state.matches.length) return;
    state.activeIndex = (state.activeIndex + direction + state.matches.length) % state.matches.length;
    document.querySelectorAll('.mention-suggestion').forEach((option, index) => {
        const active = index === state.activeIndex;
        option.classList.toggle('active', active);
        option.setAttribute('aria-selected', String(active));
        if (active) option.scrollIntoView({ block: 'nearest' });
    });
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// تنظیم ارتفاع خودکار برای textarea
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 120);
    textarea.style.height = newHeight + 'px';

}

function syncComposerState(textarea) {
    const composer = textarea.closest('.message-input-container');
    const button = composer?.querySelector('.send-button');
    if (!button) return;

    const page = 'chat';
    const hasText = textarea.value.trim().length > 0;
    const hasFile = currentFile.page === page && Boolean(currentFile.file);
    const isEditing = currentEditing?.page === page;
    const shouldSend = hasText || hasFile || isEditing;
    const canSendMessages = canCurrentMember('can_send_messages');
    const canSendMedia = canCurrentMember('can_send_media');
    const actionAllowed = shouldSend
        ? (hasFile ? canSendMedia : canSendMessages)
        : canSendMedia;

    button.classList.toggle('ready', shouldSend);
    button.disabled = isSendingMessage || !actionAllowed;
    if (page === 'chat' && !voiceRecorder) {
        button.classList.toggle('voice-mode', !shouldSend);
        button.title = isEditing ? 'ثبت ویرایش' : shouldSend ? 'ارسال' : 'ضبط پیام صوتی';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = isEditing
            ? '<i class="fas fa-check"></i>'
            : shouldSend
            ? '<i class="fas fa-arrow-up"></i>'
            : '<i class="fas fa-microphone"></i>';
    }
}

// دریافت کانتینر پیام‌های فعال
function getActiveMessagesContainer() {
    return document.getElementById('messagesContainer');
}

// دریافت صفحه فعال
function getActivePage() {
    return 'chat';
}

function getContainerForSection(section = 'main') {
    return document.getElementById('messagesContainer');
}

function getSectionForContainer(container) {
    return 'main';
}

function isNearBottom(container, threshold = 80) {
    if (!container) return false;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function getVisibleMessages(container) {
    if (!container) return [];
    const bounds = container.getBoundingClientRect();

    return [...container.querySelectorAll('.message')].filter(message => {
        const rect = message.getBoundingClientRect();
        const visibleHeight = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
        return visibleHeight > 0 && visibleHeight >= Math.min(rect.height * 0.5, 32);
    });
}

function sendSeenForVisibleMessages(container) {
    if (!socket || socket.readyState !== WebSocket.OPEN || document.hidden) return;

    const messageIds = getVisibleMessages(container)
        .filter(message => message.classList.contains('received'))
        .map(message => message.dataset.messageId)
        .filter(messageId => messageId && !seenMessageIds.has(messageId));

    if (!messageIds.length) return;
    messageIds.forEach(messageId => seenMessageIds.add(messageId));
    socket.send(JSON.stringify({ event: 'seen', message_ids: messageIds }));
}

function saveCurrentScrollPosition(container) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !hasRestoredInitialPositions) return;
    const visibleMessages = getVisibleMessages(container);
    if (!visibleMessages.length) return;

    const anchor = visibleMessages[0];
    const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
    socket.send(JSON.stringify({
        event: 'save_position',
        section: getSectionForContainer(container),
        message_id: anchor.dataset.messageId,
        offset
    }));
}

function syncViewportState() {
    stateSyncTimer = null;
    const container = getActiveMessagesContainer();
    sendSeenForVisibleMessages(container);

    clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => saveCurrentScrollPosition(container), 350);

    const pageState = historyPages[activeHistoryFilter];
    if (container.scrollTop < 120 && pageState.hasMore && !isLazyLoading && pageState.cursor && socket?.readyState === WebSocket.OPEN) {
        isLazyLoading = true;
        socket.send(JSON.stringify({
            event: 'load_more',
            cursor: pageState.cursor,
            filter: activeHistoryFilter
        }));
    }
}

function scheduleViewportStateSync() {
    clearTimeout(stateSyncTimer);
    stateSyncTimer = setTimeout(syncViewportState, 100);
}

function restoreContainerScrollPosition(container) {
    if (!container) return;
    const section = getSectionForContainer(container);
    const position = savedScrollPositions[section];
    const anchor = position?.messageId
        ? container.querySelector(`[data-message-id="${CSS.escape(position.messageId)}"]`)
        : null;

    if (!anchor) {
        container.scrollTop = container.scrollHeight;
        return;
    }

    const desiredOffset = Number(position.offset) || 0;
    container.scrollTop += anchor.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        - desiredOffset;
}

function restoreAllScrollPositions() {
    restoreContainerScrollPosition(document.getElementById('messagesContainer'));
    hasRestoredInitialPositions = true;
}

function applySeenReceipt(data) {
    if (!data?.username || !Array.isArray(data.messageIds)) return;

    const receiptTimes = new Map((Array.isArray(data.receipts) ? data.receipts : [])
        .filter(receipt => receipt?.messageId)
        .map(receipt => [receipt.messageId, receipt.seenAt]));

    data.messageIds.forEach(messageId => {
        const message = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
        if (!message || !message.classList.contains('sent')) return;

        const status = message.querySelector('.message-status');
        if (!status) return;
        let currentViewers = [];
        try { currentViewers = JSON.parse(status.dataset.seenBy || '[]'); } catch { currentViewers = []; }
        let currentDetails = [];
        try { currentDetails = JSON.parse(status.dataset.seenDetails || '[]'); } catch { currentDetails = []; }
        const viewers = new Set(Array.isArray(currentViewers) ? currentViewers : []);
        if (data.username !== currentUsername) viewers.add(data.username);
        const details = Array.isArray(currentDetails)
            ? currentDetails.filter(item => item?.username !== data.username)
            : [];
        if (data.username !== currentUsername) {
            details.push({
                username: data.username,
                seenAt: receiptTimes.get(messageId) || data.seenAt || new Date().toISOString()
            });
        }
        status.dataset.seenBy = JSON.stringify([...viewers]);
        status.dataset.seenDetails = JSON.stringify(details);
        const icon = viewers.size ? document.createElement('img') : document.createElement('i');
        if (viewers.size) {
            icon.className = 'seen-status-icon';
            icon.src = '/icons/double-check-svgrepo-com.svg';
            icon.alt = '';
        } else {
            icon.className = 'fas fa-check';
            icon.setAttribute('aria-hidden', 'true');
        }
        status.replaceChildren(icon);
        status.title = viewers.size
            ? `دیده‌شده توسط ${[...viewers].join('، ')}`
            : 'ارسال‌شده';
        status.setAttribute('aria-label', status.title);
        status.classList.toggle('seen', viewers.size > 0);

        if (activeMessageActions?.dataset.messageId === messageId) {
            const detailType = activeMessageActions.querySelector('.message-info-detail')?.dataset.detailType;
            if (detailType === 'seen') showMessageInfoDetail(activeMessageActions, message, 'seen');
            else renderMessageInfoSummaries(activeMessageActions, message);
        }
    });
}

const REPLY_SWIPE_THRESHOLD = 52;
const REPLY_SWIPE_LIMIT = 72;

function attachReplyGesture(messageElement, page) {
    let gesture = null;
    const direction = messageElement.classList.contains('sent') ? -1 : 1;

    const resetGesture = () => {
        messageElement.classList.remove('swiping', 'reply-ready');
        messageElement.classList.add('swipe-returning');
        messageElement.style.removeProperty('--swipe-x');

        window.setTimeout(() => {
            messageElement.classList.remove('swipe-returning');
        }, 240);
    };

    messageElement.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button, a, audio, input, .music-progress, .voice-waveform, .message-reply-indicator')) return;

        gesture = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            distance: 0,
            horizontal: false,
            cancelled: false
        };

        messageElement.setPointerCapture?.(event.pointerId);
    });

    messageElement.addEventListener('pointermove', event => {
        if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return;

        const deltaX = event.clientX - gesture.startX;
        const deltaY = event.clientY - gesture.startY;

        if (!gesture.horizontal) {
            if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
                gesture.cancelled = true;
                return;
            }

            if (Math.abs(deltaX) < 6 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
            gesture.horizontal = true;
            messageElement.classList.add('swiping');
        }

        const directedDistance = deltaX * direction;
        gesture.distance = Math.min(REPLY_SWIPE_LIMIT, Math.max(0, directedDistance));
        messageElement.style.setProperty('--swipe-x', `${gesture.distance * direction}px`);
        messageElement.classList.toggle('reply-ready', gesture.distance >= REPLY_SWIPE_THRESHOLD);
        event.preventDefault();
    });

    const finishGesture = event => {
        if (!gesture || gesture.pointerId !== event.pointerId) return;

        const shouldReply = !gesture.cancelled && gesture.distance >= REPLY_SWIPE_THRESHOLD;
        const didMove = gesture.distance > 6;
        gesture = null;
        resetGesture();

        if (didMove) {
            messageElement.dataset.ignoreActionClick = 'true';
            window.setTimeout(() => delete messageElement.dataset.ignoreActionClick, 150);
        }

        if (shouldReply) {
            window.requestAnimationFrame(() => setReply(messageElement, page));
        }
    };

    messageElement.addEventListener('pointerup', finishGesture);
    messageElement.addEventListener('pointercancel', event => {
        if (gesture && gesture.pointerId === event.pointerId) {
            gesture.cancelled = true;
        }
        finishGesture(event);
    });
}

// ==============================================
// قابلیت ریکشن تلگرام با ایموجی‌های متحرک (Telegram Reactions)
// ==============================================

const TELEGRAM_REACTION_EMOJIS = [
    {
        "id": "thumbs_up",
        "emoji": "👍",
        "name": "Thumbs Up",
        "file": "/emojis/reactions/thumbs_up.webp"
    },
    {
        "id": "thumbs_down",
        "emoji": "👎",
        "name": "Thumbs Down",
        "file": "/emojis/reactions/thumbs_down.webp"
    },
    {
        "id": "red_heart",
        "emoji": "❤️",
        "name": "Red Heart",
        "file": "/emojis/reactions/red_heart.webp"
    },
    {
        "id": "fire",
        "emoji": "🔥",
        "name": "Fire",
        "file": "/emojis/reactions/fire.webp"
    },
    {
        "id": "party_popper",
        "emoji": "🎉",
        "name": "Party Popper",
        "file": "/emojis/reactions/party_popper.webp"
    },
    {
        "id": "clapping_hands",
        "emoji": "👏",
        "name": "Clapping Hands",
        "file": "/emojis/reactions/clapping_hands.webp"
    },
    {
        "id": "face_with_tears_of_joy",
        "emoji": "😂",
        "name": "Face With Tears Of Joy",
        "file": "/emojis/reactions/face_with_tears_of_joy.webp"
    },
    {
        "id": "smiling_face_with_hearts",
        "emoji": "🥰",
        "name": "Smiling Face With Hearts",
        "file": "/emojis/reactions/smiling_face_with_hearts.webp"
    },
    {
        "id": "face_screaming_in_fear",
        "emoji": "😱",
        "name": "Face Screaming In Fear",
        "file": "/emojis/reactions/face_screaming_in_fear.webp"
    },
    {
        "id": "thinking_face",
        "emoji": "🤔",
        "name": "Thinking Face",
        "file": "/emojis/reactions/thinking_face.webp"
    },
    {
        "id": "exploding_head",
        "emoji": "🤯",
        "name": "Exploding Head",
        "file": "/emojis/reactions/exploding_head.webp"
    },
    {
        "id": "pile_of_poo",
        "emoji": "💩",
        "name": "Pile Of Poo",
        "file": "/emojis/reactions/pile_of_poo.webp"
    },
    {
        "id": "hundred_points",
        "emoji": "💯",
        "name": "Hundred Points",
        "file": "/emojis/reactions/hundred_points.webp"
    },
    {
        "id": "crying_face",
        "emoji": "😢",
        "name": "Crying Face",
        "file": "/emojis/reactions/crying_face.webp"
    },
    {
        "id": "star_struck",
        "emoji": "🤩",
        "name": "Star Struck",
        "file": "/emojis/reactions/star_struck.webp"
    },
    {
        "id": "eyes",
        "emoji": "👀",
        "name": "Eyes",
        "file": "/emojis/reactions/eyes.webp"
    },
    {
        "id": "heart_on_fire",
        "emoji": "❤️‍🔥",
        "name": "Heart On Fire",
        "file": "/emojis/reactions/heart_on_fire.webp"
    },
    {
        "id": "dove",
        "emoji": "🕊️",
        "name": "Dove",
        "file": "/emojis/reactions/dove.webp"
    },
    {
        "id": "high_voltage",
        "emoji": "⚡",
        "name": "High Voltage",
        "file": "/emojis/reactions/high_voltage.webp"
    },
    {
        "id": "handshake",
        "emoji": "🤝",
        "name": "Handshake",
        "file": "/emojis/reactions/handshake.webp"
    },
    {
        "id": "rolling_on_the_floor_laughing",
        "emoji": "🤣",
        "name": "Rolling On The Floor Laughing",
        "file": "/emojis/reactions/rolling_on_the_floor_laughing.webp"
    },
    {
        "id": "folded_hands",
        "emoji": "🙏",
        "name": "Folded Hands",
        "file": "/emojis/reactions/folded_hands.webp"
    },
    {
        "id": "ok_hand",
        "emoji": "👌",
        "name": "Ok Hand",
        "file": "/emojis/reactions/ok_hand.webp"
    },
    {
        "id": "clown_face",
        "emoji": "🤡",
        "name": "Clown Face",
        "file": "/emojis/reactions/clown_face.webp"
    },
    {
        "id": "yawning_face",
        "emoji": "🥱",
        "name": "Yawning Face",
        "file": "/emojis/reactions/yawning_face.webp"
    },
    {
        "id": "woozy_face",
        "emoji": "🥴",
        "name": "Woozy Face",
        "file": "/emojis/reactions/woozy_face.webp"
    },
    {
        "id": "hot_dog",
        "emoji": "🌭",
        "name": "Hot Dog",
        "file": "/emojis/reactions/hot_dog.webp"
    },
    {
        "id": "banana",
        "emoji": "🍌",
        "name": "Banana",
        "file": "/emojis/reactions/banana.webp"
    },
    {
        "id": "trophy",
        "emoji": "🏆",
        "name": "Trophy",
        "file": "/emojis/reactions/trophy.webp"
    },
    {
        "id": "broken_heart",
        "emoji": "💔",
        "name": "Broken Heart",
        "file": "/emojis/reactions/broken_heart.webp"
    },
    {
        "id": "face_with_raised_eyebrow",
        "emoji": "🤨",
        "name": "Face With Raised Eyebrow",
        "file": "/emojis/reactions/face_with_raised_eyebrow.webp"
    },
    {
        "id": "neutral_face",
        "emoji": "😐",
        "name": "Neutral Face",
        "file": "/emojis/reactions/neutral_face.webp"
    },
    {
        "id": "strawberry",
        "emoji": "🍓",
        "name": "Strawberry",
        "file": "/emojis/reactions/strawberry.webp"
    },
    {
        "id": "bottle_with_popping_cork",
        "emoji": "🍾",
        "name": "Bottle With Popping Cork",
        "file": "/emojis/reactions/bottle_with_popping_cork.webp"
    },
    {
        "id": "kiss_mark",
        "emoji": "💋",
        "name": "Kiss Mark",
        "file": "/emojis/reactions/kiss_mark.webp"
    },
    {
        "id": "middle_finger",
        "emoji": "🖕",
        "name": "Middle Finger",
        "file": "/emojis/reactions/middle_finger.webp"
    },
    {
        "id": "smiling_face_with_horns",
        "emoji": "😈",
        "name": "Smiling Face With Horns",
        "file": "/emojis/reactions/smiling_face_with_horns.webp"
    },
    {
        "id": "sleeping_face",
        "emoji": "😴",
        "name": "Sleeping Face",
        "file": "/emojis/reactions/sleeping_face.webp"
    },
    {
        "id": "loudly_crying_face",
        "emoji": "😭",
        "name": "Loudly Crying Face",
        "file": "/emojis/reactions/loudly_crying_face.webp"
    },
    {
        "id": "nerd_face",
        "emoji": "🤓",
        "name": "Nerd Face",
        "file": "/emojis/reactions/nerd_face.webp"
    },
    {
        "id": "ghost",
        "emoji": "👻",
        "name": "Ghost",
        "file": "/emojis/reactions/ghost.webp"
    },
    {
        "id": "jack_o_lantern",
        "emoji": "🎃",
        "name": "Jack-O-Lantern",
        "file": "/emojis/reactions/jack_o_lantern.webp"
    },
    {
        "id": "see_no_evil_monkey",
        "emoji": "🙈",
        "name": "See-No-Evil Monkey",
        "file": "/emojis/reactions/see_no_evil_monkey.webp"
    },
    {
        "id": "smiling_face_with_halo",
        "emoji": "😇",
        "name": "Smiling Face With Halo",
        "file": "/emojis/reactions/smiling_face_with_halo.webp"
    },
    {
        "id": "fearful_face",
        "emoji": "😨",
        "name": "Fearful Face",
        "file": "/emojis/reactions/fearful_face.webp"
    },
    {
        "id": "hugging_face",
        "emoji": "🤗",
        "name": "Hugging Face",
        "file": "/emojis/reactions/hugging_face.webp"
    },
    {
        "id": "saluting_face",
        "emoji": "🫡",
        "name": "Saluting Face",
        "file": "/emojis/reactions/saluting_face.webp"
    },
    {
        "id": "nail_polish",
        "emoji": "💅",
        "name": "Nail Polish",
        "file": "/emojis/reactions/nail_polish.webp"
    },
    {
        "id": "zany_face",
        "emoji": "🤪",
        "name": "Zany Face",
        "file": "/emojis/reactions/zany_face.webp"
    },
    {
        "id": "moai",
        "emoji": "🗿",
        "name": "Moai",
        "file": "/emojis/reactions/moai.webp"
    },
    {
        "id": "heart_with_arrow",
        "emoji": "💘",
        "name": "Heart With Arrow",
        "file": "/emojis/reactions/heart_with_arrow.webp"
    },
    {
        "id": "hear_no_evil_monkey",
        "emoji": "🙉",
        "name": "Hear-No-Evil Monkey",
        "file": "/emojis/reactions/hear_no_evil_monkey.webp"
    },
    {
        "id": "unicorn",
        "emoji": "🦄",
        "name": "Unicorn",
        "file": "/emojis/reactions/unicorn.webp"
    },
    {
        "id": "face_blowing_a_kiss",
        "emoji": "😘",
        "name": "Face Blowing A Kiss",
        "file": "/emojis/reactions/face_blowing_a_kiss.webp"
    },
    {
        "id": "pill",
        "emoji": "💊",
        "name": "Pill",
        "file": "/emojis/reactions/pill.webp"
    },
    {
        "id": "speak_no_evil_monkey",
        "emoji": "🙊",
        "name": "Speak-No-Evil Monkey",
        "file": "/emojis/reactions/speak_no_evil_monkey.webp"
    },
    {
        "id": "smiling_face_with_sunglasses",
        "emoji": "😎",
        "name": "Smiling Face With Sunglasses",
        "file": "/emojis/reactions/smiling_face_with_sunglasses.webp"
    },
    {
        "id": "alien_monster",
        "emoji": "👾",
        "name": "Alien Monster",
        "file": "/emojis/reactions/alien_monster.webp"
    },
    {
        "id": "drooling_face",
        "emoji": "🤤",
        "name": "Drooling Face",
        "file": "/emojis/reactions/drooling_face.webp"
    },
    {
        "id": "nauseated_face",
        "emoji": "🤢",
        "name": "Nauseated Face",
        "file": "/emojis/reactions/nauseated_face.webp"
    },
    {
        "id": "face_vomiting",
        "emoji": "🤮",
        "name": "Face Vomiting",
        "file": "/emojis/reactions/face_vomiting.webp"
    },
    {
        "id": "zipper_mouth_face",
        "emoji": "🤐",
        "name": "Zipper-Mouth Face",
        "file": "/emojis/reactions/zipper_mouth_face.webp"
    },
    {
        "id": "partying_face",
        "emoji": "🥳",
        "name": "Partying Face",
        "file": "/emojis/reactions/partying_face.webp"
    },
    {
        "id": "pleading_face",
        "emoji": "🥺",
        "name": "Pleading Face",
        "file": "/emojis/reactions/pleading_face.webp"
    },
    {
        "id": "grinning_face",
        "emoji": "😀",
        "name": "Grinning Face",
        "file": "/emojis/reactions/grinning_face.webp"
    },
    {
        "id": "grinning_face_with_big_eyes",
        "emoji": "😃",
        "name": "Grinning Face With Big Eyes",
        "file": "/emojis/reactions/grinning_face_with_big_eyes.webp"
    },
    {
        "id": "grinning_face_with_smiling_eyes",
        "emoji": "😄",
        "name": "Grinning Face With Smiling Eyes",
        "file": "/emojis/reactions/grinning_face_with_smiling_eyes.webp"
    },
    {
        "id": "beaming_face_with_smiling_eyes",
        "emoji": "😁",
        "name": "Beaming Face With Smiling Eyes",
        "file": "/emojis/reactions/beaming_face_with_smiling_eyes.webp"
    },
    {
        "id": "grinning_squinting_face",
        "emoji": "😆",
        "name": "Grinning Squinting Face",
        "file": "/emojis/reactions/grinning_squinting_face.webp"
    },
    {
        "id": "winking_face",
        "emoji": "😉",
        "name": "Winking Face",
        "file": "/emojis/reactions/winking_face.webp"
    },
    {
        "id": "face_savoring_food",
        "emoji": "😋",
        "name": "Face Savoring Food",
        "file": "/emojis/reactions/face_savoring_food.webp"
    },
    {
        "id": "relieved_face",
        "emoji": "😌",
        "name": "Relieved Face",
        "file": "/emojis/reactions/relieved_face.webp"
    },
    {
        "id": "smirking_face",
        "emoji": "😏",
        "name": "Smirking Face",
        "file": "/emojis/reactions/smirking_face.webp"
    },
    {
        "id": "disappointed_face",
        "emoji": "😞",
        "name": "Disappointed Face",
        "file": "/emojis/reactions/disappointed_face.webp"
    },
    {
        "id": "pensive_face",
        "emoji": "😔",
        "name": "Pensive Face",
        "file": "/emojis/reactions/pensive_face.webp"
    },
    {
        "id": "worried_face",
        "emoji": "😟",
        "name": "Worried Face",
        "file": "/emojis/reactions/worried_face.webp"
    },
    {
        "id": "confused_face",
        "emoji": "😕",
        "name": "Confused Face",
        "file": "/emojis/reactions/confused_face.webp"
    },
    {
        "id": "slightly_frowning_face",
        "emoji": "🙁",
        "name": "Slightly Frowning Face",
        "file": "/emojis/reactions/slightly_frowning_face.webp"
    },
    {
        "id": "persevering_face",
        "emoji": "😣",
        "name": "Persevering Face",
        "file": "/emojis/reactions/persevering_face.webp"
    },
    {
        "id": "confounded_face",
        "emoji": "😖",
        "name": "Confounded Face",
        "file": "/emojis/reactions/confounded_face.webp"
    },
    {
        "id": "tired_face",
        "emoji": "😫",
        "name": "Tired Face",
        "file": "/emojis/reactions/tired_face.webp"
    },
    {
        "id": "weary_face",
        "emoji": "😩",
        "name": "Weary Face",
        "file": "/emojis/reactions/weary_face.webp"
    },
    {
        "id": "angry_face",
        "emoji": "😠",
        "name": "Angry Face",
        "file": "/emojis/reactions/angry_face.webp"
    },
    {
        "id": "pouting_face",
        "emoji": "😡",
        "name": "Pouting Face",
        "file": "/emojis/reactions/pouting_face.webp"
    }
];

function getEmojiMeta(emojiOrId) {
    if (!emojiOrId) return null;
    return TELEGRAM_REACTION_EMOJIS.find(e => e.emoji === emojiOrId || e.id === emojiOrId || e.name === emojiOrId) || null;
}

let activeReactionBar = null;

function closeFloatingReactionBar() {
    if (!activeReactionBar) return;
    activeReactionBar.remove();
    activeReactionBar = null;
}

function sendReaction(messageId, emoji) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify({
        event: 'reaction',
        message_id: messageId,
        emoji: emoji
    }));
}

function showReactionBurst(originElement, emojiCharOrId) {
    const meta = getEmojiMeta(emojiCharOrId);
    if (!meta) return;

    const rect = originElement.getBoundingClientRect();
    const burst = document.createElement('div');
    burst.className = 'reaction-fly-burst';
    burst.innerHTML = `<img src="${meta.file}" alt="" />`;
    burst.style.left = `${rect.left + (rect.width / 2) - 26}px`;
    burst.style.top = `${rect.top + (rect.height / 2) - 26}px`;
    document.body.appendChild(burst);

    burst.addEventListener('animationend', () => burst.remove());
    setTimeout(() => burst.remove(), 800);
}

function makeHorizontallyScrollable(container) {
    if (!container) return;

    // Mouse wheels usually report a vertical delta, even over a horizontal list.
    container.addEventListener('wheel', (event) => {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        if (delta && container.scrollWidth > container.clientWidth) {
            event.preventDefault();
            container.scrollLeft += delta;
        }
    }, { passive: false });

    // Native touch scrolling is kept intact; desktop users can drag the strip.
    let isDown = false;
    let startX = 0;
    let scrollLeft = 0;
    let hasDragged = false;

    container.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        isDown = true;
        hasDragged = false;
        startX = e.clientX;
        scrollLeft = container.scrollLeft;
    });

    const stopDragging = () => {
        isDown = false;
    };
    container.addEventListener('pointerup', stopDragging);
    container.addEventListener('pointercancel', stopDragging);

    container.addEventListener('pointermove', (e) => {
        if (!isDown) return;
        const walk = (e.clientX - startX) * 1.25;
        if (Math.abs(walk) > 4) {
            hasDragged = true;
            if (!container.hasPointerCapture?.(e.pointerId)) {
                container.setPointerCapture?.(e.pointerId);
            }
            e.preventDefault();
        }
        container.scrollLeft = scrollLeft - walk;
    });

    // جلوگیری از ثبت کلیک ناخواسته روی ایموجی‌ها در صورت جابجایی با درگ
    container.addEventListener('click', (e) => {
        if (hasDragged) {
            e.stopPropagation();
            hasDragged = false;
        }
    }, true);
}

function renderReactionsList(container, reactions, messageId, bounceEmoji = null) {
    if (!container) return;
    container.innerHTML = '';

    if (!Array.isArray(reactions) || !reactions.length) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';

    reactions.forEach(r => {
        if (!r.count || r.count <= 0) return;
        const meta = getEmojiMeta(r.emoji);
        const emojiDisplay = meta
            ? `<img class="reaction-emoji-img" src="${meta.file}" alt="${meta.name}" />`
            : `<span class="reaction-emoji-text">${r.emoji}</span>`;

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'reaction-pill';
        pill.dataset.emoji = r.emoji;
        const userHasReacted = Array.isArray(r.users) && r.users.includes(currentUsername);
        if (userHasReacted) {
            pill.classList.add('user-reacted');
        }

        if (bounceEmoji && r.emoji === bounceEmoji) {
            pill.classList.add('reaction-settle-bounce');
        }

        if (Array.isArray(r.users) && r.users.length) {
            pill.title = r.users.join('، ');
            pill.setAttribute('aria-label', `${r.count} واکنش: ${r.users.join('، ')}`);
        }
        pill.dataset.users = JSON.stringify(Array.isArray(r.users) ? r.users : []);
        pill.dataset.details = JSON.stringify(Array.isArray(r.details) ? r.details : []);
        pill.dataset.count = String(r.count);

        pill.innerHTML = `${emojiDisplay}<span class="reaction-count">${r.count}</span>`;

        pill.addEventListener('click', event => {
            event.stopPropagation();
            sendReaction(messageId, r.emoji);
        });

        container.appendChild(pill);
    });
}

function updateMessageReactionInDom(data) {
    if (!data || !data.messageId) return;
    const { messageId, reactions, emoji, action, actionUser } = data;

    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return;

    const bubble = messageElement.querySelector('.message-bubble') || messageElement;
    let container = messageElement.querySelector('.message-reactions');
    if (!container) {
        container = document.createElement('div');
        container.className = 'message-reactions';
        container.id = `reactions-${messageId}`;
        bubble.appendChild(container);
    }

    const addedEmoji = action === 'added' ? emoji : null;
    renderReactionsList(container, reactions, messageId, addedEmoji);

    if (addedEmoji && actionUser === currentUsername) {
        const addedPill = [...container.querySelectorAll('.reaction-pill')]
            .find(pill => pill.dataset.emoji === addedEmoji);
        if (addedPill) {
            window.requestAnimationFrame(() => showReactionBurst(addedPill, addedEmoji));
        }
    }

    // به‌روزرسانی وضعیت دکمه‌های باز در صورت باز بودن نوار
    if (activeReactionBar?.dataset.messageId === messageId) {
        const userReactedEmojis = new Set();
        container.querySelectorAll('.reaction-pill.user-reacted').forEach(pill => {
            if (pill.dataset.emoji) userReactedEmojis.add(pill.dataset.emoji);
        });
        activeReactionBar.querySelectorAll('.reaction-picker-item').forEach(item => {
            const itemEmoji = item.dataset.emoji;
            if (itemEmoji && userReactedEmojis.has(itemEmoji)) {
                item.classList.add('user-selected');
            } else {
                item.classList.remove('user-selected');
            }
        });
    }

    if (activeMessageActions?.dataset.messageId === messageId) {
        const detailType = activeMessageActions.querySelector('.message-info-detail')?.dataset.detailType;
        if (detailType) showMessageInfoDetail(activeMessageActions, messageElement, detailType);
        else renderMessageInfoSummaries(activeMessageActions, messageElement);
        positionMessageActions(activeMessageActions, messageElement);
    }
}

function buildReactionsBarComponent(messageElement, onSelectEmoji, options = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'reaction-picker';

    const scrollArea = document.createElement('div');
    scrollArea.className = 'reaction-picker-scroll';
    scrollArea.setAttribute('role', 'toolbar');
    scrollArea.setAttribute('aria-label', 'نوار واکنش‌ها');

    // دکمه باز کردن تمام ایموجی‌ها (+)
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'reaction-expand-btn';
    expandBtn.title = 'مشاهده همه واکنش‌ها';
    expandBtn.setAttribute('aria-label', 'نمایش یا بستن همه واکنش‌ها');
    expandBtn.innerHTML = '<i class="fas fa-plus"></i>';

    const userReactedEmojis = new Set();
    messageElement.querySelectorAll('.reaction-pill.user-reacted').forEach(pill => {
        if (pill.dataset.emoji) userReactedEmojis.add(pill.dataset.emoji);
    });

    TELEGRAM_REACTION_EMOJIS.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reaction-picker-item';
        btn.dataset.emoji = item.emoji;
        btn.title = item.name;
        btn.setAttribute('aria-label', item.name);
        if (userReactedEmojis.has(item.emoji)) {
            btn.classList.add('user-selected');
        }
        btn.innerHTML = `<img src="${item.file}" alt="${item.name}" loading="lazy" />`;
        btn.addEventListener('click', event => {
            event.stopPropagation();
            onSelectEmoji(item.emoji, btn);
        });
        scrollArea.appendChild(btn);
    });

    makeHorizontallyScrollable(scrollArea);

    // تاگل حالت باز شده (نمایش همه ۸۴ ریکشن در حالت شبکه‌ای)
    expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExpanded = wrapper.classList.toggle('expanded');
        expandBtn.classList.toggle('active', isExpanded);
        expandBtn.innerHTML = isExpanded ? '<i class="fas fa-minus"></i>' : '<i class="fas fa-plus"></i>';
        expandBtn.title = isExpanded ? 'کوچک کردن نوار' : 'مشاهده همه واکنش‌ها';
        if (options.onExpandChange) {
            options.onExpandChange(isExpanded);
        }
    });

    wrapper.appendChild(scrollArea);
    wrapper.appendChild(expandBtn);

    return { wrapper, scrollArea, expandBtn };
}

function toggleFloatingReactionBar(messageElement, anchorBtn) {
    const messageId = messageElement.dataset.messageId;
    if (activeReactionBar?.dataset.messageId === messageId) {
        closeFloatingReactionBar();
        return;
    }

    closeFloatingReactionBar();
    closeMessageActions();

    const bar = document.createElement('div');
    bar.className = 'telegram-reactions-bar';
    bar.dataset.messageId = messageId;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'انتخاب واکنش تلگرام');

    const { wrapper } = buildReactionsBarComponent(messageElement, (emoji, targetBtn) => {
        sendReaction(messageId, emoji);
        closeFloatingReactionBar();
    }, {
        onExpandChange: () => {
            positionFloatingReactionBar(bar, anchorBtn || messageElement);
        }
    });

    bar.appendChild(wrapper);
    bar.addEventListener('click', event => event.stopPropagation());
    document.body.appendChild(bar);
    activeReactionBar = bar;

    positionFloatingReactionBar(bar, anchorBtn || messageElement);
}

function positionFloatingReactionBar(bar, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const barWidth = bar.offsetWidth || 380;
    const barHeight = bar.offsetHeight || 52;
    const padding = 10;

    let top = rect.top - barHeight - 10;
    if (top < padding) {
        top = rect.bottom + 10;
    }

    let left = rect.left + (rect.width / 2) - (barWidth / 2);
    left = Math.max(padding, Math.min(left, window.innerWidth - barWidth - padding));

    bar.style.top = `${top}px`;
    bar.style.left = `${left}px`;
}

function createMenuReactionsStrip(messageElement) {
    const messageId = messageElement.dataset.messageId;
    const { wrapper } = buildReactionsBarComponent(messageElement, (emoji, targetBtn) => {
        sendReaction(messageId, emoji);
        closeMessageActions();
    }, {
        onExpandChange: () => {
            if (activeMessageActions) {
                positionMessageActions(activeMessageActions, messageElement);
            }
        }
    });

    return wrapper;
}

function getMessageReactionDetails(messageElement) {
    return [...messageElement.querySelectorAll('.reaction-pill')].map(pill => {
        let users = [];
        try {
            users = JSON.parse(pill.dataset.users || '[]');
        } catch (_) {
            users = [];
        }
        return {
            emoji: pill.dataset.emoji,
            count: Number(pill.dataset.count) || users.length,
            users: Array.isArray(users) ? users : [],
            details: (() => {
                try {
                    const value = JSON.parse(pill.dataset.details || '[]');
                    return Array.isArray(value) ? value : [];
                } catch (_) {
                    return [];
                }
            })()
        };
    }).filter(reaction => reaction.emoji && reaction.count > 0);
}

function getMessageSeenDetails(messageElement) {
    const status = messageElement.querySelector('.message-status');
    if (!status) return [];
    let users = [];
    let details = [];
    try { users = JSON.parse(status.dataset.seenBy || '[]'); } catch (_) { users = []; }
    try { details = JSON.parse(status.dataset.seenDetails || '[]'); } catch (_) { details = []; }
    const times = new Map((Array.isArray(details) ? details : [])
        .filter(item => item?.username)
        .map(item => [item.username, item.seenAt]));
    return (Array.isArray(users) ? users : []).map(username => ({
        username,
        seenAt: times.get(username) || null
    }));
}

function formatReceiptDateTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return 'زمان ثبت نشده';
    return new Intl.DateTimeFormat('fa-IR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

function createInfoSummaryButton(className, icon, label, count, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `message-info-summary ${className}`;
    const leadingIcon = icon === 'seen-details-double-check'
        ? '<img class="message-info-summary-icon" src="/icons/seen-details-double-check.svg" alt="">'
        : `<i class="${icon}" aria-hidden="true"></i>`;
    button.innerHTML = `${leadingIcon}<span>${label} توسط ${count.toLocaleString('fa-IR')} نفر</span><i class="fas fa-chevron-left message-info-chevron" aria-hidden="true"></i>`;
    button.addEventListener('click', event => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function renderMessageInfoSummaries(menu, messageElement) {
    menu.querySelectorAll('.message-info-summary').forEach(row => row.remove());
    const firstAction = menu.querySelector('.message-action-reply');
    const seen = messageElement.classList.contains('sent') ? getMessageSeenDetails(messageElement) : [];
    const reactions = getMessageReactionDetails(messageElement);
    const reactionUsers = new Set(reactions.flatMap(reaction => reaction.users));

    if (messageElement.classList.contains('sent')) {
        menu.insertBefore(createInfoSummaryButton(
            'message-seen-summary',
            'seen-details-double-check',
            'خوانده شده',
            seen.length,
            () => showMessageInfoDetail(menu, messageElement, 'seen')
        ), firstAction || null);
    }
    if (reactionUsers.size) {
        menu.insertBefore(createInfoSummaryButton(
            'message-reactions-summary',
            'far fa-face-smile',
            'واکنش ثبت شده',
            reactionUsers.size,
            () => showMessageInfoDetail(menu, messageElement, 'reactions')
        ), firstAction || null);
    }
}

function showMessageInfoDetail(menu, messageElement, type) {
    const panel = document.createElement('section');
    panel.className = 'message-info-detail';
    panel.dataset.detailType = type;

    const header = document.createElement('header');
    header.className = 'message-info-detail-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'message-info-back';
    back.innerHTML = '<i class="fas fa-arrow-right"></i><span>بازگشت</span>';
    back.addEventListener('click', event => {
        event.stopPropagation();
        activeMessageActions = null;
        menu.remove();
        showMessageActions(messageElement);
    });
    const title = document.createElement('strong');
    title.textContent = type === 'seen' ? 'جزئیات خوانده شدن' : 'جزئیات واکنش‌ها';
    header.append(back, title);
    panel.appendChild(header);

    if (type === 'seen') {
        getMessageSeenDetails(messageElement).forEach(item => {
            panel.appendChild(createMessageInfoPersonRow(
                item.username,
                null,
                formatReceiptDateTime(item.seenAt)
            ));
        });
    } else {
        getMessageReactionDetails(messageElement).forEach(reaction => {
            const timestampByUser = new Map(reaction.details
                .filter(item => item?.username)
                .map(item => [item.username, item.reactedAt]));
            reaction.users.forEach(username => {
                panel.appendChild(createMessageInfoPersonRow(
                    username,
                    null,
                    formatReceiptDateTime(timestampByUser.get(username)),
                    reaction.emoji
                ));
            });
        });
    }

    menu.replaceChildren(panel);
    positionMessageActions(menu, messageElement);
}

function createMessageInfoPersonRow(username, iconClass, timestamp, emoji = null) {
    const row = document.createElement('div');
    row.className = 'message-info-person-row';
    let icon = null;
    if (emoji || iconClass) {
        icon = document.createElement('span');
        icon.className = 'message-info-person-icon';
    }
    if (emoji) {
        const meta = getEmojiMeta(emoji);
        if (meta) {
            const image = document.createElement('img');
            image.src = meta.file;
            image.alt = meta.name;
            icon.appendChild(image);
        } else icon.textContent = emoji;
    } else if (iconClass) {
        icon.innerHTML = `<i class="${iconClass}"></i>`;
    }
    const copy = document.createElement('span');
    copy.className = 'message-info-person-copy';
    const name = document.createElement('strong');
    name.textContent = username === currentUsername ? 'شما' : username;
    const time = document.createElement('time');
    time.textContent = timestamp;
    copy.append(name, time);
    if (icon) row.appendChild(icon);
    row.appendChild(copy);
    return row;
}
// ==============================================
// ویرایش، حذف و اقدامات پیام‌ها
// ==============================================
let activeMessageActions = null;

function closeMessageActions() {
    if (activeMessageActions) {
        activeMessageActions.remove();
        activeMessageActions = null;
    }
    closeFloatingReactionBar();
}

function positionMessageActions(menu, messageElement, point = null) {
    const rect = messageElement.getBoundingClientRect();
    const gap = 8;
    const padding = 8;
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;

    let left = point?.clientX ?? rect.right + gap;
    let top = point?.clientY ?? rect.top;

    if (!point && left + menuWidth > window.innerWidth - padding) {
        left = rect.left - menuWidth - gap;
    }

    menu.style.left = `${Math.max(padding, Math.min(left, window.innerWidth - menuWidth - padding))}px`;
    menu.style.top = `${Math.max(padding, Math.min(top, window.innerHeight - menuHeight - padding))}px`;
    menu.style.visibility = 'visible';
}

async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();

    try {
        if (!document.execCommand('copy')) throw new Error('Copy command failed');
    } finally {
        textarea.remove();
    }
}

function showMessageActions(messageElement, point = null) {
    const messageId = messageElement.dataset.messageId;
    const sameMenuIsOpen = activeMessageActions?.dataset.messageId === messageId;
    closeMessageActions();
    closeFloatingReactionBar();
    if (sameMenuIsOpen && !point) return;

    const menu = document.createElement('div');
    menu.className = 'message-actions-menu';
    menu.dataset.messageId = messageId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'عملیات پیام');

    // نوار ریکشن‌های سریع در بالای منو
    const reactionsStrip = createMenuReactionsStrip(messageElement);
    menu.appendChild(reactionsStrip);

    // پاسخ به پیام برای تمام پیام‌ها
    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'message-action-reply';
    replyButton.setAttribute('role', 'menuitem');
    replyButton.innerHTML = '<i class="fas fa-reply"></i><span>پاسخ</span>';
    replyButton.addEventListener('click', event => {
        event.stopPropagation();
        closeMessageActions();
        setReply(messageElement, 'main');
    });
    menu.appendChild(replyButton);
    renderMessageInfoSummaries(menu, messageElement);

    const messageText = messageElement.querySelector('.message-content')?.textContent || '';
    if (messageText) {
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'message-action-copy';
        copyButton.setAttribute('role', 'menuitem');
        copyButton.innerHTML = '<i class="far fa-copy"></i><span>کپی پیام</span>';
        copyButton.addEventListener('click', async event => {
            event.stopPropagation();
            copyButton.disabled = true;

            try {
                await copyTextToClipboard(messageText);
                copyButton.classList.add('copied');
                copyButton.innerHTML = '<i class="fas fa-check"></i><span>کپی شد</span>';
                window.setTimeout(() => {
                    if (activeMessageActions === menu) closeMessageActions();
                }, 650);
            } catch (error) {
                copyButton.disabled = false;
                window.alert('کپی پیام انجام نشد. لطفاً دوباره تلاش کنید.');
            }
        });
        menu.appendChild(copyButton);
    }

    const isPinned = messageElement.dataset.pinned === 'true';
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.className = 'message-action-pin';
    pinButton.setAttribute('role', 'menuitem');
    pinButton.innerHTML = isPinned
        ? '<i class="fas fa-thumbtack"></i><span>برداشتن پین</span>'
        : '<i class="fas fa-thumbtack"></i><span>پین کردن</span>';
    pinButton.addEventListener('click', event => {
        event.stopPropagation();
        closeMessageActions();
        setMessagePin(messageElement, !isPinned);
    });
    menu.appendChild(pinButton);

    const isOwn = messageElement.classList.contains('sent');
    if (isOwn) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'message-action-edit';
        editButton.setAttribute('role', 'menuitem');
        editButton.innerHTML = '<i class="fas fa-pen"></i><span>ویرایش</span>';
        editButton.addEventListener('click', event => {
            event.stopPropagation();
            closeMessageActions();
            editOwnMessage(messageElement);
        });

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'message-action-delete';
        deleteButton.setAttribute('role', 'menuitem');
        deleteButton.innerHTML = '<i class="fas fa-trash"></i><span>حذف</span>';
        deleteButton.addEventListener('click', event => {
            event.stopPropagation();
            closeMessageActions();
            deleteOwnMessage(messageElement);
        });

        menu.append(editButton, deleteButton);
    } else if (chatInfo.currentMember?.is_admin) {
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'message-action-delete';
        deleteButton.setAttribute('role', 'menuitem');
        deleteButton.innerHTML = '<i class="fas fa-trash"></i><span>حذف توسط ادمین</span>';
        deleteButton.addEventListener('click', event => {
            event.stopPropagation();
            closeMessageActions();
            deleteOwnMessage(messageElement);
        });
        menu.appendChild(deleteButton);
    }

    menu.addEventListener('click', event => event.stopPropagation());
    document.body.appendChild(menu);
    activeMessageActions = menu;
    positionMessageActions(menu, messageElement, point);
}

function attachMessageActions(messageElement) {
    messageElement.classList.add('message-actionable');
    messageElement.addEventListener('click', event => {
        if (messageElement.dataset.ignoreActionClick === 'true') return;
        if (event.target.closest('button, a, audio, input, textarea, .music-progress, .voice-waveform, .message-reply-indicator, .reaction-pill, .message-react-btn, .message-reply-btn')) return;
        if (window.getSelection()?.toString()) return;

        event.stopPropagation();
        showMessageActions(messageElement);
    });

    messageElement.addEventListener('contextmenu', event => {
        event.preventDefault();
        event.stopPropagation();
        showMessageActions(messageElement, {
            clientX: event.clientX,
            clientY: event.clientY
        });
    });
}

const attachOwnMessageActions = attachMessageActions;

function normalizeComposerPage(page) {
    return 'chat';
}

function getComposerInput(page) {
    return document.getElementById('messageInput');
}

function getComposerSendButton(page) {
    return document.getElementById('sendButton');
}

function getEditCancelButton(page) {
    return document.getElementById('editCancelButton');
}

function getComposerPreviewElements(page) {
    return {
        preview: document.getElementById('replyPreview'),
        sender: document.getElementById('replyPreviewSender'),
        text: document.getElementById('replyPreviewText')
    };
}

function editOwnMessage(messageElement) {
    if (isSendingMessage) return;
    if (activeHistoryFilter !== 'all') setHistoryFilter('all');

    const page = normalizeComposerPage(messageElement.dataset.section || 'chat');
    const input = getComposerInput(page);
    const content = messageElement.querySelector('.message-content')?.textContent || '';
    if (!input) return;

    if (currentEditing) cancelEditing(currentEditing.page);

    currentEditing = {
        id: messageElement.dataset.messageId,
        page,
        originalContent: content,
        previousDraft: input.value
    };

    currentReply = { page: null, messageId: null, sender: null, text: null };
    clearFilePreview(page);

    const { preview, sender, text } = getComposerPreviewElements(page);
    preview?.classList.add('editing-preview');
    const icon = preview?.querySelector('.reply-preview-icon i');
    if (icon) icon.className = 'fas fa-pen';
    if (sender) sender.textContent = 'ویرایش پیام';
    if (text) text.textContent = content || 'پیام بدون متن';
    if (preview) preview.style.display = 'flex';

    const sendButton = getComposerSendButton(page);
    getEditCancelButton(page)?.classList.add('visible');
    sendButton?.classList.add('editing');
    if (sendButton) {
        sendButton.title = 'ثبت ویرایش';
        sendButton.innerHTML = '<i class="fas fa-check"></i>';
    }

    input.value = content;
    syncComposerState(input);
    autoResizeTextarea(input);
    adjustMessagesHeight();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

function cancelEditing(page, restoreDraft = true) {
    const normalizedPage = normalizeComposerPage(page);
    if (!currentEditing || currentEditing.page !== normalizedPage) return;

    const editing = currentEditing;
    currentEditing = null;
    const input = getComposerInput(normalizedPage);
    const { preview } = getComposerPreviewElements(normalizedPage);
    const sendButton = getComposerSendButton(normalizedPage);
    const cancelButton = getEditCancelButton(normalizedPage);

    preview?.classList.remove('editing-preview');
    const icon = preview?.querySelector('.reply-preview-icon i');
    if (icon) icon.className = 'fas fa-reply';
    if (preview) preview.style.display = 'none';
    cancelButton?.classList.remove('visible');
    sendButton?.classList.remove('editing');
    if (sendButton) {
        sendButton.title = 'ارسال';
        sendButton.innerHTML = '<i class="fas fa-arrow-up"></i>';
    }

    if (input) {
        input.value = restoreDraft ? editing.previousDraft : '';
        syncComposerState(input);
        autoResizeTextarea(input);
        input.focus();
    }
    adjustMessagesHeight();
}

async function submitMessageEdit(page) {
    const normalizedPage = normalizeComposerPage(page);
    if (!currentEditing || currentEditing.page !== normalizedPage) return;

    const editing = currentEditing;
    const input = getComposerInput(normalizedPage);
    const content = input?.value ?? '';

    if (content === editing.originalContent) {
        cancelEditing(normalizedPage);
        return;
    }

    try {
        const response = await fetch(
            `/api/rooms/${encodeURIComponent(activeChatId)}/messages/${encodeURIComponent(editing.id)}`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content })
            }
        );
        const result = await response.json().catch(() => ({}));

        if (!response.ok) throw new Error(result.message || 'ویرایش پیام انجام نشد');

        updateMessageInDom(result.message);
        cancelEditing(normalizedPage);
    } catch (error) {
        window.alert(error.message || 'خطا در ویرایش پیام');
        input?.focus();
    }
}

async function deleteOwnMessage(messageElement) {
    const isOwn = messageElement.classList.contains('sent');
    const prompt = isOwn ? 'این پیام حذف شود؟' : 'این پیام عضو توسط ادمین حذف شود؟';
    if (!window.confirm(prompt)) return;

    try {
        const response = await fetch(
            `/api/rooms/${encodeURIComponent(activeChatId)}/messages/${encodeURIComponent(messageElement.dataset.messageId)}`,
            {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            }
        );
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(result.message || 'حذف پیام انجام نشد');
        }

        removeMessageFromDom(result.id || messageElement.dataset.messageId);
    } catch (error) {
        window.alert(error.message || 'خطا در حذف پیام');
    }
}

async function setMessagePin(messageOrId, pinned) {
    const messageId = typeof messageOrId === 'string'
        ? messageOrId
        : messageOrId?.dataset.messageId;
    if (!messageId) return;

    try {
        const response = await fetch(
            `/api/rooms/${encodeURIComponent(activeChatId)}/messages/${encodeURIComponent(messageId)}/pin`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ pinned })
            }
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'تغییر وضعیت پین انجام نشد');
        updateMessagePinInDom(result);
    } catch (error) {
        window.alert(error.message || 'خطا در تغییر وضعیت پین پیام');
    }
}

function updateMessagePinInDom(data) {
    if (!data?.messageId) return;
    const messageElement = document.querySelector(`[data-message-id="${data.messageId}"]`);

    const isPinned = Boolean(data.isPinned);
    if (isPinned) {
        pinnedMessages.set(data.messageId, {
            id: data.messageId,
            sender: data.sender,
            type: data.type,
            content: data.content,
            fileName: data.fileName,
            pinnedAt: data.pinnedAt,
            pinnedBy: data.pinnedBy
        });
    } else {
        pinnedMessages.delete(data.messageId);
    }
    renderPinnedMessageBar();

    if (!messageElement) return;
    messageElement.dataset.pinned = String(isPinned);
    messageElement.classList.toggle('pinned', isPinned);

    let badge = messageElement.querySelector('.message-pin-badge');
    if (!isPinned) {
        badge?.remove();
        return;
    }

    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'message-pin-badge';
        badge.innerHTML = '<i class="fas fa-thumbtack" aria-hidden="true"></i><span>پین‌شده</span>';
        const header = messageElement.querySelector('.message-header');
        header?.appendChild(badge);
    }
    badge.title = data.pinnedBy ? `پین‌شده توسط ${data.pinnedBy}` : 'پیام پین‌شده';
}

function getPinnedMessagePreview(message) {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (content) return `${message.sender || 'ناشناس'}: ${content}`;
    if (message?.type === 'voice') return `${message.sender || 'ناشناس'}: پیام صوتی`;
    if (message?.fileName) return `${message.sender || 'ناشناس'}: ${message.fileName}`;
    if (message?.type === 'music') return `${message.sender || 'ناشناس'}: موسیقی`;
    if (message?.type === 'file') return `${message.sender || 'ناشناس'}: فایل`;
    return `${message?.sender || 'ناشناس'}: پیام`;
}

function renderPinnedMessageBar() {
    const bar = document.getElementById('pinnedMessageBar');
    const text = document.getElementById('pinnedMessageText');
    if (!bar || !text) return;

    const latest = [...pinnedMessages.values()].sort((a, b) =>
        new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0)
    )[0];
    visiblePinnedMessageId = latest?.id || null;
    bar.hidden = !latest;
    if (latest) text.textContent = getPinnedMessagePreview(latest);
    adjustMessagesHeight();
}

function updateMessageInDom(message) {
    if (!message?.id) return;
    const messageElement = document.querySelector(`[data-message-id="${message.id}"]`);
    if (!messageElement) return;

    const contentElement = messageElement.querySelector('.message-content');
    if (contentElement) renderMessageContent(contentElement, message.content || '');

    const footer = messageElement.querySelector('.message-footer');
    if (footer && !footer.querySelector('.message-edited')) {
        const edited = document.createElement('span');
        edited.className = 'message-edited';
        edited.textContent = 'ویرایش‌شده';
        footer.prepend(edited);
    }

    document.querySelectorAll(`[data-reply-to="${message.id}"] .reply-text`).forEach(replyText => {
        replyText.textContent = message.content || '';
    });

    if (Array.isArray(message.reactions)) {
        const bubble = messageElement.querySelector('.message-bubble') || messageElement;
        let container = messageElement.querySelector('.message-reactions');
        if (!container) {
            container = document.createElement('div');
            container.className = 'message-reactions';
            container.id = `reactions-${message.id}`;
            bubble.appendChild(container);
        }
        renderReactionsList(container, message.reactions, message.id);
    }
}

function removeMessageFromDom(messageId) {
    if (!messageId) return;
    if (pendingAttentionMessageId === messageId) pendingAttentionMessageId = null;
    consumeAttentionMessage(messageId);
    if (pinnedMessages.delete(messageId)) renderPinnedMessageBar();
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);

    document.querySelectorAll(`[data-reply-to="${messageId}"]`).forEach(indicator => {
        indicator.classList.add('reply-deleted');
        const text = indicator.querySelector('.reply-text');
        if (text) text.textContent = 'پیام حذف شده است';
    });

    if (currentReply.messageId === messageId) {
        const page = currentReply.page;
        document.getElementById('replyPreview')?.style.setProperty('display', 'none');
        currentReply = { page: null, messageId: null, sender: null, text: null };
    }

    if (currentEditing?.id === messageId) cancelEditing(currentEditing.page);
    if (!messageElement || messageElement.dataset.removing === 'true') return;

    closeMessageActions();
    const container = messageElement.closest('.messages-container');
    messageElement.dataset.removing = 'true';
    messageElement.style.height = `${messageElement.offsetHeight}px`;
    messageElement.style.overflow = 'hidden';

    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => messageElement.classList.add('message-removing'));
    });

    window.setTimeout(() => {
        messageElement.remove();
        if (container) applyHistoryFilter();
    }, 320);
}

document.addEventListener('click', closeMessageActions);
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (voiceRecorder) cancelVoiceRecording();
    else if (activeMessageActions || activeReactionBar) closeMessageActions();
    else if (currentEditing) cancelEditing(currentEditing.page);
});
document.addEventListener('scroll', closeMessageActions, true);
window.addEventListener('resize', closeMessageActions);

// ==============================================
// مدیریت Reply (فقط تابع setReply و clearReplyPreview باقی بماند)
// ==============================================

function setReply(messageElement, page) {
    if (activeHistoryFilter !== 'all') setHistoryFilter('all');
    const messageId = messageElement.getAttribute('data-message-id');
    const sender = messageElement.querySelector('.sender-name').textContent;
    const text = messageElement.querySelector('.message-content').textContent.trim();

    currentReply = { page, messageId, sender, text };

    // نمایش پیش‌نمایش Reply
    showReplyPreview(page, sender, text);

    // حذف پیش‌نمایش فایل اگر وجود دارد
    clearFilePreview(page);
}

function showReplyPreview(page, sender, text) {
    const preview = document.getElementById('replyPreview');
    const senderElement = document.getElementById('replyPreviewSender');
    const textElement = document.getElementById('replyPreviewText');

    applyUserTheme(preview, sender, 'reply');
    senderElement.textContent = sender;
    textElement.textContent = text.length > 50 ? text.substring(0, 50) + '...' : text;
    preview.style.display = 'flex';
    syncComposerState(getComposerInput(page));

    // تنظیم ارتفاع مجدد
    adjustMessagesHeight();
}

function clearReplyPreview(page) {
    if (currentEditing?.page === normalizeComposerPage(page)) {
        cancelEditing(page);
        return;
    }

    const preview = document.getElementById('replyPreview');
    preview.style.display = 'none';
    currentReply = { page: null, messageId: null, sender: null, text: null };
    syncComposerState(getComposerInput(page));

    // تنظیم ارتفاع مجدد
    adjustMessagesHeight();
}

function normalizeMessageSection(page) {
    return 'main';
}

// اسکرول به پیام خاص
function scrollToMessage(messageId, page, returnMessageId = null) {
    const section = normalizeMessageSection(page);
    const container = getContainerForSection(section);
    const message = container.querySelector(`[data-message-id="${messageId}"]`);

    if (message) {
        if (returnMessageId && returnMessageId !== messageId) {
            replyNavigationTargets[section] = returnMessageId;
            updateScrollToBottomButton(section);
        }

        // هایلایت موقت پیام
        message.style.backgroundColor = 'rgba(0, 136, 204, 0.2)';
        message.style.transition = 'background-color 0.3s';

        // اسکرول به پیام
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // حذف هایلایت بعد از 2 ثانیه
        setTimeout(() => {
            message.style.backgroundColor = '';
        }, 2000);
    }
}

function updateAttentionJumpButton() {
    const button = document.getElementById('attentionJumpBtn');
    const count = document.getElementById('attentionJumpCount');
    if (!button || !count) return;

    const remaining = attentionMessageIds.length;
    button.hidden = remaining === 0;
    button.disabled = Boolean(pendingAttentionMessageId);
    count.textContent = remaining.toLocaleString('fa-IR');
    button.title = remaining
        ? `${remaining.toLocaleString('fa-IR')} منشن یا پاسخ خوانده‌نشده`
        : '';
}

function consumeAttentionMessage(messageId) {
    attentionMessageIds = attentionMessageIds.filter(id => id !== messageId);
    updateAttentionJumpButton();
}

function jumpToNextAttentionMessage() {
    if (pendingAttentionMessageId || !attentionMessageIds.length) return;
    const messageId = attentionMessageIds[0];
    const message = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (message) {
        consumeAttentionMessage(messageId);
        scrollToMessage(messageId, 'main');
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    pendingAttentionMessageId = messageId;
    updateAttentionJumpButton();
    socket.send(JSON.stringify({ event: 'load_attention', message_id: messageId }));
}

// ==============================================

// ==============================================
// مدیریت فایل
// ==============================================

// تنظیم فایل برای آپلود
function setFile(file, page) {
    if (file.size > MAX_UPLOAD_SIZE) {
        window.alert('حجم فایل نباید بیشتر از ۲۰ مگابایت باشد.');
        const input = document.getElementById('fileInput');
        if (input) input.value = '';
        return;
    }

    currentFile = {
        page,
        file,
        fileName: file.name,
        fileSize: formatFileSize(file.size)
    };

    // نمایش پیش‌نمایش فایل
    showFilePreview(page, file.name, formatFileSize(file.size));

    // حذف پیش‌نمایش Reply اگر وجود دارد
    clearReplyPreview(page);
}

// نمایش پیش‌نمایش فایل
function showFilePreview(page, fileName, fileSize) {
    const container = document.getElementById('attachmentPreviewContainer');
    const nameElement = document.getElementById('previewFileName');
    const sizeElement = document.getElementById('previewFileSize');

    nameElement.textContent = fileName;
    sizeElement.textContent = fileSize;
    container.style.display = 'block';
    syncComposerState(getComposerInput(page));

    // تنظیم ارتفاع مجدد
    adjustMessagesHeight();
}

// حذف پیش‌نمایش فایل
function clearFilePreview(page) {
    const container = document.getElementById('attachmentPreviewContainer');
    container.style.display = 'none';
    currentFile = { page: null, file: null, fileName: null, fileSize: null };

    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
    syncComposerState(getComposerInput(page));

    // تنظیم ارتفاع مجدد
    adjustMessagesHeight();
}

// ==============================================
// مدیریت ارسال پیام
// ==============================================

function setComposerSending(page, isSending) {
    const input = getComposerInput(page);
    const sendButton = getComposerSendButton(page);
    const attachmentButton = document.getElementById('attachmentBtn');

    if (input) input.readOnly = isSending;
    if (sendButton) {
        sendButton.disabled = isSending;
        sendButton.classList.toggle('uploading', isSending);
        if (normalizeComposerPage(page) === 'chat' && isSending) {
            sendButton.classList.remove('voice-mode');
        }
        sendButton.innerHTML = isSending
            ? '<i class="fas fa-spinner"></i>'
            : '<i class="fas fa-arrow-up"></i>';
    }
    if (attachmentButton) attachmentButton.disabled = isSending || !canCurrentMember('can_send_media');
    if (!isSending && input) syncComposerState(input);
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await fetch(`/api/rooms/${encodeURIComponent(activeChatId)}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.file?.path) {
        throw new Error(result.message || 'آپلود فایل انجام نشد');
    }

    return result.file;
}

function getVoiceRecordingMimeType() {
    if (!window.MediaRecorder) return '';
    if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
    return [
        'audio/webm;codecs=opus',
        'audio/ogg;codecs=opus',
        'audio/mp4'
    ].find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getVoiceFileExtension(mimeType) {
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4')) return 'm4a';
    return 'webm';
}

function updateVoiceRecordingTimer() {
    const output = document.getElementById('voiceRecordingTime');
    if (!output) return;
    const elapsedSeconds = Math.floor((Date.now() - voiceRecordingStartedAt) / 1000);
    const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const seconds = String(elapsedSeconds % 60).padStart(2, '0');
    output.textContent = `${minutes}:${seconds}`.replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[digit]);
}

function setVoiceRecordingUi(isRecording) {
    const status = document.getElementById('voiceRecordingStatus');
    const button = document.getElementById('sendButton');
    const input = document.getElementById('messageInput');
    const attachmentButton = document.getElementById('attachmentBtn');

    if (status) status.hidden = !isRecording;
    if (input) input.readOnly = isRecording;
    if (attachmentButton) attachmentButton.disabled = isRecording;
    if (!button) return;

    button.classList.toggle('recording', isRecording);
    button.classList.toggle('voice-mode', !isRecording);
    if (isRecording) {
        button.title = 'توقف و ارسال پیام صوتی';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<i class="fas fa-stop"></i>';
    } else if (input) {
        syncComposerState(input);
    }
    adjustMessagesHeight();
}

function releaseVoiceStream() {
    clearInterval(voiceRecordingTimer);
    voiceRecordingTimer = null;
    voiceStream?.getTracks().forEach(track => track.stop());
    voiceStream = null;
}

async function sendRecordedVoice(blob) {
    if (!blob.size) throw new Error('صدایی ضبط نشد؛ دوباره تلاش کنید.');
    if (blob.size > MAX_UPLOAD_SIZE) throw new Error('حجم پیام صوتی نباید بیشتر از ۲۰ مگابایت باشد.');
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('اتصال گفتگو قطع شده است');

    const reply = normalizeComposerPage(currentReply.page) === 'chat' && currentReply.messageId
        ? { id: currentReply.messageId, sender: currentReply.sender, text: currentReply.text }
        : null;
    const extension = getVoiceFileExtension(blob.type);
    const voiceFile = new File([blob], `پیام صوتی.${extension}`, {
        type: blob.type || 'audio/webm'
    });

    isSendingMessage = true;
    setComposerSending('chat', true);
    try {
        const uploadedFile = await uploadFile(voiceFile);
        if (socket.readyState !== WebSocket.OPEN) throw new Error('اتصال گفتگو قطع شده است');
        socket.send(JSON.stringify({
            type: 'voice',
            page: 'chat',
            chat_id: activeChatId,
            content: null,
            sender: currentUsername,
            reply,
            file: uploadedFile
        }));
        if (!reply || currentReply.messageId === reply.id) clearReplyPreview('chat');
    } finally {
        isSendingMessage = false;
        setComposerSending('chat', false);
    }
}

async function startVoiceRecording() {
    if (voiceRecorder || isStartingVoiceRecording || isSendingMessage) return;
    if (!canCurrentMember('can_send_media')) {
        window.alert('ارسال محتوای شما توسط ادمین غیرفعال شده است.');
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        window.alert('ضبط صدا در این مرورگر پشتیبانی نمی‌شود. لطفاً از مرورگر به‌روز و اتصال امن استفاده کنید.');
        return;
    }

    isStartingVoiceRecording = true;
    try {
        voiceStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        const mimeType = getVoiceRecordingMimeType();
        voiceRecorder = mimeType
            ? new MediaRecorder(voiceStream, { mimeType })
            : new MediaRecorder(voiceStream);
        voiceChunks = [];
        discardVoiceRecording = false;

        voiceRecorder.addEventListener('dataavailable', event => {
            if (event.data.size) voiceChunks.push(event.data);
        });
        voiceRecorder.addEventListener('stop', async () => {
            const recorder = voiceRecorder;
            const shouldDiscard = discardVoiceRecording;
            voiceRecorder = null;
            releaseVoiceStream();
            setVoiceRecordingUi(false);

            if (shouldDiscard) {
                voiceChunks = [];
                return;
            }

            const blob = new Blob(voiceChunks, { type: recorder.mimeType || 'audio/webm' });
            voiceChunks = [];
            try {
                await sendRecordedVoice(blob);
            } catch (error) {
                window.alert(error.message || 'ارسال پیام صوتی انجام نشد');
            }
        }, { once: true });

        voiceRecorder.start(500);
        voiceRecordingStartedAt = Date.now();
        updateVoiceRecordingTimer();
        voiceRecordingTimer = setInterval(updateVoiceRecordingTimer, 1000);
        setVoiceRecordingUi(true);
    } catch (error) {
        voiceRecorder = null;
        releaseVoiceStream();
        setVoiceRecordingUi(false);
        const message = error?.name === 'NotAllowedError'
            ? 'برای ضبط پیام صوتی، دسترسی میکروفون را فعال کنید.'
            : 'شروع ضبط صدا ممکن نشد.';
        window.alert(message);
    } finally {
        isStartingVoiceRecording = false;
    }
}

function stopVoiceRecording() {
    if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
}

function cancelVoiceRecording() {
    if (!voiceRecorder) return;
    discardVoiceRecording = true;
    if (voiceRecorder.state === 'recording') voiceRecorder.stop();
}

// ارسال پیام جدید
async function sendMessage(page) {
    if (currentEditing?.page === normalizeComposerPage(page)) {
        submitMessageEdit(page);
        return;
    }

    if (isSendingMessage) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!currentUsername) {
        console.error('No username, message not sent');
        return;
    }
    page = 'chat';
    const input = document.getElementById('messageInput');

    const messageText = input.value.trim();
    const selectedFile = currentFile.page === page ? currentFile.file : null;
    const reply = currentReply.messageId
        ? {
            id: currentReply.messageId,
            sender: currentReply.sender,
            text: currentReply.text
        }
        : null;

    if (!messageText && !reply && !selectedFile) return;
    if (selectedFile && !canCurrentMember('can_send_media')) {
        window.alert('ارسال محتوای شما توسط ادمین غیرفعال شده است.');
        return;
    }
    if (!selectedFile && !canCurrentMember('can_send_messages')) {
        window.alert('ارسال پیام متنی شما توسط ادمین غیرفعال شده است.');
        return;
    }

    isSendingMessage = true;
    setComposerSending(page, true);

    try {
        const uploadedFile = selectedFile ? await uploadFile(selectedFile) : null;
        if (socket.readyState !== WebSocket.OPEN) throw new Error('اتصال گفتگو قطع شده است');

        socket.send(JSON.stringify({
            type: uploadedFile
                ? (selectedFile.type.startsWith('audio/') ? 'music' : 'file')
                : 'text',
            page: 'main',
            chat_id: activeChatId,
            content: messageText || null,
            sender: currentUsername,
            reply,
            file: uploadedFile
        }));

        input.value = '';
        syncComposerState(input);
        autoResizeTextarea(input);
        if (!reply || currentReply.messageId === reply.id) clearReplyPreview(page);
        if (!selectedFile || currentFile.file === selectedFile) clearFilePreview(page);
    } catch (error) {
        window.alert(error.message || 'ارسال فایل انجام نشد');
    } finally {
        isSendingMessage = false;
        setComposerSending(page, false);
    }
}

// تشخیص نوع فایل
function getFileType(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    const fileTypes = {
        'pdf': { icon: 'file-pdf', color: '#FF6B6B' },
        'doc': { icon: 'file-word', color: '#2B579A' },
        'docx': { icon: 'file-word', color: '#2B579A' },
        'xls': { icon: 'file-excel', color: '#217346' },
        'xlsx': { icon: 'file-excel', color: '#217346' },
        'ppt': { icon: 'file-powerpoint', color: '#D24726' },
        'pptx': { icon: 'file-powerpoint', color: '#D24726' },
        'jpg': { icon: 'file-image', color: '#FFA726' },
        'jpeg': { icon: 'file-image', color: '#FFA726' },
        'png': { icon: 'file-image', color: '#4CAF50' },
        'gif': { icon: 'file-image', color: '#F44336' },
        'mp3': { icon: 'file-audio', color: '#9C27B0' },
        'wav': { icon: 'file-audio', color: '#9C27B0' },
        'mp4': { icon: 'file-video', color: '#FF5722' },
        'avi': { icon: 'file-video', color: '#FF5722' },
        'zip': { icon: 'file-archive', color: '#795548' },
        'rar': { icon: 'file-archive', color: '#795548' }
    };

    return fileTypes[extension] || { icon: 'file', color: '#0088cc' };
}

function getSafeFileUrl(filePath) {
    if (typeof filePath !== 'string') return null;

    try {
        const url = new URL(filePath, window.location.origin);
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/uploads/')) return null;
        return `${url.pathname}${url.search}`;
    } catch {
        return null;
    }
}

function createDownloadLink(file, className) {
    const link = document.createElement('a');
    link.className = className;
    link.href = getSafeFileUrl(file.path) || '#';
    link.download = file.name || 'file';
    link.title = 'دانلود فایل';
    link.setAttribute('aria-label', `دانلود ${file.name || 'فایل'}`);
    link.innerHTML = '<i class="fas fa-download"></i>';
    return link;
}

function readAudioDuration(audio, onReady) {
    audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) onReady(audio.duration);
    }, { once: true });
}

function createVoiceAttachment(file, fileUrl) {
    const player = document.createElement('div');
    player.className = 'voice-player';

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'audio-play-btn voice-play-btn';
    playButton.setAttribute('aria-label', 'پخش پیام صوتی');
    playButton.innerHTML = '<i class="fas fa-play"></i>';

    const details = document.createElement('div');
    details.className = 'voice-details';
    const waveform = document.createElement('div');
    waveform.className = 'voice-waveform';
    waveform.setAttribute('role', 'slider');
    waveform.setAttribute('aria-label', 'موقعیت پخش پیام صوتی');
    waveform.setAttribute('aria-valuemin', '0');
    waveform.setAttribute('aria-valuemax', '100');
    waveform.setAttribute('aria-valuenow', '0');

    const heights = [9, 16, 25, 13, 29, 19, 11, 23, 31, 17, 26, 12, 20, 28, 15, 24, 10, 19, 30, 14, 22, 27, 12, 25, 18, 9, 21, 15, 28, 17, 23, 11];
    heights.forEach((height, index) => {
        const bar = document.createElement('span');
        bar.style.setProperty('--bar-height', `${height}px`);
        bar.style.setProperty('--bar-delay', `${(index % 8) * -0.07}s`);
        waveform.appendChild(bar);
    });

    const time = document.createElement('div');
    time.className = 'voice-time';
    time.textContent = '0:00';
    details.append(waveform, time);

    const audio = document.createElement('audio');
    audio.src = fileUrl;
    audio.preload = 'metadata';
    audio.hidden = true;
    readAudioDuration(audio, duration => {
        time.dataset.duration = formatTime(duration);
        time.textContent = `0:00 / ${time.dataset.duration}`;
    });

    player.append(playButton, details, audio);
    return player;
}

function createFileAttachment(file, type) {
    const fileUrl = getSafeFileUrl(file.path);
    if (!fileUrl) return null;

    if (type === 'voice') return createVoiceAttachment(file, fileUrl);

    if (type === 'music') {
        const player = document.createElement('div');
        player.className = 'music-player';

        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = 'audio-play-btn music-play-btn';
        playButton.setAttribute('aria-label', 'پخش موسیقی');
        playButton.innerHTML = '<i class="fas fa-play"></i>';

        const info = document.createElement('div');
        info.className = 'music-info';
        const title = document.createElement('div');
        title.className = 'music-title';
        title.textContent = file.name || 'فایل صوتی';
        const progress = document.createElement('div');
        progress.className = 'music-progress';
        const progressFilled = document.createElement('div');
        progressFilled.className = 'music-progress-filled';
        progress.appendChild(progressFilled);
        const time = document.createElement('div');
        time.className = 'music-time';
        time.textContent = formatFileSize(Number(file.size) || 0);
        info.append(title, progress, time);

        const audio = document.createElement('audio');
        audio.src = fileUrl;
        audio.preload = 'metadata';
        audio.hidden = true;
        readAudioDuration(audio, duration => {
            time.textContent = formatTime(duration);
        });

        player.append(playButton, info, createDownloadLink(file, 'music-download-btn'), audio);
        return player;
    }

    const attachment = document.createElement('div');
    attachment.className = 'file-attachment';
    const fileType = getFileType(file.name || '');

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.style.color = fileType.color;
    icon.innerHTML = `<i class="fas fa-${fileType.icon}"></i>`;

    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name || 'فایل';
    const size = document.createElement('div');
    size.className = 'file-size';
    size.textContent = formatFileSize(Number(file.size) || 0);
    info.append(name, size);

    attachment.append(icon, info, createDownloadLink(file, 'download-btn'));
    return attachment;
}

// ==============================================
// مدیریت دکمه اسکرول به پایین
// ==============================================

// به‌روزرسانی وضعیت دکمه اسکرول به پایین
function updateScrollToBottomButton(page) {
    const section = 'main';
    const container = document.getElementById('messagesContainer');
    const button = document.getElementById('scrollToBottomBtn');

    if (!container || !button) return;

    // محاسبه فاصله از پایین
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

    // نمایش دکمه اگر از پایین فاصله داریم
    const hasReplyReturn = Boolean(replyNavigationTargets[section]);
    button.classList.toggle('reply-return', hasReplyReturn);
    button.title = hasReplyReturn ? 'بازگشت به پیام ریپلای‌کننده' : 'رفتن به آخرین پیام';
    button.setAttribute('aria-label', button.title);

    if (distanceFromBottom > 100 || hasReplyReturn) {
        button.classList.add('visible');
    } else {
        button.classList.remove('visible');
    }
}

function handleScrollButton(page) {
    const section = normalizeMessageSection(page);
    const returnMessageId = replyNavigationTargets[section];

    if (returnMessageId) {
        replyNavigationTargets[section] = null;
        scrollToMessage(returnMessageId, section);
        window.setTimeout(() => updateScrollToBottomButton(section), 450);
        return;
    }

    scrollToBottom(page);
}

// اسکرول به پایین
function scrollToBottom(page) {
    const container = document.getElementById('messagesContainer');

    if (container) {
        container.scrollTop = container.scrollHeight;
        updateScrollToBottomButton(page);
    }
}

// ==============================================
// تنظیم ارتفاع کانتینر پیام‌ها
// ==============================================

function adjustMessagesHeight() {
    const activeArea = chatArea;
    if (!activeArea) return;

    const chatHeader = activeArea.querySelector('.chat-header');
    const inputContainer = activeArea.querySelector('.message-input-container');
    const filterBanner = activeArea.querySelector('.history-filter:not([hidden])');
    const pinnedBar = activeArea.querySelector('.pinned-message-bar:not([hidden])');
    const messagesContainer = activeArea.querySelector('.messages-container');

    if (chatHeader && inputContainer && messagesContainer) {
        const headerHeight = chatHeader.offsetHeight;
        const inputHeight = inputContainer.offsetHeight;
        const availableHeight = Math.max(0, activeArea.clientHeight - headerHeight - inputHeight
            - (filterBanner?.offsetHeight || 0) - (pinnedBar?.offsetHeight || 0));
        messagesContainer.style.height = `${availableHeight}px`;
    }
}

// ==============================================
// رندر پیام دریافتی از سرور (WebSocket)
// ==============================================
function renderMessageFromServer(message, autoScroll = true, loadedFor = 'all') {
    const existing = document.querySelector(`[data-message-id="${message.id}"]`);
    if (existing) {
        const sources = new Set((existing.dataset.loadedFor || '').split(' ').filter(Boolean));
        sources.add(loadedFor);
        existing.dataset.loadedFor = [...sources].join(' ');
        return;
    }

    const {
        id,
        type: rawType,
        section,
        content,
        sender,
        reply,
        createdAt,
        editedAt,
        file,
        seenBy = [],
        seenDetails = [],
        reactions = [],
        isPinned = false,
        pinnedBy = null
    } = message;
    const type = rawType;
    const container = document.getElementById('messagesContainer');

    const messageElement = document.createElement('div');
    messageElement.className = `message ${sender === currentUsername ? 'sent' : 'received'}`;
    if (type === 'music' || type === 'file' || type === 'voice') messageElement.classList.add(type);
    messageElement.setAttribute('data-message-id', id);
    messageElement.setAttribute('data-created-at', createdAt);
    messageElement.setAttribute('data-message-type', type);
    messageElement.setAttribute('data-section', 'main');
    messageElement.setAttribute('data-loaded-for', loadedFor);
    messageElement.setAttribute('data-pinned', String(Boolean(isPinned)));
    if (isBatchRendering && loadedFor === 'all' && sender !== currentUsername && !seenBy.includes(currentUsername)) {
        // Keep the opening-session boundary stable even after the viewport
        // reports these messages as read a moment later.
        messageElement.setAttribute('data-was-unread-at-open', 'true');
    }
    messageElement.classList.toggle('pinned', Boolean(isPinned));
    applyUserTheme(messageElement, sender);
    attachMessageActions(messageElement);

    // reply button
    const replyBtn = document.createElement('button');
    replyBtn.className = 'message-reply-btn';
    replyBtn.innerHTML = '<i class="fas fa-reply"></i>';
    replyBtn.addEventListener('click', () => setReply(messageElement, 'main'));
    messageElement.appendChild(replyBtn);
    attachReplyGesture(messageElement, 'main');

    // react button
    const reactBtn = document.createElement('button');
    reactBtn.className = 'message-react-btn';
    reactBtn.type = 'button';
    reactBtn.title = 'واکنش (ریکشن)';
    reactBtn.setAttribute('aria-label', 'واکنش به پیام');
    reactBtn.innerHTML = '<i class="far fa-smile"></i>';
    reactBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFloatingReactionBar(messageElement, reactBtn);
    });
    messageElement.appendChild(reactBtn);

    // header
    const header = document.createElement('div');
    header.className = 'message-header';
    const senderName = document.createElement('span');
    senderName.className = 'sender-name';
    senderName.textContent = sender;
    header.appendChild(senderName);
    if (isPinned) {
        const pinBadge = document.createElement('span');
        pinBadge.className = 'message-pin-badge';
        pinBadge.title = pinnedBy ? `پین‌شده توسط ${pinnedBy}` : 'پیام پین‌شده';
        pinBadge.innerHTML = '<i class="fas fa-thumbtack" aria-hidden="true"></i><span>پین‌شده</span>';
        header.appendChild(pinBadge);
    }
    messageElement.appendChild(header);

    // bubble + content
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (file) {
        const attachment = createFileAttachment(file, type);
        if (attachment) bubble.appendChild(attachment);
    }

    const body = document.createElement('div');
    body.className = 'message-content';
    if (content) renderMessageContent(body, content);
    bubble.appendChild(body);
    messageElement.appendChild(bubble);

    // footer
    const footer = document.createElement('div');
    footer.className = 'message-footer';
    if (editedAt) {
        const edited = document.createElement('span');
        edited.className = 'message-edited';
        edited.textContent = 'ویرایش‌شده';
        footer.appendChild(edited);
    }
    const dateTime = document.createElement('span');
    dateTime.className = 'message-datetime';
    dateTime.textContent = formatMessageDateTime(new Date(createdAt));
    footer.appendChild(dateTime);

    if (sender === currentUsername) {
        const viewers = [...new Set(seenBy.filter(username => username !== currentUsername))];
        const status = document.createElement('span');
        status.className = `message-status${viewers.length ? ' seen' : ''}`;
        status.dataset.seenBy = JSON.stringify(viewers);
        status.dataset.seenDetails = JSON.stringify(seenDetails.filter(item =>
            item?.username && item.username !== currentUsername
        ));
        const statusIcon = viewers.length ? document.createElement('img') : document.createElement('i');
        if (viewers.length) {
            statusIcon.className = 'seen-status-icon';
            statusIcon.src = '/icons/double-check-svgrepo-com.svg';
            statusIcon.alt = '';
        } else {
            statusIcon.className = 'fas fa-check';
            statusIcon.setAttribute('aria-hidden', 'true');
        }
        status.appendChild(statusIcon);
        status.title = viewers.length
            ? `دیده‌شده توسط ${viewers.join('، ')}`
            : 'ارسال‌شده';
        status.setAttribute('aria-label', status.title);
        footer.appendChild(status);
    }
    messageElement.appendChild(footer);

    // reactions container inside message-bubble
    const reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'message-reactions';
    reactionsContainer.id = `reactions-${id}`;
    renderReactionsList(reactionsContainer, reactions, id);
    bubble.appendChild(reactionsContainer);

    insertMessageSorted(container, messageElement, createdAt);

    // اگر پیام ریپلای دارد فقط در pending ذخیره کن
    if (reply && reply.id) {
        pendingReplies.push({
            messageElement,
            replyData: reply,
            section: 'main'
        });
    }

    // ریپلای پیام‌های realtime را همان لحظه نمایش بده و pendingهای قبلی را هم resolve کن.
    loadPendingReplies();
    resolvePendingReplies();

    if (autoScroll) {
        container.scrollTop = container.scrollHeight;
    }
}

// ==============================================
// رویدادهای اصلی صفحه
// ==============================================

document.addEventListener('DOMContentLoaded', function() {
    const groupProfileTrigger = document.getElementById('groupProfileTrigger');
    if (groupProfileTrigger) {
        groupProfileTrigger.addEventListener('click', openGroupMembers);
    }

    // ایمن‌سازی رویدادهای بستن Reply Preview
    const replyPreviewClose = document.getElementById('replyPreviewClose');
    if (replyPreviewClose) {
        replyPreviewClose.addEventListener('click', () => {
            if (currentEditing?.page === 'chat') cancelEditing('chat');
            else clearReplyPreview('chat');
        });
    }
    document.getElementById('editCancelButton')?.addEventListener('click', () => cancelEditing('chat'));

    // ایمن‌سازی رویدادهای بستن File Preview
    const removeAttachment = document.getElementById('removeAttachment');
    if (removeAttachment) {
        removeAttachment.addEventListener('click', () => clearFilePreview('chat'));
    }
    // ایمن‌سازی رویدادهای textarea و ارسال با اینتر
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('input', () => {
            autoResizeTextarea(messageInput);
            syncComposerState(messageInput);
            renderMentionSuggestions(messageInput);
        });
        messageInput.addEventListener('keydown', event => {
            if (!mentionSuggestionState.matches.length) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveMentionSuggestion(event.key === 'ArrowDown' ? 1 : -1);
            } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
                event.preventDefault();
                selectMentionSuggestion();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closeMentionSuggestions();
            }
        });
        messageInput.addEventListener('blur', () => {
            window.setTimeout(closeMentionSuggestions, 120);
        });
        messageInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage('chat');
            }
        });
    }
    // ایمن‌سازی دکمه‌های ارسال
    const sendButton = document.getElementById('sendButton');
    if (sendButton) {
        sendButton.addEventListener('click', () => {
            if (voiceRecorder) {
                stopVoiceRecording();
            } else if (sendButton.classList.contains('voice-mode')) {
                startVoiceRecording();
            } else {
                sendMessage('chat');
            }
        });
    }
    document.getElementById('cancelRecordingButton')?.addEventListener('click', cancelVoiceRecording);
    // ایمن‌سازی دکمه‌های اسکرول به پایین
    const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
    if (scrollToBottomBtn) {
        scrollToBottomBtn.addEventListener('click', () => handleScrollButton('chat'));
    }
    document.getElementById('attentionJumpBtn')?.addEventListener('click', jumpToNextAttentionMessage);
    // ایمن‌سازی رویدادهای اسکرول برای نمایش/پنهان کردن دکمه اسکرول به پایین
    const messagesContainer = document.getElementById('messagesContainer');
    if (messagesContainer) {
        messagesContainer.addEventListener('scroll', () => {
            updateScrollToBottomButton('chat');
            scheduleViewportStateSync();
        });
    }
    // ایمن‌سازی رویدادهای انتخاب فایل
    const attachmentBtn = document.getElementById('attachmentBtn');
    if (attachmentBtn) {
        attachmentBtn.addEventListener('click', () => {
            const fileInput = document.getElementById('fileInput');
            if (fileInput) fileInput.click();
        });
    }
    // ایمن‌سازی رویدادهای تغییر فایل
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) setFile(file, 'chat');
        });
    }
    // فیلترهای آرشیو روی همان جریان اصلی پیام‌ها اعمال می‌شوند.
    const musicBtn = document.getElementById('musicBtn');
    if (musicBtn) {
        musicBtn.addEventListener('click', () => setHistoryFilter(activeHistoryFilter === 'music' ? 'all' : 'music'));
    }
    const fileBtn = document.getElementById('fileBtn');
    if (fileBtn) {
        fileBtn.addEventListener('click', () => setHistoryFilter(activeHistoryFilter === 'file' ? 'all' : 'file'));
    }
    document.getElementById('clearHistoryFilter')?.addEventListener('click', () => setHistoryFilter('all'));
    document.getElementById('pinnedMessageJump')?.addEventListener('click', () => {
        if (visiblePinnedMessageId) scrollToMessage(visiblePinnedMessageId, 'main');
    });
    document.getElementById('pinnedMessageUnpin')?.addEventListener('click', event => {
        event.stopPropagation();
        if (visiblePinnedMessageId) setMessagePin(visiblePinnedMessageId, false);
    });

    // تنظیم ارتفاع اولیه
    adjustMessagesHeight();

    // شبیه‌سازی دانلود فایل
    window.downloadFile = function(fileName, fileSize) {
        alert(`در حال دانلود فایل: ${fileName} (${fileSize})\n\nتوجه: این یک شبیه‌سازی است. در نسخه واقعی فایل دانلود می‌شود.`);
    };

    // راه‌اندازی WebSocket و عضویت چت
    initChatSocket();
});

// ==============================================
// توابع کمکی دیگر
// ==============================================

window.addEventListener('resize', adjustMessagesHeight);
window.addEventListener('beforeunload', () => {
    shouldReconnectSocket = false;
    clearTimeout(socketReconnectTimer);
    socketReconnectTimer = null;
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleViewportStateSync();
});
window.addEventListener('pagehide', () => {
    clearTimeout(positionSaveTimer);
    saveCurrentScrollPosition(getActiveMessagesContainer());
    if (voiceRecorder) {
        discardVoiceRecording = true;
        if (voiceRecorder.state === 'recording') voiceRecorder.stop();
    }
});

document.addEventListener('click', e => {
    const btn = e.target.closest('.audio-play-btn');
    if (!btn) return;

    const msg = btn.closest('.message');
    const audio = msg.querySelector('audio');

    if (currentAudio && currentAudio !== audio) {
        currentAudio.pause();
        resetAudioPlayers();
    }

    if (audio.paused) {
        audio.play();
        btn.innerHTML = '<i class="fas fa-pause"></i>';
        msg.querySelector('.voice-player')?.classList.add('playing');
        currentAudio = audio;

        audio.ontimeupdate = () => updateAudioUI(audio);
        audio.onended = () => handleAudioEnded(audio);
    } else {
        audio.pause();
        btn.innerHTML = '<i class="fas fa-play"></i>';
        msg.querySelector('.voice-player')?.classList.remove('playing');
    }
});

document.addEventListener('click', e => {
    const bar = e.target.closest('.music-progress, .voice-waveform');
    if (!bar) return;

    const audio = bar.closest('.message').querySelector('audio');
    if (!Number.isFinite(audio.duration)) return;
    const rect = bar.getBoundingClientRect();

    let percent = (e.clientX - rect.left) / rect.width;
    percent = Math.min(Math.max(percent, 0), 1);

    if (document.documentElement.dir === 'rtl') {
        percent = 1 - percent;
    }

    audio.currentTime = percent * audio.duration;
    updateAudioUI(audio);
});

function updateAudioUI(audio) {
    const msg = audio.closest('.message');
    const progress = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.currentTime / audio.duration
        : 0;
    const musicProgress = msg.querySelector('.music-progress-filled');
    if (musicProgress) musicProgress.style.width = `${progress * 100}%`;
    const musicTime = msg.querySelector('.music-time');
    if (musicTime) musicTime.textContent = formatTime(audio.currentTime);

    const waveform = msg.querySelector('.voice-waveform');
    if (waveform) {
        const bars = [...waveform.children];
        bars.forEach((bar, index) => {
            bar.classList.toggle('played', (index + 1) / bars.length <= progress);
        });
        waveform.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    }
    const voiceTime = msg.querySelector('.voice-time');
    if (voiceTime) {
        const duration = voiceTime.dataset.duration || formatTime(audio.duration || 0);
        voiceTime.textContent = `${formatTime(audio.currentTime)} / ${duration}`;
    }
}

function handleAudioEnded(audio) {
    const message = audio.closest('.message');
    if (message.classList.contains('music')) {
        playNextMusic(audio);
        return;
    }
    message.querySelector('.audio-play-btn').innerHTML = '<i class="fas fa-play"></i>';
    message.querySelector('.voice-player')?.classList.remove('playing');
    currentAudio = null;
}

function playNextMusic(audio) {
    const list = [...document.querySelectorAll('.message.music audio')];
    const next = list[list.indexOf(audio) + 1];
    if (!next) {
        const playButton = audio.closest('.message')?.querySelector('.audio-play-btn');
        if (playButton) playButton.innerHTML = '<i class="fas fa-play"></i>';
        currentAudio = null;
        return;
    }

    resetAudioPlayers();
    next.play();
    next.closest('.message.music')
        .querySelector('.music-play-btn')
        .innerHTML = '<i class="fas fa-pause"></i>';

    currentAudio = next;
    next.ontimeupdate = () => updateAudioUI(next);
    next.onended = () => playNextMusic(next);
}

function resetAudioPlayers() {
    document.querySelectorAll('.audio-play-btn')
        .forEach(button => button.innerHTML = '<i class="fas fa-play"></i>');
    document.querySelectorAll('.voice-player.playing')
        .forEach(player => player.classList.remove('playing'));
}

function formatTime(t) {
    if (!Number.isFinite(t) || t < 0) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2,'0');
    return `${m}:${s}`;
}

function insertMessageSorted(container, messageElement, createdAt) {
    const time = new Date(createdAt).getTime();
    const messageId = messageElement.dataset.messageId || '';
    const messages = Array.from(container.querySelectorAll('.message'));

    for (let i = 0; i < messages.length; i++) {
        const existingTime = new Date(
            messages[i].getAttribute('data-created-at')
        ).getTime();

        const existingId = messages[i].dataset.messageId || '';
        if (time < existingTime || (time === existingTime && messageId.localeCompare(existingId) < 0)) {
            container.insertBefore(messageElement, messages[i]);
            if (!isBatchRendering) rebuildDateDividers(container);
            return;
        }
    }

    container.appendChild(messageElement);
    if (!isBatchRendering) rebuildDateDividers(container);
}

function resolvePendingReplies() {
    document.querySelectorAll('.message-reply-indicator').forEach(indicator => {
        const targetId = indicator.getAttribute('data-reply-to');
        const target = document.querySelector(
            `[data-message-id="${targetId}"]`
        );

        if (target) {
            indicator.classList.add('resolved');
        }
    });
}

async function updateMemberPermission(username, field, value, button) {
    if (button) button.disabled = true;
    try {
        const response = await fetch(
            `/api/rooms/${encodeURIComponent(activeChatId)}/members/${encodeURIComponent(username)}/permissions`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ [field]: value })
            }
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'تغییر دسترسی عضو انجام نشد');
        applyMemberPermissionsUpdate(result.member);
    } catch (error) {
        if (button) button.disabled = false;
        window.alert(error.message || 'خطا در تغییر دسترسی عضو');
    }
}

async function removeChatMember(username, button) {
    if (!window.confirm(`${username} از گروه حذف شود؟`)) return;
    if (button) button.disabled = true;
    try {
        const response = await fetch(
            `/api/rooms/${encodeURIComponent(activeChatId)}/members/${encodeURIComponent(username)}`,
            {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            }
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'حذف عضو انجام نشد');
        handleMemberRemoved({ username: result.username || username });
    } catch (error) {
        if (button) button.disabled = false;
        window.alert(error.message || 'خطا در حذف عضو');
    }
}

function createMembersModal(members = []) {
    let modal = document.getElementById('chatMembersModal');
    if (modal) {
        if (typeof modal._close === 'function') modal._close(false);
        else modal.remove();
    }

    const normalizedMembers = [...new Set(members
        .map(member => typeof member === 'string' ? member : member?.username || member?.name)
        .filter(Boolean))];
    const trigger = document.getElementById('groupProfileTrigger');

    modal = document.createElement('div');
    modal.id = 'chatMembersModal';
    modal.className = 'members-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'membersModalTitle');

    const box = document.createElement('div');
    box.className = 'members-card';

    const header = document.createElement('div');
    header.className = 'members-card-header';
    const titleWrapper = document.createElement('div');
    titleWrapper.className = 'members-card-title';
    const title = document.createElement('h3');
    title.id = 'membersModalTitle';
    title.textContent = `اعضای ${chatInfo.name || 'گروه'}`;
    const count = document.createElement('div');
    count.className = 'members-count-label';
    count.textContent = `${normalizedMembers.length.toLocaleString('fa-IR')} عضو · ${chatInfo.onlineCount.toLocaleString('fa-IR')} آنلاین`;
    titleWrapper.append(title, count);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'members-close';
    closeButton.setAttribute('aria-label', 'بستن فهرست اعضا');
    closeButton.innerHTML = '<i class="fas fa-times"></i>';
    header.append(titleWrapper, closeButton);

    const list = document.createElement('ul');

    normalizedMembers.forEach(name => {
        const li = document.createElement('li');
        const isOnline = chatInfo.onlineMembers.includes(name);
        const member = chatInfo.memberDetails[name] || {
            username: name,
            is_admin: false,
            can_send_messages: true,
            can_send_media: true
        };
        li.dataset.username = name;
        li.classList.toggle('online', isOnline);
        const avatar = document.createElement('span');
        avatar.className = 'member-avatar';
        avatar.textContent = (name || '؟').trim().charAt(0).toUpperCase();
        applyUserTheme(avatar, name);
        avatar.style.background = 'var(--user-soft)';
        avatar.style.color = 'var(--user-color)';

        const label = document.createElement('span');
        label.className = 'member-name';
        label.textContent = name;
        li.append(avatar, label);

        if (member.is_admin) {
            const adminBadge = document.createElement('span');
            adminBadge.className = 'member-admin-badge';
            adminBadge.innerHTML = '<i class="fas fa-shield-halved" aria-hidden="true"></i><span>ادمین</span>';
            li.appendChild(adminBadge);
        }

        const onlineStatus = document.createElement('span');
        onlineStatus.className = 'member-online-status';
        onlineStatus.hidden = !isOnline;
        onlineStatus.innerHTML = '<span class="member-online-dot" aria-hidden="true"></span><span>آنلاین</span>';
        li.appendChild(onlineStatus);

        if (name === currentUsername) {
            const you = document.createElement('span');
            you.className = 'member-you';
            you.textContent = 'شما';
            li.appendChild(you);
        }

        if (chatInfo.currentMember?.is_admin && name !== currentUsername && !member.is_admin) {
            const actions = document.createElement('div');
            actions.className = 'member-admin-actions';

            const messageButton = document.createElement('button');
            messageButton.type = 'button';
            messageButton.className = `member-permission-button${member.can_send_messages ? '' : ' restricted'}`;
            messageButton.title = member.can_send_messages
                ? 'بستن دسترسی پیام متنی'
                : 'باز کردن دسترسی پیام متنی';
            messageButton.setAttribute('aria-label', messageButton.title);
            messageButton.innerHTML = `<i class="fas ${member.can_send_messages ? 'fa-comment-slash' : 'fa-comment'}"></i><span>${member.can_send_messages ? 'بستن پیام' : 'بازکردن پیام'}</span>`;
            messageButton.addEventListener('click', () => updateMemberPermission(
                name,
                'can_send_messages',
                !member.can_send_messages,
                messageButton
            ));

            const mediaButton = document.createElement('button');
            mediaButton.type = 'button';
            mediaButton.className = `member-permission-button${member.can_send_media ? '' : ' restricted'}`;
            mediaButton.title = member.can_send_media
                ? 'بستن دسترسی ارسال محتوا'
                : 'باز کردن دسترسی ارسال محتوا';
            mediaButton.setAttribute('aria-label', mediaButton.title);
            mediaButton.innerHTML = `<i class="fas ${member.can_send_media ? 'fa-photo-film' : 'fa-image'}"></i><span>${member.can_send_media ? 'بستن محتوا' : 'بازکردن محتوا'}</span>`;
            mediaButton.addEventListener('click', () => updateMemberPermission(
                name,
                'can_send_media',
                !member.can_send_media,
                mediaButton
            ));

            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'member-remove-button';
            removeButton.title = 'حذف از گروه';
            removeButton.setAttribute('aria-label', `حذف ${name} از گروه`);
            removeButton.innerHTML = '<i class="fas fa-user-xmark"></i><span>حذف عضو</span>';
            removeButton.addEventListener('click', () => removeChatMember(name, removeButton));

            actions.append(messageButton, mediaButton, removeButton);
            li.appendChild(actions);
        }
        list.appendChild(li);
    });

    if (!normalizedMembers.length) {
        const empty = document.createElement('li');
        empty.className = 'members-empty';
        empty.textContent = 'عضوی برای نمایش وجود ندارد';
        list.appendChild(empty);
    }

    box.appendChild(header);
    box.appendChild(list);
    modal.appendChild(box);

    const closeModal = (restoreFocus = true) => {
        document.removeEventListener('keydown', onKeydown);
        modal.remove();
        if (restoreFocus) trigger?.focus({ preventScroll: true });
    };
    const onKeydown = event => {
        if (event.key === 'Escape') closeModal();
    };
    modal._close = closeModal;

    modal.addEventListener('click', e => {
        if (e.target === modal) closeModal();
    });
    closeButton.addEventListener('click', () => closeModal());
    document.addEventListener('keydown', onKeydown);

    document.body.appendChild(modal);
    closeButton.focus({ preventScroll: true });
}
