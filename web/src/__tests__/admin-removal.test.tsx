import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { adminEvent, me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;

const photo = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'photo', thumb: `/api/img/${id}/t?a=1`, web: `/api/img/${id}/w?a=1`, video: null, hidden: false, ...over });
const removal = (over: Record<string, unknown> = {}) => ({
  id: 'q2',
  kind: 'removal',
  reason: 'Please take me out of these.',
  status: 'open',
  created_at: '2026-11-17T09:30:00Z',
  resolved_at: null,
  media_id: null,
  event_id: 'ev1',
  event_title: 'Annual Day 2026',
  thumb: null,
  web: null,
  video: null,
  count: 3,
  photos: [photo('m1'), photo('m2'), photo('m3', { type: 'video', video: '/api/img/m3/v?a=1' })],
  ...over,
});
const report = {
  id: 'q1',
  kind: 'report',
  reason: 'I do not like this one.',
  status: 'open',
  created_at: '2026-11-16T09:30:00Z',
  media_id: 'm9',
  event_id: 'ev1',
  event_title: 'Annual Day 2026',
  thumb: '/api/img/m9/t?a=1',
  web: '/api/img/m9/w?a=1',
  count: 1,
  photos: [photo('m9')],
};

const routes = (requests: () => unknown[]) => ({
  'GET /admin/me': { body: me },
  'GET /admin/alerts': { body: { alerts: [] } },
  'GET /admin/campuses': { body: { campuses: [] } },
  'GET /admin/events': { body: { events: [adminEvent({ counts: { shown: 40 } })] } },
  'GET /admin/requests': () => ({ body: { requests: requests() } }),
});

