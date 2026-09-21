const form = document.querySelector('.auth-form');

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    const username = formData.get('username');
    const password = formData.get('password');

    try {
        const res = await fetch('/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (!res.ok) {
            alert(data.message || 'Login failed');
            return;
        }

        // ذخیره token
        localStorage.setItem('token', data.token);
        localStorage.setItem('username', data.username);

        // انتقال به پنل چت‌های کاربر
        window.location.href = '/';

    } catch (err) {
        console.error(err);
        alert('Server error');
    }
});
