import type { RecentMomentItem } from '../api/zhihu/moments';
import { createRecentMomentStream } from '../utils/recentMomentStream';

function moment(id: string, urlToken = id): RecentMomentItem {
  return {
    actor: { id, url_token: urlToken, name: id, avatar_url: '' },
    brief: `synthetic-${id}`,
    unread_count: 2,
  };
}

test('preserves strip order, deduplicates actors and resolves an ID to its token', () => {
  const moments = [
    moment('first'),
    moment('selected', 'selected-token'),
    moment('first'),
    moment('last', ''),
  ];
  const stream = createRecentMomentStream('selected', '4', moments);
  expect(stream.initialPage).toBe(1);
  expect(
    stream.entries.map(({ id, unreadCount }) => ({ id, unreadCount })),
  ).toEqual([
    { id: 'first', unreadCount: 2 },
    { id: 'selected-token', unreadCount: 4 },
    { id: 'last', unreadCount: 2 },
  ]);
  expect(moments[1].unread_count).toBe(2);
});

test('keeps an absent selected user available ahead of the remaining strip', () => {
  const stream = createRecentMomentStream('selected', '3', [moment('other')]);
  expect(stream.initialPage).toBe(0);
  expect(stream.entries[0]).toEqual({ id: 'selected', unreadCount: 3 });
  expect(stream.entries[1].id).toBe('other');
});

test.each([
  undefined,
  '-1',
  'NaN',
  '3invalid',
  '1.5',
])('invalid entry unread count %s does not create a false read boundary', (value) => {
  const stream = createRecentMomentStream('selected', value);
  expect(stream.entries).toEqual([{ id: 'selected', unreadCount: 0 }]);
});
