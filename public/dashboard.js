const token = localStorage.getItem('token');
if (!token) {
    location.replace('/auth/login');
    throw new Error('Not authenticated');
}

const chatList = document.getElementById('chatList');
const chatTotal = document.getElementById('chatTotal');
const emptyState = document.getElementById('emptyState');
const errorState = document.getElementById('errorState');
const userGreeting = document.getElementById('userGreeting');
const createChatDialog = document.getElementById('createChatDialog');
const createChatForm = document.getElementById('createChatForm');
const newChatName = document.getElementById('newChatName');
const createChatStatus = document.getElementById('createChatStatus');
const submitCreateChatButton = document.getElementById('submitCreateChatButton');

function setDashboardTheme(theme) {
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    const isDark = normalizedTheme === 'dark';
    document.documentElement.dataset.theme = normalizedTheme;

    const button = document.getElementById('themeToggleBtn');
    if (button) {
        button.setAttribute('aria-pressed', String(isDark));
        button.title = isDark ? 'فعال‌کردن حالت روشن' : 'فعال‌کردن حالت تاریک';
        button.innerHTML = isDark
            ? '<i class="far fa-sun" aria-hidden="true"></i><span>حالت روشن</span>'
            : '<i class="far fa-moon" aria-hidden="true"></i><span>حالت تاریک</span>';
    }

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = isDark ? '#1e1f22' : '#f4f7fb';
}

setDashboardTheme(localStorage.getItem('chat-theme'));

function getUsername() {
    try {
        return JSON.parse(atob(token.split('.')[1])).username || localStorage.getItem('username') || '';
    } catch (_) {
        return localStorage.getItem('username') || '';
    }
}

function getChatTheme(chatId) {
    let hash = 2166136261;
    for (const character of String(chatId)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    const hue = (hash >>> 0) % 360;
    return {
        color: `hsl(${hue} 66% 42%)`,
        soft: `hsl(${hue} 76% 94%)`
    };
}

function formatActivity(value) {
    if (!value) return 'هنوز پیامی ارسال نشده';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'آخرین فعالیت نامشخص';
    return ` آخرین فعالیت: ${new Intl.DateTimeFormat('fa-IR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date)}`;
}

function createCounter(iconClass, label, count, extraClass = '') {
    const badge = document.createElement('span');
    badge.className = `counter-badge ${extraClass}${count ? '' : ' is-empty'}`.trim();
    badge.setAttribute('aria-label', `${count.toLocaleString('fa-IR')} ${label}`);

    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    const value = document.createElement('b');
    value.textContent = count.toLocaleString('fa-IR');
    const text = document.createElement('span');
    text.textContent = label;
    badge.append(icon, value, text);
    return badge;
}

function createChatRow(chat) {
    const row = document.createElement('a');
    row.className = 'chat-row';
    row.href = `/rooms/${encodeURIComponent(chat.id)}`;
    row.setAttribute('aria-label', `ورود به چت ${chat.name}`);

    const avatar = document.createElement('span');
    avatar.className = 'chat-avatar';
    const theme = getChatTheme(chat.id);
    avatar.style.setProperty('--avatar-color', theme.color);
    avatar.style.setProperty('--avatar-soft', theme.soft);
    avatar.textContent = (chat.name || 'چ').trim().charAt(0) || 'چ';

    const main = document.createElement('span');
    main.className = 'chat-main';
    const name = document.createElement('span');
    name.className = 'chat-name';
    name.textContent = chat.name;
    const activity = document.createElement('span');
    activity.className = 'chat-activity';
    activity.textContent = formatActivity(chat.lastMessageAt);
    main.append(name, activity);

    const counters = document.createElement('span');
    counters.className = 'chat-counters';
    counters.append(
        createCounter('far fa-envelope', 'خوانده‌نشده', Number(chat.unreadCount) || 0),
        createCounter('fas fa-at', 'منشن', Number(chat.mentionCount) || 0, 'mention')
    );

    const chevron = document.createElement('i');
    chevron.className = 'fas fa-chevron-left chat-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    row.append(avatar, main, counters, chevron);
    return row;
}

function renderChats(chats) {
    chatList.replaceChildren(...chats.map(createChatRow));
    chatList.setAttribute('aria-busy', 'false');
    chatList.hidden = !chats.length;
    emptyState.hidden = Boolean(chats.length);
    errorState.hidden = true;
    chatTotal.textContent = `${chats.length.toLocaleString('fa-IR')} گفت‌وگو`;
}

async function loadChats() {
    chatList.hidden = false;
    emptyState.hidden = true;
    errorState.hidden = true;
    chatList.setAttribute('aria-busy', 'true');

    try {
        const response = await fetch('/api/rooms', {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.status === 401) {
            localStorage.removeItem('token');
            location.replace('/auth/login');
            return;
        }
        if (!response.ok) throw new Error('Could not load chats');
        const data = await response.json();
        renderChats(Array.isArray(data.chats) ? data.chats : []);
    } catch (error) {
        chatList.replaceChildren();
        chatList.hidden = true;
        chatList.setAttribute('aria-busy', 'false');
        chatTotal.textContent = 'خطا در دریافت اطلاعات';
        emptyState.hidden = true;
        errorState.hidden = false;
    }
}

function openCreateChatDialog() {
    createChatForm.reset();
    createChatStatus.textContent = '';
    createChatStatus.classList.remove('is-error');
    createChatDialog.showModal();
    requestAnimationFrame(() => newChatName.focus());
}

function closeCreateChatDialog() {
    if (!submitCreateChatButton.disabled) createChatDialog.close();
}

async function createChat(event) {
    event.preventDefault();
    const name = newChatName.value.trim();
    if (!name) {
        createChatStatus.textContent = 'لطفاً نام چت را وارد کنید.';
        createChatStatus.classList.add('is-error');
        newChatName.focus();
        return;
    }

    submitCreateChatButton.disabled = true;
    newChatName.disabled = true;
    createChatStatus.textContent = 'در حال ساخت چت…';
    createChatStatus.classList.remove('is-error');

    try {
        const response = await fetch('/api/rooms', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name })
        });
        const data = await response.json().catch(() => ({}));

        if (response.status === 401) {
            localStorage.removeItem('token');
            location.replace('/auth/login');
            return;
        }
        if (!response.ok || !data.chat?.id) {
            throw new Error(data.message || 'ساخت چت انجام نشد');
        }

        createChatStatus.textContent = 'چت ساخته شد؛ در حال انتقال…';
        location.assign(`/rooms/${encodeURIComponent(data.chat.id)}`);
    } catch (error) {
        createChatStatus.textContent = error.message || 'ساخت چت انجام نشد. دوباره تلاش کنید.';
        createChatStatus.classList.add('is-error');
        submitCreateChatButton.disabled = false;
        newChatName.disabled = false;
        newChatName.focus();
    }
}

const username = getUsername();
userGreeting.textContent = username ? `سلام ${username}` : '';
document.getElementById('retryButton').addEventListener('click', loadChats);
document.getElementById('createChatButton').addEventListener('click', openCreateChatDialog);
document.getElementById('closeCreateChatButton').addEventListener('click', closeCreateChatDialog);
document.getElementById('cancelCreateChatButton').addEventListener('click', closeCreateChatDialog);
createChatForm.addEventListener('submit', createChat);
createChatDialog.addEventListener('click', event => {
    if (event.target === createChatDialog) closeCreateChatDialog();
});
document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('chat-theme', nextTheme);
    setDashboardTheme(nextTheme);
});
document.getElementById('logoutButton').addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    location.replace('/auth/login');
});

loadChats();
