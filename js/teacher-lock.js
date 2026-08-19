const LOCK_KEY = 'cp:teacher-lock-v1';
const SESSION_KEY = 'cp:teacher-unlocked-v1';

async function derive(value, salt) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256',
  }, key, 256);
  return [...new Uint8Array(bits)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function newSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function lockMarkup(isSetup) {
  return `
    <div id="teacherLock" class="lock-screen">
      <form id="teacherLockForm" class="lock-card" role="dialog" aria-modal="true" aria-labelledby="teacherLockTitle">
        <img src="assets/access-shield.svg" alt="" width="150" height="116">
        <p class="eyebrow">教師裝置鎖</p>
        <h1 id="teacherLockTitle">${isSetup ? '先設定 6 位數以上的教師密碼' : '請輸入教師密碼'}</h1>
        <p class="hint">這道鎖用來防止共用平板上的學生順手看到教師資料；它不能取代裝置帳號與螢幕鎖定。</p>
        <label>教師密碼
          <input id="teacherPin" type="password" inputmode="numeric" minlength="6" autocomplete="current-password" required>
        </label>
        ${isSetup ? `<label>再輸入一次<input id="teacherPinAgain" type="password" inputmode="numeric" minlength="6" autocomplete="new-password" required></label>` : ''}
        <p id="teacherLockError" class="lock-error" aria-live="polite"></p>
        <button class="btn btn-primary" type="submit">${isSetup ? '設定並進入' : '解鎖'}</button>
        <p class="lock-note">忘記密碼時只能清除本站瀏覽器資料，班級紀錄也會一起刪除；請先定期下載備份。</p>
      </form>
    </div>`;
}

export async function requireTeacherUnlock() {
  const stored = localStorage.getItem(LOCK_KEY) || '';
  if (stored && sessionStorage.getItem(SESSION_KEY) === stored) return;

  const host = document.createElement('div');
  host.innerHTML = lockMarkup(!stored);
  document.body.prepend(host.firstElementChild);
  const form = document.getElementById('teacherLockForm');
  const pin = document.getElementById('teacherPin');
  const error = document.getElementById('teacherLockError');
  requestAnimationFrame(() => pin.focus());

  await new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pin.value.length < 6) {
        error.textContent = '請輸入至少 6 位數。';
        return;
      }
      if (!stored && pin.value !== document.getElementById('teacherPinAgain').value) {
        error.textContent = '兩次輸入不一致。';
        return;
      }
      const salt = stored.split(':')[0] || newSalt();
      const hashed = await derive(pin.value, salt);
      const credential = `${salt}:${hashed}`;
      if (stored && credential !== stored) {
        error.textContent = '教師密碼不正確。';
        pin.select();
        return;
      }
      if (!stored) localStorage.setItem(LOCK_KEY, credential);
      sessionStorage.setItem(SESSION_KEY, credential);
      document.getElementById('teacherLock').remove();
      resolve();
    });
  });
}

export function lockTeacherView() {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}