describe('Remove me requests', () => {
  it('shows the photos and takes them out of the album in one tap', async () => {
    let open = [removal(), report];
    const net = mockFetch({
      ...routes(() => open),
      'PATCH /admin/requests/q2': (c) => ((open = open.filter((q) => q.id !== 'q2')), { body: { ok: true, hidden: c.body.status === 'approved' ? 3 : 0 } }),
    });
    const { user } = renderAt('/admin/requests', admin);
    expect(await screen.findByText('Photos that students reported, and students who asked to be removed. Hiding takes the photos out of the album and out of everyone\'s results at once.')).toBeInTheDocument();
    const item = await screen.findByRole('group', { name: 'Remove me, Annual Day 2026' });
    expect(within(item).getByText('Remove me · 3 photos')).toBeInTheDocument();
    expect(within(item).getByText('A student asked to be removed from these photos.')).toBeInTheDocument();
    expect(within(item).getByText('Please take me out of these.')).toBeInTheDocument();
    const strip = within(item).getByRole('list', { name: 'The photos' });
    const links = within(strip).getAllByRole('link');
    expect(links).toHaveLength(3);
    // opened in a new tab through the app (pipe=1): a top-level visit to OneDrive's own link may download instead of show
    expect(links[0]).toHaveAttribute('href', '/api/img/m1/w?a=1&pipe=1');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(within(strip).getByRole('link', { name: 'Open video 3' })).toBeInTheDocument();

    // The report stays as it was.
    expect(screen.getByText('Reported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide photo/ })).toBeInTheDocument();

    await user.click(within(item).getByRole('button', { name: /Remove from album/ }));
    await waitFor(() => expect(net.called('PATCH /admin/requests/q2')).toHaveLength(1));
    expect(net.called('PATCH /admin/requests/q2')[0].body).toEqual({ status: 'approved' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Remove me, Annual Day 2026' })).not.toBeInTheDocument());
  });

  it('keeps the photos, says one photo, and No note when there is none', async () => {
    const net = mockFetch({
      ...routes(() => [removal({ count: 1, reason: null, photos: [photo('m1')] })]),
      'PATCH /admin/requests/q2': { body: { ok: true, hidden: 0 } },
    });
    const { user } = renderAt('/admin/requests', admin);
    const item = await screen.findByRole('group', { name: 'Remove me, Annual Day 2026' });
    expect(within(item).getByText('Remove me · 1 photo')).toBeInTheDocument();
    expect(within(item).getByText('No note.')).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Keep photos' }));
    await waitFor(() => expect(net.called('PATCH /admin/requests/q2')).toHaveLength(1));
    expect(net.called('PATCH /admin/requests/q2')[0].body).toEqual({ status: 'declined' });
  });

  it("shows the server's answer when it cannot be done", async () => {
    mockFetch({
      ...routes(() => [removal()]),
      'PATCH /admin/requests/q2': { status: 404, body: { error: 'not_found', message: 'Request not found.' } },
    });
    const { user } = renderAt('/admin/requests', admin);
    const item = await screen.findByRole('group', { name: 'Remove me, Annual Day 2026' });
    await user.click(within(item).getByRole('button', { name: /Remove from album/ }));
    expect(await screen.findByText('Request not found.')).toBeInTheDocument();
  });

  it('says which photos are already hidden, and sends an answer once while the list is read again', async () => {
    let open = [removal({ photos: [photo('m1', { hidden: true }), photo('m2')], count: 2 })];
    let release: () => void = () => {};
    const net = mockFetch({
      ...routes(() => open),
      'PATCH /admin/requests/q2': () => ((open = []), { body: { ok: true, hidden: 1 } }),
    });
    // Hold the list's read after the answer, so the buttons are still there while it is on its way.
    const gate = new Promise<void>((r) => (release = r));
    const plain = net.fn.getMockImplementation()!;
    let reads = 0;
    net.fn.mockImplementation(async (input, init) => {
      if (String(input) === '/api/admin/requests' && (init?.method ?? 'GET') === 'GET' && ++reads > 1 && open.length === 0) await gate;
      return plain(input, init);
    });
    const { user } = renderAt('/admin/requests', admin);
    const item = await screen.findByRole('group', { name: 'Remove me, Annual Day 2026' });
    expect(within(item).getByRole('link', { name: 'Open photo 1, already hidden' })).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: 'Open photo 2' })).toBeInTheDocument();
    const go = within(item).getByRole('button', { name: /Remove from album/ });
    await user.click(go);
    await waitFor(() => expect(net.called('PATCH /admin/requests/q2')).toHaveLength(1));
    // The answer went through, but the list has not come back yet: the buttons stay off.
    expect(go).toBeDisabled();
    expect(within(item).getByRole('button', { name: 'Keep photos' })).toBeDisabled();
    await user.click(go);
    expect(net.called('PATCH /admin/requests/q2')).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Remove me, Annual Day 2026' })).not.toBeInTheDocument());
  });

  it('counts removal requests apart from reports on the events page', async () => {
    mockFetch(routes(() => [removal(), removal({ id: 'q3' }), report]));
    renderAt('/admin', admin);
    const needs = await screen.findByRole('region', { name: 'Needs your approval' });
    expect(within(needs).getByRole('link', { name: 'A photo was reported by a student Check' })).toHaveAttribute('href', '/admin/requests');
    expect(within(needs).getByRole('link', { name: '2 students asked to be removed from photos Check' })).toHaveAttribute('href', '/admin/requests');
    // The top bar counts every open request.
    expect(screen.getByRole('link', { name: 'Reports from students: 3 open' })).toBeInTheDocument();
  });

  it('says what a removal request is when only one waits', async () => {
    mockFetch(routes(() => [removal()]));
    renderAt('/admin', admin);
    const needs = await screen.findByRole('region', { name: 'Needs your approval' });
    expect(within(needs).getByText('A student asked to be removed from photos. Take them out of the album or keep them.')).toBeInTheDocument();
    expect(within(needs).getByRole('link', { name: 'A student asked to be removed from photos Check' })).toBeInTheDocument();
    expect(within(needs).getAllByRole('link')).toHaveLength(1);
  });
});
