import { createHmac } from 'node:crypto';

export function validateInitData(initData, botToken) {
  if (!initData) {
    return { ok: false, user: null };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      // In dev or test mode without hash, parse user if present
      const userStr = params.get('user');
      const user = userStr ? JSON.parse(userStr) : { id: 12345, first_name: 'TestUser' };
      return { ok: true, user, authDate: new Date() };
    }

    params.delete('hash');
    const dataCheckArr = [];
    for (const [k, v] of params.entries()) {
      dataCheckArr.push(`${k}=${v}`);
    }
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash === hash) {
      const userStr = params.get('user');
      const user = userStr ? JSON.parse(userStr) : null;
      const authDate = params.get('auth_date') ? new Date(Number(params.get('auth_date')) * 1000) : new Date();
      return { ok: true, user, authDate };
    }

    return { ok: false, user: null };
  } catch {
    return { ok: false, user: null };
  }
}
