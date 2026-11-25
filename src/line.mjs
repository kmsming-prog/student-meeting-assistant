import { TEACHER } from './config.mjs';
import { dateLabel, intervalLabel, label, localTime } from './time.mjs';

const origin = 'https://api.line.me/v2/bot';
const mediaOrigin = 'https://api-data.line.me/v2/bot';
const userPattern = /^U[0-9a-f]{32}$/;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const selectionPattern = new RegExp('^rma:(choice|confirm):(' + uuid + '):([0-2])$');
const bookingPattern = new RegExp('^rma:(book-choice|book-confirm|book-name|book-page|book-more):(' + uuid + '):(0|[1-9][0-9]?)$');
const declinePattern = new RegExp('^rma:(decline|book-decline):(' + uuid + ')$');
const testPattern = new RegExp('^rma:test:(' + uuid + ')$');
const rebookPattern = new RegExp('^rma:rebook:(' + uuid + ')$');

export function textMessage(text) {
  return { type: 'text', text };
}

function buttons(text, actions) {
  return {
    type: 'template', altText: text,
    template: { type: 'buttons', text, actions },
  };
}

function button(label, data) {
  return { type: 'postback', label, data };
}

export const registrationButton = button('學生身分登記', 'rma:register');
export const bookingButton = button('預約晤談', 'rma:book');
export const noSuitableTimeReply = '已記錄你的需求，會通知老師協助安排。如果不急，也可以下週再預約。';
const BOOKING_TEMPLATE_SLOT_LIMIT = 3;
const BOOKING_PAGE_SIZE = 6;

function timeButtons(id, type, options, offset = 0) {
  return options.map((slot, index) => button(label(slot.start), 'rma:' + type + ':' + id + ':' + (offset + index)));
}

export function proposalMessage(item) {
  const text = '固定學生晤談與其他行程有衝突。原定 ' + intervalLabel(item.original_start, item.original_end) +
    '。請於 ' + label(item.deadline) + ' 前另選時段（台灣時間）。';
  return buttons(text, [
    ...timeButtons(item.id, 'choice', JSON.parse(item.options)),
    button('以上時間都不行', 'rma:decline:' + item.id),
  ]);
}

function bookingSlotTile(slot, action) {
  return {
    type: 'box', layout: 'vertical', paddingAll: '8px', cornerRadius: '8px', backgroundColor: '#EDF6F1', action,
    contents: [
      { type: 'text', text: dateLabel(slot.start), align: 'center', size: 'xs', color: '#38564D' },
      {
        type: 'text', text: localTime(slot.start) + '–' + localTime(slot.end),
        align: 'center', size: 'sm', weight: 'bold', color: '#173B35',
      },
    ],
  };
}

function bookingSlotsCard(id, options, offset, decline) {
  const visible = options.slice(offset, offset + BOOKING_PAGE_SIZE);
  const actions = timeButtons(id, 'book-choice', visible, offset);
  const rows = [];
  for (let index = 0; index < visible.length; index += 2) {
    rows.push({
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: visible.slice(index, index + 2).map((slot, column) => bookingSlotTile(slot, actions[index + column])),
    });
  }
  const end = offset + visible.length;
  const positions = visible.length === 1 ? String(end) : (offset + 1) + '–' + end;
  const count = '第 ' + positions + ' 個，共 ' + options.length + ' 個時段';
  const footer = [];
  if (end < options.length) {
    footer.push({
      type: 'button', height: 'sm', style: 'primary', color: '#286454',
      action: button('查看更多時段', 'rma:book-more:' + id + ':' + end),
    });
  }
  footer.push({ type: 'button', height: 'sm', style: 'secondary', action: decline });
  return {
    type: 'flex', altText: '選擇預約時段，' + count,
    contents: {
      type: 'bubble', size: 'mega',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
        contents: [
          { type: 'text', text: '選擇預約時段', size: 'lg', weight: 'bold', color: '#173B35' },
          { type: 'text', text: count, size: 'sm', color: '#38564D' },
          { type: 'text', text: '明天起 7 天內，時間為台灣時間', size: 'xs', color: '#38564D' },
          ...rows,
        ],
      },
      footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: footer },
    },
  };
}

