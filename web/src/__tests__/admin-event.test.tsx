import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { adminEvent, me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;
const base = {
  'GET /admin/me': { body: me },
  'GET /admin/requests': { body: { requests: [] } },
  'GET /admin/events': { body: { events: [] } },
};
const item = (id: string, over: Record<string, unknown> = {}) => ({ id, thumb: `/img/${id}/t`, web: `/img/${id}/w`, name: `${id}.jpg`, type: 'photo', status: 'done', face_count: 0, source: 'organiser', uploader_name: null, ...over });

describe('one event', () => {
  it('shows the link and QR, and opens the event to students with one switch', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ status: 'draft', counts: { total: 10, shown: 10 } }) } },
      'PATCH /admin/events/ev1': (c) => ({ body: { event: adminEvent({ status: c.body.status, counts: { total: 10, shown: 10 } }) } }),
      'GET /admin/events/ev1/media': { body: { total: 0, media: [] } },
    });
    const { user } = renderAt('/admin/events/ev1', admin);
    const share = await screen.findByRole('region', { name: 'Share with students' });
    expect(within(share).getByRole('link', { name: 'https://photos.college.edu/e/annual-day' })).toHaveAttribute('href', '/e/annual-day');
    expect(within(share).getByRole('img', { name: 'QR code for https://photos.college.edu/e/annual-day' })).toHaveAttribute('src', '/api/admin/events/ev1/qr');
    const open = within(share).getByRole('switch', { name: /Open to students/ });
    expect(open).not.toBeChecked();

    await user.click(open);
    await waitFor(() => expect(within(share).getByRole('switch', { name: /Open to students/ })).toBeChecked());
    expect(net.called('PATCH /admin/events/ev1')[0].body).toEqual({ status: 'live' });
    expect(within(screen.getByRole('heading', { level: 1, name: 'Annual Day 2026' }).parentElement!).getByText('Open')).toBeInTheDocument();
  });

  it('has three plain tabs and a small one for OneDrive', async () => {
    mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 2, shown: 2 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 2, media: [item('m1', { face_count: 2 }), item('m2', { type: 'video', duration_ms: 42_000 })] } },
    });
    const { user } = renderAt('/admin/events/ev1', admin);
    const tabs = await screen.findByRole('tablist', { name: 'This event' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Add photos & videos', 'Waiting for approval (0)', 'Photos & videos', 'OneDrive & settings']);
    // An event with photos and nothing waiting opens on its photos.
    expect(within(tabs).getByRole('tab', { name: 'Photos & videos' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTitle('m1.jpg')).toBeInTheDocument();
    expect(within(screen.getByTitle('m2.jpg')).getByText('0:42')).toBeInTheDocument();
    await user.click(screen.getByTitle('m2.jpg'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('approves one photo, then all the others', async () => {
    let waiting = [item('s1', { source: 'crowd', uploader_name: 'Asha' }), item('s2', { source: 'crowd', type: 'video', duration_ms: 90_000 }), item('s3', { source: 'crowd' })];
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': () => ({ body: { event: adminEvent({ counts: { total: 12, shown: 9, review: waiting.length } }) } }),
      'GET /admin/events/ev1/media': () => ({ body: { total: waiting.length, media: waiting } }),
      'PATCH /admin/media': (c) => ((waiting = waiting.filter((m) => !c.body.ids.includes(m.id))), { body: { changed: c.body.ids.length } }),
      'POST /admin/events/ev1/approve-all': () => ((waiting = []), { body: { approved: 2 } }),
    });
    const { user } = renderAt('/admin/events/ev1', admin);
    // Something waits: the event opens on that tab.
    expect(await screen.findByRole('tab', { name: 'Waiting for approval (3)' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('by Asha')).toBeInTheDocument();
    expect(screen.getByText('1:30')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve s1.jpg' }));
    await waitFor(() => expect(screen.queryByText('by Asha')).not.toBeInTheDocument());
    expect(net.called('PATCH /admin/media')[0].body).toEqual({ ids: ['s1'], action: 'approve' });
    expect(await screen.findByRole('tab', { name: 'Waiting for approval (2)' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve all (2)' }));
    expect(await screen.findByText('Nothing is waiting')).toBeInTheDocument();
    expect(net.called('POST /admin/events/ev1/approve-all')).toHaveLength(1);
    expect(await screen.findByRole('tab', { name: 'Waiting for approval (0)' })).toBeInTheDocument();
  });

  it('points to the next step from another tab, and the phone button adds to this event', async () => {
    mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 3, shown: 2, review: 1 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 1, media: [item('s1', { source: 'crowd' })] } },
    });
    const { user } = renderAt('/admin/events/ev1?tab=photos', admin);
    expect(within(await screen.findByRole('navigation', { name: 'Admin, phone' })).getByRole('link', { name: 'Add photos and videos to this event' })).toHaveAttribute('href', '/admin/events/ev1?tab=add');
    await user.click(await screen.findByRole('button', { name: /Review them/ }));
    expect(screen.getByRole('tab', { name: 'Waiting for approval (1)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: /Review them/ })).not.toBeInTheDocument();
  });

  it('points an event without photos to adding them, in the words of the tab', async () => {
    mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent() } },
      'GET /admin/events/ev1/media': { body: { total: 0, media: [] } },
    });
    const { user } = renderAt('/admin/events/ev1?tab=photos', admin);
    await user.click(await screen.findByRole('button', { name: 'Add photos & videos' }));
    expect(screen.getByRole('tab', { name: 'Add photos & videos' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Add photos & videos' })).not.toBeInTheDocument();
  });

  it('rejects a photo', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 3, shown: 2, review: 1 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 1, media: [item('s1', { source: 'crowd' })] } },
      'PATCH /admin/media': { body: { changed: 1 } },
    });
    const { user } = renderAt('/admin/events/ev1?tab=waiting', admin);
    await user.click(await screen.findByRole('button', { name: 'Reject s1.jpg' }));
    expect(net.called('PATCH /admin/media')[0].body).toEqual({ ids: ['s1'], action: 'reject' });
  });

  it('pages through every photo, keeps the picks and starts again on another filter', async () => {
    const all = Array.from({ length: 130 }, (_, i) => item(`m${i}`));
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 131, shown: 130, hidden: 1 } }) } },
      'GET /admin/events/ev1/media': (c) => {
        const q = new URLSearchParams(c.path.split('?')[1]);
        if (q.get('filter') === 'hidden') return { body: { total: 1, media: [item('h1', { hidden: true })] } };
        const from = Number(q.get('offset'));
        return { body: { total: all.length, media: all.slice(from, from + Number(q.get('limit'))) } };
      },
    });
    const { user } = renderAt('/admin/events/ev1?tab=photos', admin);
    await user.click(await screen.findByTitle('m0.jpg'));
    expect(screen.getByText('60 of 130')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('120 of 130')).toBeInTheDocument();
    // The chip already picked changes nothing.
    await user.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /In the album/ }));
    expect(screen.getByText('120 of 130')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByTitle('m129.jpg')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    expect(net.called('GET /admin/events/ev1/media?filter=shown&offset=0&limit=60')).toHaveLength(1);
    expect(net.called('GET /admin/events/ev1/media?filter=shown&offset=60&limit=60')).toHaveLength(1);
    expect(net.called('GET /admin/events/ev1/media?filter=shown&offset=120&limit=60')).toHaveLength(1);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /Hidden/ }));
    expect(await screen.findByTitle('h1.jpg')).toBeInTheDocument();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    // Back on the album: from the first page again.
    await user.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /In the album/ }));
    expect(await screen.findByText('60 of 130')).toBeInTheDocument();
    expect(screen.queryByTitle('m60.jpg')).not.toBeInTheDocument();
  });

  it('loads the next 200 waiting for approval', async () => {
    const waiting = Array.from({ length: 250 }, (_, i) => item(`s${i}`, { source: 'crowd' }));
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 250, review: 250 } }) } },
      'GET /admin/events/ev1/media': (c) => {
        const q = new URLSearchParams(c.path.split('?')[1]);
        const from = Number(q.get('offset'));
        return { body: { total: waiting.length, media: waiting.slice(from, from + Number(q.get('limit'))) } };
      },
    });
    const { user } = renderAt('/admin/events/ev1?tab=waiting', admin);
    expect(await screen.findByText('200 of 250')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: 'Approve s249.jpg' })).toBeInTheDocument();
    expect(net.called('GET /admin/events/ev1/media?filter=review&offset=200&limit=200')).toHaveLength(1);
  });

  it('goes back to the automatic cover', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ cover_media_id: 'm1', counts: { total: 1, shown: 1 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 1, media: [item('m1')] } },
      'PATCH /admin/events/ev1': (c) => ({ body: { event: adminEvent({ cover_media_id: c.body.cover_media_id, counts: { total: 1, shown: 1 } }) } }),
    });
    const { user } = renderAt('/admin/events/ev1?tab=photos', admin);
    await user.click(await screen.findByRole('button', { name: /Automatic cover/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Automatic cover/ })).not.toBeInTheDocument());
    expect(net.called('PATCH /admin/events/ev1')[0].body).toEqual({ cover_media_id: null });
  });

  it('shows photos whose copies cannot be made in OneDrive, opened from the alert, and tries them again', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 3, shown: 2, lost: 1 } }) } },
      'GET /admin/events/ev1/media': (c) =>
        c.path.includes('filter=lost')
          ? { body: { total: 1, media: [item('l1', { copies_lost: true, copies_error: 'The original is no longer in OneDrive; the album keeps the copy it has.' })] } }
          : { body: { total: 2, media: [item('m1'), item('m2')] } },
      'PATCH /admin/media': { body: { changed: 1 } },
    });
    const { user } = renderAt('/admin/events/ev1?tab=media&filter=lost', admin);
    const tile = await screen.findByTitle('l1.jpg');
    expect(tile).toHaveTextContent('cannot be shown: The original is no longer in OneDrive');
    expect(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /Cannot be shown/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(tile);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(net.called('PATCH /admin/media')).toHaveLength(1));
    expect(net.called('PATCH /admin/media')[0].body).toEqual({ ids: ['l1'], action: 'rebuild' });
  });

  it('says what deleting an event removes: its copies in OneDrive\'s app folder, never the originals', async () => {
    mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 1, shown: 1 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 0, media: [] } },
      'GET /admin/onedrive/status': { body: { status: { kind: 'local', rootName: 'demo' }, setup: {} } },
    });
    renderAt('/admin/events/ev1?tab=settings', admin);
    expect(await screen.findByText("Removes the event, its copies in OneDrive's app folder and its face data from this app. The originals stay in OneDrive.")).toBeInTheDocument();
  });

  it('lets only a super admin delete the event', async () => {
    const routes = (role: 'super_admin' | 'organiser') => ({
      ...base,
      'GET /admin/me': { body: { ...me, user: { ...me.user, role } } },
      'GET /admin/events/ev1': { body: { event: adminEvent({ counts: { total: 1, shown: 1 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 0, media: [] } },
      'GET /admin/onedrive/status': { body: { status: { kind: 'local', rootName: 'demo' }, setup: {} } },
    });
    mockFetch(routes('organiser'));
    const view = renderAt('/admin/events/ev1?tab=settings', admin);
    expect(await screen.findByText('Only a super admin can delete an event. You can archive it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete the event/ })).not.toBeInTheDocument();
    view.unmount();

    mockFetch(routes('super_admin'));
    renderAt('/admin/events/ev1?tab=settings', admin);
    expect(await screen.findByRole('button', { name: /Delete the event/ })).toBeInTheDocument();
    expect(screen.queryByText(/Only a super admin can delete/)).not.toBeInTheDocument();
  });

  it('adds photos and videos, each with its own progress line', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events/ev1': { body: { event: adminEvent({ status: 'draft' }) } },
      'POST /admin/events/ev1/photos': (c) => ({ status: 201, body: { result: c.headers['x-file-name'] === 'copy.jpg' ? 'skipped' : 'added' } }),
    });
    const { user } = renderAt('/admin/events/ev1', admin);
    expect(await screen.findByRole('tab', { name: 'Add photos & videos' })).toHaveAttribute('aria-selected', 'true');
    const files = [new File(['a'.repeat(900)], 'stage.jpg', { type: 'image/jpeg' }), new File(['b'.repeat(900)], 'copy.jpg', { type: 'image/jpeg' }), new File(['c'.repeat(900)], 'dance.mp4', { type: 'video/mp4' })];
    await user.upload(screen.getByLabelText(/Drop photos and videos here/), files);
    expect(await screen.findByText('2 added, 1 skipped as copies.')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Files being added' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent?.includes('Already there'))).toEqual([false, true, false]);
    const sent = net.called('POST /admin/events/ev1/photos');
    expect(sent.map((c) => c.headers['content-type']).sort()).toEqual(['image/jpeg', 'image/jpeg', 'video/mp4']);
  });
});
