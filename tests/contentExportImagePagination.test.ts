import { planImageSlices } from '../features/content-export/imagePagination';

test('splits at measured boundaries without losing or repeating vertical content', () => {
  const slices = planImageSlices(1750, [350, 500, 780, 1020, 1300, 1550], 600);
  expect(slices).toEqual([
    { offset: 0, height: 500 },
    { offset: 500, height: 520 },
    { offset: 1020, height: 530 },
    { offset: 1550, height: 200 },
  ]);
  expect(slices.reduce((sum, slice) => sum + slice.height, 0)).toBe(1750);
});

test('refuses an unsplittable tall block instead of cutting its text', () => {
  expect(() => planImageSlices(1500, [], 500)).toThrow('无法安全分图');
  expect(() => planImageSlices(Infinity, [], 500)).toThrow('内容过长');
});

test('fits short content into one image and ignores invalid measurement points', () => {
  expect(planImageSlices(300, [NaN, -10, 900], 500)).toEqual([
    { offset: 0, height: 300 },
  ]);
});