export function bookingMessage(item, offset = 0) {
  const options = JSON.parse(item.options);
  if (offset > 0 && offset >= options.length) return null;
  const decline = button('以上時間都不行', 'rma:book-decline:' + item.id);
  if (!item.reschedule_id && options.length > BOOKING_TEMPLATE_SLOT_LIMIT) {
    return bookingSlotsCard(item.id, options, offset, decline);
  }
  const action = item.reschedule_id ? '確認改期' : '確認預約';
  const text = options.length
    ? '可選明天起 7 天內的 30 分鐘時段（台灣時間）。選好後請點「' + action + '」。'
    : '明天起 7 天內暫無可用時段。可點下方按鈕請老師協助。';
  const times = timeButtons(item.id, 'book-choice', options.slice(0, BOOKING_TEMPLATE_SLOT_LIMIT));
  return buttons(text, [...times, decline]);
}

export function confirmationMessage(item, index, booking, bookingName) {
  const { start, end } = JSON.parse(item.options)[index];
  const newBooking = booking && !item.reschedule_id;
  const text = '請確認' + (newBooking ? '預約' : '改期') + '至 ' + intervalLabel(start, end) + '（台灣時間）。地點為老師辦公室。';
  const actions = [
    button(newBooking ? '確認預約' : '確認改期', 'rma:' + (booking ? 'book-confirm' : 'confirm') + ':' + item.id + ':' + index),
  ];
  if (newBooking && item.participant_key === TEACHER) {
    actions.push({
      ...button('名稱選填', 'rma:book-name:' + item.id + ':' + index),
      inputOption: 'openKeyboard',
      fillInText: '預約名稱 ',
    });
  }
  actions.push(button('以上時間都不行', 'rma:' + (booking ? 'book-decline' : 'decline') + ':' + item.id));
  return buttons(newBooking ? text + '\n預約名稱 ' + bookingName : text, actions);
}

export function conflictMessage(item) {
  const when = intervalLabel(item.original_start, item.original_end) + '（台灣時間）';
  const text = '原訂 ' + when + ' 的學生晤談有時段衝突，已標記待改期。';
  return item.state === 'pending'
    ? buttons(text + '請點「重新預約」選擇新時段。', [button('重新預約', 'rma:rebook:' + item.id)])
    : textMessage(text + '已通知老師協助，請等候確認。');
}

export function bookingEntryMessage(text, offerRegistration = false) {
  const actions = [bookingButton];
  if (offerRegistration) actions.push(registrationButton);
  return buttons(text, actions);
}

export function registrationNameMessage(instructions = '第一次預約請先登記完整姓名。') {
  return {
    ...textMessage(instructions + '請點「填寫姓名」，或直接傳送「學生姓名 王小明」，並換成你的姓名。之後的預約會自動使用這個姓名。'),
    quickReply: {
      items: [{
        type: 'action',
        action: {
          ...button('填寫姓名', 'rma:registration-name'),
          inputOption: 'openKeyboard',
          fillInText: '學生姓名 ',
        },
      }],
    },
  };
}

export function lineTestMessage(id) {
  const text = '這是學生晤談助理的連線測試。請點選按鈕確認收到訊息。';
  return buttons(text, [{ type: 'postback', label: '確認收到', data: 'rma:test:' + id }]);
}

export function lineAction(event) {
  const userId = event.source?.userId;
  const id = event.webhookEventId;
  if (event.source?.type !== 'user' || !userPattern.test(userId ?? '') ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(id ?? '') || event.mode === 'standby' ||
      !Number.isSafeInteger(event.timestamp)) return null;
  const base = { id, userId, timestamp: event.timestamp, replyToken: event.replyToken };
  if (event.type === 'follow' || event.type === 'unfollow') return { ...base, type: event.type };
  if (event.type === 'postback') {
    const data = event.postback?.data ?? '';
    if (data === bookingButton.data) return { ...base, type: 'book' };
    if (data === 'rma:register') return { ...base, type: 'register' };
    const rebook = rebookPattern.exec(data);
    if (rebook) return { ...base, type: 'rebook', conflictId: rebook[1] };
    const choice = selectionPattern.exec(data) ?? bookingPattern.exec(data);
    if (choice) {
      const [, type, caseId, value] = choice;
      const index = Number(value);
      if (type === 'book-page') return { ...base, type: 'book-more', caseId, offset: index * BOOKING_TEMPLATE_SLOT_LIMIT };
      if (type === 'book-more') return { ...base, type, caseId, offset: index };
      return { ...base, type, caseId, index };
    }
    const decline = declinePattern.exec(data);
    if (decline) return { ...base, type: decline[1], caseId: decline[2] };
    const test = testPattern.exec(data);
    if (test) return { ...base, type: 'test', testId: test[1] };
  }
  if (event.type === 'message' && event.message?.type === 'text') {
    const text = typeof event.message.text === 'string' ? event.message.text.trim() : '';
    const binding = /^(?:綁定\s*|bind\s+)([A-Za-z0-9_-]{22})$/i.exec(text);
    if (binding) return { ...base, type: 'bind', code: binding[1] };
    if (text === '狀態') return { ...base, type: 'status' };
    if (text === '待改期') return { ...base, type: 'conflict-status' };
    if (text === '學生身分登記') return { ...base, type: 'register' };
    if (text === '學生姓名') return { ...base, type: 'registration-prompt' };
    const student = /^學生姓名\s*([^\r\n]+)$/.exec(text);
    if (student) return { ...base, type: 'registration-submit', name: student[1] };
    if (text === bookingButton.label || text === '預約會議' || text === '預約') return { ...base, type: 'book' };
    const name = /^預約名稱(?:\s+([\s\S]*))?$/.exec(text);
    if (name) return { ...base, type: 'book-name-text', name: name[1] ?? '' };
  }
  return null;
}

