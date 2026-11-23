import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateVisitInput, validateId, validateImage, assertSameOrigin,
  authorizePhotoReferences, ValidationError, MAX_IMAGE_BYTES,
} from '../lib/validation.ts';

const visit = (patch = {}) => ({
  id: 'visit-1', region: { id: 'CHN-110000', name: '北京', countryCode: 'CHN',
    countryName: '中国', level: 'local', center: [116.4, 39.9], bbox: [115, 39, 118, 41] },
  status: 'visited', visitedOn: '2018年夏天', title: '第一次旅行', notes: '', tripName: '', photos: [],
  ...patch,
});

test('accepts approximate dates and returns only supported visit fields', () => {
  const result = validateVisitInput(visit({ ownerId: 'someone-else' }));
  assert.equal(result.visitedOn, '2018年夏天');
  assert.equal(result.ownerId, undefined);
  assert.equal(result.region.center[0], 116.4);
});

test('rejects invalid coordinates, bounds, statuses and excessive free text', () => {
  for (const patch of [
    { region: { ...visit().region, center: [Infinity, 40] } },
    { region: { ...visit().region, center: [116, -91] } },
    { region: { ...visit().region, bbox: [115, 41, 118, 39] } },
    { status: 'admin' }, { notes: 'a'.repeat(10001) }, { visitedOn: 'a'.repeat(81) },
    { photos: Array.from({ length: 7 }, (_, i) => ({ id: `photo-${i}` })) },
  ]) assert.throws(() => validateVisitInput(visit(patch)), ValidationError);
});

test('rejects path injection and malformed IDs while accepting stable geographic IDs', () => {
  for (const id of ['../secret', '', 'a/b', '<script>', 'a'.repeat(121)]) {
    assert.throws(() => validateId(id), ValidationError);
  }
  assert.equal(validateId('CHN:110000_v2.1'), 'CHN:110000_v2.1');
});

test('derives photo URLs and names from owner-authorized metadata', () => {
  const photos = authorizePhotoReferences('owner-a', [{ id: 'photo-1', url: 'https://attacker.test', filename: 'spoof.html' }],
    [{ id: 'photo-1', ownerId: 'owner-a', filename: '旅行.jpg' }]);
  assert.deepEqual(photos, [{ id: 'photo-1', url: '/api/photos/photo-1', filename: '旅行.jpg' }]);
});

test('rejects another owner’s or missing photo even with a plausible URL', () => {
  assert.throws(() => authorizePhotoReferences('owner-a', [{ id: 'photo-1' }],
    [{ id: 'photo-1', ownerId: 'owner-b', filename: 'private.jpg' }]), ValidationError);
  assert.throws(() => authorizePhotoReferences('owner-a', [{ id: 'missing' }], []), ValidationError);
});

test('rejects duplicate photo references', () => {
  assert.throws(() => validateVisitInput(visit({ photos: [{ id: 'photo-1' }, { id: 'photo-1' }] })), ValidationError);
});

test('checks actual image signatures, not browser-provided MIME or extension', () => {
  const jpg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 0]);
  assert.equal(validateImage(jpg, 'image/jpeg').contentType, 'image/jpeg');
  assert.throws(() => validateImage(jpg, 'image/png'), ValidationError);
  assert.throws(() => validateImage(new TextEncoder().encode('<svg onload="alert(1)"></svg>'), 'image/jpeg'), ValidationError);
  assert.throws(() => validateImage(new Uint8Array(MAX_IMAGE_BYTES + 1), 'image/jpeg'), ValidationError);
});

test('accepts PNG and WebP signatures and rejects mislabeled formats', () => {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.set(new TextEncoder().encode('IHDR'), 12);
  assert.equal(validateImage(png, 'image/png').contentType, 'image/png');
  const webp = new Uint8Array(20);
  webp.set(new TextEncoder().encode('RIFF'), 0);
  webp.set(new TextEncoder().encode('WEBPVP8L'), 8);
  assert.equal(validateImage(webp, 'image/webp').contentType, 'image/webp');
  assert.throws(() => validateImage(png, 'image/svg+xml'), ValidationError);
  assert.throws(() => validateImage(new Uint8Array(), 'image/jpeg'), ValidationError);
});

test('same-origin mutation accepts local requests and rejects foreign/null origins', () => {
  assert.doesNotThrow(() => assertSameOrigin(new Request('https://earth.test/api/visits', { headers: { origin: 'https://earth.test' } })));
  assert.doesNotThrow(() => assertSameOrigin(new Request('https://earth.test/api/visits')));
  assert.throws(() => assertSameOrigin(new Request('https://earth.test/api/visits', { headers: { origin: 'https://evil.test' } })), ValidationError);
  assert.throws(() => assertSameOrigin(new Request('https://earth.test/api/visits', { headers: { origin: 'null' } })), ValidationError);
});
