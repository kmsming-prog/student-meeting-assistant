import { bookingButton, registrationButton } from './line.mjs';

const width = 1200;
const height = 405;
const version = '3';
const menuIdPattern = /^richmenu-[a-f0-9]{32}$/;
const menu = {
  size: { width, height },
  selected: true,
  name: '學生晤談助理 v3',
  chatBarText: '學生晤談',
  areas: [
    { bounds: { x: 0, y: 0, width: width / 2, height }, action: bookingButton },
    { bounds: { x: width / 2, y: 0, width: width / 2, height }, action: registrationButton },
  ],
};

export function isMenuImage(bytes) {
  if (bytes.length < 33) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452 && view.getUint32(16) === width && view.getUint32(20) === height;
}

export async function linkBookingMenu(store, line, userId, knownId) {
  const id = knownId ?? await store.settingValue('booking_menu');
  if (!id || !(await store.participantByLine(userId))?.active) return 'inactive';
  const previous = await store.settingValue('booking_menu_previous');
  return updateUserMenu(line, userId, id, previous, true);
}

async function updateUserMenu(line, userId, id, previous, attach) {
  const current = await line.menuForUser(userId);
  if (current === id) return 'already_linked';
  if (current && current !== previous) return 'existing_menu';
  if (!current && !attach) return 'uses_default';
  await line.linkMenu(userId, id);
  return await line.menuForUser(userId) === id ? (current ? 'upgraded' : 'linked') : 'unverified';
}

export async function bookingFriendProfile(store, line, userId) {
  const profile = await line.profile(userId);
  if (!profile) return null;
  if (await line.menuForUser(userId)) return profile;

  const id = await store.settingValue('booking_menu');
  if (!id) throw new Error('booking_menu_not_configured');
  // LINE may accept a per-user link request for a non-friend without linking it.
  await line.linkMenu(userId, id);
  return await line.menuForUser(userId) === id ? profile : null;
}

export async function publishBookingMenu(store, line) {
  const id = await store.settingValue('booking_menu');
  if (!id) throw new Error('booking_menu_not_configured');
  const current = await line.defaultMenu();
  if (current === id) return 'already_default';
  if (current && current !== await store.settingValue('booking_menu_previous')) return 'existing_default';
  await line.setDefaultMenu(id);
  return await line.defaultMenu() === id ? 'published' : 'unverified';
}

export async function installBookingMenu(store, line, png) {
  const configured = await store.settingValue('booking_menu');
  let id = configured;
  let previous = await store.settingValue('booking_menu_previous');
  if (!id || await store.settingValue('booking_menu_version') !== version) {
    const list = await line.listMenus();
    const existing = list.richmenus?.find(entry => entry.name === menu.name &&
      entry.size?.width === width && entry.size?.height === height &&
      entry.areas?.[0]?.action?.data === 'rma:book' && entry.areas?.[1]?.action?.data === 'rma:register');
    id = existing?.richMenuId ?? (await line.createMenu(menu)).richMenuId;
    if (!menuIdPattern.test(id ?? '')) throw new Error('invalid_menu_id');
    if (!existing || !await line.hasMenuImage(id)) await line.putMenuImage(id, png);
    if (configured && configured !== id) previous = configured;
    await store.db.batch([
      store.setting('booking_menu', id),
      store.setting('booking_menu_version', version),
      ...(previous ? [store.setting('booking_menu_previous', previous)] : []),
    ]);
  }
  const { results } = await store.q(`SELECT key,line_user_id,booking_user_id FROM participants WHERE active=1
    AND (line_user_id IS NOT NULL OR booking_user_id IS NOT NULL) ORDER BY line_user_id IS NULL,key`).all();
  const users = new Map();
  for (const participant of results) {
    const userId = participant.line_user_id ?? participant.booking_user_id;
    if (!users.has(userId)) users.set(userId, participant);
  }
  const participants = [...users.values()];
  const linked = await Promise.allSettled(participants.map(({ line_user_id: bound, booking_user_id: guest }) =>
    updateUserMenu(line, bound ?? guest, id, previous, Boolean(bound))));
  return linked.map((result, index) => ({
    key: participants[index].key,
    state: result.status === 'fulfilled' ? result.value : 'link_failed',
  }));
}