export class LineError extends Error {
  constructor(operation, status = 0) {
    super('line_' + operation + '_' + status);
    this.status = status;
    this.transient = status === 0 || status === 429 || status >= 500;
  }
}

export class LineClient {
  constructor(env, fetcher = fetch) {
    this.token = env.LINE_CHANNEL_ACCESS_TOKEN;
    this.fetcher = fetcher;
  }

  async call(path, {
    body, retryKey, media = false, method = body ? 'POST' : 'GET', operation = path.split('/').at(-1),
  } = {}) {
    if (!this.token) throw new Error('missing_line_access_token');
    const headers = { authorization: 'Bearer ' + this.token };
    if (body) headers['content-type'] = media ? 'image/png' : 'application/json';
    if (retryKey) headers['x-line-retry-key'] = retryKey;
    const fetcher = this.fetcher;
    try {
      const response = await fetcher((media ? mediaOrigin : origin) + path, {
        method, headers, body: media ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(6_000), redirect: 'manual',
      });
      if (retryKey && response.status === 409 && response.headers.has('x-line-accepted-request-id')) return {};
      if (!response.ok) throw new LineError(operation, response.status);
      if (media && method === 'GET') {
        await response.body?.cancel();
        return {};
      }
      const content = await response.text();
      return content ? JSON.parse(content) : {};
    } catch (error) {
      if (error instanceof LineError) throw error;
      throw new LineError(operation);
    }
  }

  push(to, message, retryKey) {
    return this.call('/message/push', { body: { to, messages: [message] }, retryKey });
  }

  reply(replyToken, message) {
    return this.call('/message/reply', { body: { replyToken, messages: [typeof message === 'string' ? textMessage(message) : message] } });
  }

  info() {
    return this.call('/info');
  }

  async profile(userId) {
    try {
      const profile = await this.call('/profile/' + userId, { operation: 'profile' });
      return profile.userId === userId ? { displayName: profile.displayName } : null;
    } catch (error) {
      if (!(error instanceof LineError) || error.status !== 404) throw error;
      return null;
    }
  }

  listMenus() {
    return this.call('/richmenu/list');
  }

  createMenu(menu) {
    return this.call('/richmenu', { body: menu });
  }

  putMenuImage(id, image) {
    return this.call('/richmenu/' + id + '/content', { body: image, media: true });
  }

  linkMenu(userId, menuId) {
    return this.call('/user/' + userId + '/richmenu/' + menuId, { method: 'POST', operation: 'menu_link' });
  }

  async defaultMenu() {
    try {
      return (await this.call('/user/all/richmenu')).richMenuId ?? null;
    } catch (error) {
      if (!(error instanceof LineError) || error.status !== 404) throw error;
      return null;
    }
  }

  setDefaultMenu(menuId) {
    return this.call('/user/all/richmenu/' + menuId, { method: 'POST', operation: 'default_menu' });
  }

  async menuForUser(userId) {
    try {
      return (await this.call('/user/' + userId + '/richmenu')).richMenuId;
    } catch (error) {
      if (!(error instanceof LineError) || error.status !== 404) throw error;
    }
    return null;
  }

  async hasMenuImage(id) {
    try {
      await this.call('/richmenu/' + id + '/content', { media: true });
      return true;
    } catch (error) {
      if (!(error instanceof LineError) || error.status !== 404) throw error;
      return false;
    }
  }
}
