import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [command, argument] = process.argv.slice(2);
const commands = {
  status: () => ['/status'],
  preflight: () => ['/preflight'],
  preview: () => ['/preview'],
  conflicts: () => ['/conflicts'],
  'conflicts-enable': () => ['/conflicts', { enabled: true }],
  'conflicts-pause': () => ['/conflicts', { enabled: false }],
  'booking-menu': () => [argument === 'default' ? '/booking-menu?default=1' : '/booking-menu'],
  invite: () => ['/invites', { key: argument }],
  'test-line': () => ['/line-test', {}],
  enable: () => ['/automation', { enabled: true }],
  pause: () => ['/automation', { enabled: false }],
  close: () => ['/cases/' + encodeURIComponent(argument) + '/close', {}],
  'close-booking': () => ['/bookings/' + encodeURIComponent(argument) + '/close', {}],
  revoke: () => ['/bindings/' + encodeURIComponent(argument) + '/revoke', {}],
};

async function main() {
  if (command === 'generate-admin-token') {
    process.stdout.write(randomBytes(32).toString('base64url') + '\n');
    return;
  }
  if (!Object.hasOwn(commands, command) || (['invite', 'close', 'close-booking', 'revoke'].includes(command) && !argument)) {
    console.log('用法：node scripts/admin.mjs <status|preflight|preview|conflicts|conflicts-enable|conflicts-pause|booking-menu|invite|test-line|enable|pause|close|close-booking|revoke|generate-admin-token> [參數]');
    process.exitCode = 2;
    return;
  }
  const base = new URL(process.env.RMA_URL ?? '');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) {
    throw new Error('RMA_URL 必須使用 HTTPS，或指向本機測試站。');
  }
  const token = process.env.RMA_ADMIN_TOKEN;
  if (!token || token.length < 32) throw new Error('請由安全的環境變數設定 RMA_ADMIN_TOKEN。');
  const [path, data] = commands[command]();
  const image = command === 'booking-menu' ? await readFile(new URL('../assets/booking-menu.png', import.meta.url)) : null;
  const response = await fetch(new URL('/admin' + path, base), {
    method: image || data ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(90_000),
    headers: { authorization: 'Bearer ' + token, 'content-type': image ? 'image/png' : 'application/json' },
    body: image ?? (data ? JSON.stringify(data) : undefined),
  });
  const result = await response.json();
  if (command === 'invite' && response.ok) {
    console.log('請私下交付給對應成員，並請他在官方帳號私訊中輸入下列指令：');
    console.log('綁定 ' + result.code);
    console.log('有效期限 ' + new Intl.DateTimeFormat('zh-TW', {
      dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Taipei',
    }).format(result.deadline));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!response.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
