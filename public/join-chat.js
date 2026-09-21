const token = localStorage.getItem('token');

if (!token) {
    location.href = '/auth/login';
}

const pathParts = location.pathname.split('/');
const chatId = decodeURIComponent(
    pathParts.filter(Boolean)[pathParts.filter(Boolean).length - 1]
);

const headerEl = document.getElementById('chatHeader');
const membersInfoEl = document.getElementById('membersInfo');
const membersListEl = document.getElementById('membersList');
const joinBtn = document.getElementById('joinBtn');

// گرفتن اطلاعات چت
fetch(`/api/rooms/${encodeURIComponent(chatId)}/info`, {
    headers: {
        Authorization: `Bearer ${token}`
    }
})
.then(async res => {
    if (res.status === 401) {
        location.href = '/auth/login';
        throw new Error('unauthorized');
    }
    if (!res.ok) {
        const text = await res.text();
        console.error('Join chat info error:', res.status, text);
        throw new Error('Chat not found');
    }
    return res.json();
})
.then(data => {
    if (data.is_member) {
        location.href = `/rooms/${chatId}`;
        return;
    }

    headerEl.innerText = data.name;
    membersInfoEl.innerText = `${data.members_count} عضو`;

    membersListEl.innerHTML = data.members
        .map(username => `<div>• ${username}</div>`)
        .join('');
})
.catch(() => {
    headerEl.innerText = 'چت پیدا نشد';
    joinBtn.disabled = true;
});

// join chat
joinBtn.addEventListener('click', async () => {
    joinBtn.disabled = true;
    joinBtn.innerText = 'در حال عضویت...';

    try {
        const res = await fetch(`/rooms/join/${chatId}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (!res.ok) {
            throw new Error();
        }

        location.href = `/rooms/${chatId}`;
    } catch {
        alert('خطا در عضویت در چت');
        joinBtn.disabled = false;
        joinBtn.innerText = 'Join Chat';
    }
});