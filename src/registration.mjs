import { TEACHER } from './config.mjs';
import { bookingEntryMessage, registrationNameMessage } from './line.mjs';
import { bookingFriendProfile } from './menu.mjs';

const unavailable = '這個姓名已有身分登記。如需更換 LINE 帳號，請聯絡老師。';

function normalize(name) {
  return typeof name === 'string' ? name.normalize('NFC').trim() : '';
}

export class RegistrationFlow {
  constructor({ students, store, line }) {
    this.students = students;
    this.store = store;
    this.line = line;
  }

  registeredMessage(key, bookingName) {
    const name = key === TEACHER ? '老師' : this.students.find(student => student.key === key)?.name ?? bookingName;
    return name ? '你已經用「' + name + '」身分登記。' : '你的 LINE 已完成學生晤談助理的身分登記。';
  }

  async handle(action, now) {
    const { store } = this;
    const respond = async reply => (await store.selections(action, now)).fresh ? { reply } : {};
    const participant = await store.participantByLine(action.userId);
    if (participant) return respond(this.registeredMessage(participant.key));
    const registeredName = await store.bookingNameByLine(action.userId);
    if (registeredName) return respond(bookingEntryMessage(this.registeredMessage(null, registeredName)));
    if (action.type === 'registration-prompt') return respond(registrationNameMessage());

    let profile;
    try {
      profile = await bookingFriendProfile(store, this.line, action.userId);
    } catch {
      return respond('目前無法確認 LINE 好友狀態。請稍後再試。');
    }
    if (!profile) return respond('請先將本官方帳號加入好友，再點「學生身分登記」。');

    const fromNickname = action.type === 'register';
    const name = normalize(fromNickname ? profile.displayName : action.name);
    const matches = this.students.filter(student => normalize(student.name) === name);
    if (fromNickname && matches.length !== 1) return respond(registrationNameMessage());
    if (!name || [...name].length > 30 || /[\p{Cc}\p{Cf}]/u.test(name)) {
      return respond(registrationNameMessage('請輸入 30 字以內的完整姓名。'));
    }
    const student = matches.length === 1 ? matches[0] : null;
    const { fresh, selected } = await store.selections({
      ...action, type: 'registration-bind', studentKey: student?.key,
      identitySource: fromNickname ? 'nickname' : 'name', bookingName: fromNickname ? null : name,
    }, now);
    if (!fresh) return {};
    if (selected) return { reply: student.name + '，學生身分登記完成。固定晤談的改期通知會送到這裡。' };
    const current = await store.participantByLine(action.userId);
    if (current) return { reply: this.registeredMessage(current.key) };
    const saved = await store.bookingNameByLine(action.userId);
    return { reply: saved ? bookingEntryMessage('已登記姓名「' + saved + '」。請點「預約晤談」選擇時間。') : unavailable };
  }
}
