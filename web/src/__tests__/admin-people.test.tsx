import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { campuses, me, person, video } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;
const base = {
  'GET /admin/me': { body: me },
  'GET /admin/requests': { body: { requests: [] } },
  'GET /admin/events': { body: { events: [] } },
  'GET /admin/campuses': { body: { campuses } },
};
const filed = (id: string, kind: string, over: Record<string, unknown> = {}) => ({ id, thumb: `/img/${id}/t`, web: `/img/${id}/w`, type: 'photo', video: null, duration_ms: null, kind, similarity: 0.7, event: { id: 'ev1', title: 'Annual Day 2026', slug: 'annual-day' }, ...over });

describe('people', () => {
  it('lists the people with their face, role, campus and counts', async () => {
    mockFetch({
      ...base,
      'GET /admin/people': { body: { people: [person(), person({ id: 'p2', name: 'Prof. S. Devi', role: 'Vice Chancellor', campus: null, photo: null, refs: 0, counts: { solo: 0, duo: 0, group: 0 } })] } },
    });
    renderAt('/admin/people', admin);
    const rao = (await screen.findByText('Dr. K. Rao')).closest('a')!;
    expect(rao).toHaveAttribute('href', '/admin/people/p1');
    expect(within(rao).getByText('Chairman · Hyderabad')).toBeInTheDocument();
    expect(within(rao).getByText('Solo').parentElement).toHaveTextContent('Solo 2');
    expect(within(rao).getByText('Group').parentElement).toHaveTextContent('Group 5');
    const devi = screen.getByText('Prof. S. Devi').closest('a')!;
    expect(within(devi).getByText('SD')).toBeInTheDocument();
    expect(within(devi).getByText('Add a face photo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add person/ })).toHaveAttribute('href', '/admin/people/new');
  });

  it('says when the server does not have People yet', async () => {
    mockFetch(base);
    renderAt('/admin/people', admin);
    expect(await screen.findByText('People is not ready on this server yet')).toBeInTheDocument();
  });

  it('adds a person, then asks for face photos and shows why a photo was refused', async () => {
    const fresh = person({ id: 'p9', name: 'Dr. M. Reddy', role: 'Registrar', campus: campuses[2], photo: null, refs: 0, counts: { solo: 0, duo: 0, group: 0 }, folder: null });
    let refs: { id: string; thumb: string }[] = [];
    const net = mockFetch({
      ...base,
      'POST /admin/people': { status: 201, body: { person: fresh } },
      'GET /admin/people/p9': () => ({ body: { person: { ...fresh, refs: refs.length }, refs } }),
      'GET /admin/people/p9/media': { body: { media: [] } },
      'POST /admin/people/p9/photos': (c) =>
        (c.body as File).name === 'crowd.jpg'
          ? { status: 422, body: { error: 'no_face', message: 'No face was found in that photo. Use a clear photo where the face is easy to see.' } }
          : ((refs = [...refs, { id: 'r1', thumb: '/api/admin/people/refs/r1.jpg' }]), { status: 201, body: { person: { ...fresh, refs: 1 } } }),
    });
    const { user } = renderAt('/admin/people/new', admin);
    await user.type(await screen.findByLabelText(/^Name/), 'Dr. M. Reddy');
    const role = screen.getByLabelText(/^Role/);
    expect(role).toHaveAttribute('list', 'p-roles');
    expect(document.querySelectorAll('#p-roles option').length).toBeGreaterThan(8);
    await user.type(role, 'Registrar');
    await user.selectOptions(await screen.findByLabelText(/^Campus/), 'Budampadu');
    await user.click(screen.getByRole('button', { name: /Next: add face photos/ }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/people/p9'));
    expect(net.called('POST /admin/people')[0].body).toEqual({ name: 'Dr. M. Reddy', role: 'Registrar', campus_id: 'c3' });
    expect(await screen.findByText('Step 2 of 2: add 1 to 5 clear face photos')).toBeInTheDocument();

    const pick = screen.getByLabelText(/Add face photos/);
    await user.upload(pick, [new File(['x'.repeat(600)], 'crowd.jpg', { type: 'image/jpeg' }), new File(['y'.repeat(600)], 'portrait.jpg', { type: 'image/jpeg' })]);
    expect(await screen.findByText(/No face was found in that photo/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('crowd.jpg: No face was found in that photo.');
    expect(await screen.findByRole('img', { name: 'Face photo 1 of Dr. M. Reddy' })).toBeInTheDocument();
    const sent = net.called('POST /admin/people/p9/photos');
    expect(sent).toHaveLength(2);
    expect(sent[1].headers['content-type']).toBe('image/jpeg');
  });

  it('shows a person: face photos, the OneDrive folder and their photos in Solo, Duo and Group', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/people/p1': { body: { person: person(), refs: [{ id: 'r1', thumb: '/api/admin/people/refs/r1.jpg' }] } },
      'GET /admin/people/p1/media': (c) => ({
        body: { media: c.path.endsWith('kind=duo') ? [filed('d1', 'duo')] : c.path.endsWith('kind=group') ? [] : [filed('s1', 'solo'), filed('s2', 'solo', { type: 'video', video: '/img/s2/v', duration_ms: 12_000 })] },
      }),
      'POST /admin/people/p1/refile': { body: { filed: 8 } },
      'DELETE /admin/people/p1/photos/r1': { body: { person: person({ refs: 0 }) } },
    });
    const { user } = renderAt('/admin/people/p1', admin);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dr. K. Rao' })).toBeInTheDocument();
    expect(screen.getByText('Saved in OneDrive:').parentElement).toHaveTextContent('Saved in OneDrive: Event Photos › People › Dr. K. Rao (Chairman)');

    const tabs = screen.getByRole('tablist', { name: 'Photos of this person' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Solo (2)', 'Duo (1)', 'Group (5)']);
    expect(await screen.findByRole('button', { name: 'Open video 2, 0:12 long' })).toBeInTheDocument();

    await user.click(within(tabs).getByRole('tab', { name: 'Duo (1)' }));
    expect(await screen.findByRole('button', { name: 'Open photo 1' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Open video 2/ })).not.toBeInTheDocument());
    expect(net.called('GET /admin/people/p1/media?kind=duo')).toHaveLength(1);

    await user.click(within(tabs).getByRole('tab', { name: 'Group (5)' }));
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /File again/ }));
    expect(await screen.findByText('8 photos and videos are in their folder.')).toBeInTheDocument();

    // Removing a face photo takes two taps.
    await user.click(screen.getByRole('button', { name: 'Remove face photo 1' }));
    expect(net.called('DELETE /admin/people/p1/photos/r1')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Tap again to remove face photo 1' }));
    await waitFor(() => expect(net.called('DELETE /admin/people/p1/photos/r1')).toHaveLength(1));
  });
});
