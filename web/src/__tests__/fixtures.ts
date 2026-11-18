export const me = {
  user: { id: 'u1', email: 'admin@college.edu', role: 'super_admin' as const },
  org: "St. Mary's",
  public_url: 'https://photos.college.edu',
  drive: 'local' as const,
  face_service: true,
  contact: null,
};

export const campuses = [
  { id: 'c1', name: 'Hyderabad', slug: 'hyderabad' },
  { id: 'c2', name: 'Chebrolu', slug: 'chebrolu' },
  { id: 'c3', name: 'Budampadu', slug: 'budampadu' },
];

const counts = { total: 0, waiting: 0, processing: 0, failed: 0, skipped: 0, copies: 0, shown: 0, review: 0, hidden: 0, faces: 0, no_faces: 0 };

export function adminEvent(over: Record<string, unknown> = {}) {
  return {
    id: 'ev1',
    slug: 'annual-day',
    title: 'Annual Day 2026',
    starts_on: '2026-11-20',
    ends_on: null,
    venue: 'Main hall',
    campus: campuses[0],
    status: 'live',
    has_passcode: false,
    allow_download: true,
    face_enabled: true,
    listed: true,
    crowd_uploads: true,
    auto_approve: false,
    folder: { id: 'f1', name: '2026-11-20 Annual Day' },
    last_sync_at: null,
    sync_error: null,
    syncing: false,
    cover_media_id: null,
    link: 'https://photos.college.edu/e/annual-day',
    ...over,
    counts: { ...counts, ...((over.counts as object) ?? {}) },
  };
}

export function studentEvent(over: Record<string, unknown> = {}) {
  return {
    slug: 'annual-day',
    title: 'Annual Day 2026',
    starts_on: '2026-11-20',
    ends_on: null,
    venue: 'Main hall',
    campus: campuses[0],
    state: 'live',
    cover: null,
    strip: ['/img/a/t', '/img/b/t'],
    photos: 240,
    mine: 0,
    options: { find: true, album: true, album_locked: false, upload: true, download: true },
    ...over,
  };
}

/** A photo or a video the way the public endpoints send them. */
export function media(id: string, over: Record<string, unknown> = {}) {
  return { id, thumb: `/img/${id}/t`, web: `/img/${id}/w`, width: 3, height: 2, taken_at: null, by: null, type: 'photo', duration_ms: null, video: null, ...over };
}
export const video = (id: string, ms = 65_000) => media(id, { type: 'video', duration_ms: ms, video: `/img/${id}/v` });

export function person(over: Record<string, unknown> = {}) {
  return { id: 'p1', name: 'Dr. K. Rao', role: 'Chairman', campus: campuses[0], photo: '/api/admin/people/refs/r1.jpg', refs: 1, counts: { solo: 2, duo: 1, group: 5 }, folder: 'People › Dr. K. Rao (Chairman)', ...over };
}
