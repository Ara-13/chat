const form = document.querySelector('.auth-form');

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(form);

    const payload = {
        username: formData.get('username'),
        password: formData.get('password'),
        invitation_code: formData.get('invitation_code')
    };

    try {
        const res = await fetch('/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (!res.ok) {
            alert(data.message || 'Register failed');
            return;
        }

        alert('ثبت‌نام موفق! حالا لاگین کن');
        window.location.href = '/auth/login.html';

    } catch (err) {
        console.error(err);
        alert('Server error');
    }
});