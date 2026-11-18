import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { adminEvent, campuses, me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;

const base = {
  'GET /admin/me': { body: me },
  'GET /admin/requests': { body: { requests: [] } },
  'GET /admin/campuses': { body: { campuses } },
  'GET /admin/alerts': { body: { alerts: [] } },
};

describe('a new event: closing and face data', () => {
  it('starts at 90 days, shows the date, and sends the closing day', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events': { body: { events: [] } },
      'POST /admin/events': (c) => ({ status: 201, body: { event: adminEvent({ id: 'ev9', title: c.body.title }), folder_error: null } }),
      'GET /admin/events/ev9': { body: { event: adminEvent({ id: 'ev9', title: 'Fest' }) } },
    });
    const { user } = renderAt('/admin/events/new', admin);
    await user.type(await screen.findByLabelText(/^Title/), 'Fest');
    await user.click(screen.getByText('More options'));
    const days = screen.getByLabelText('Delete face data');
    expect(days).toHaveValue(90);
    expect(screen.getByText('Face search stops then; the photos stay. Leave empty to keep it until you archive the event.')).toBeInTheDocument();
    expect(screen.getByText('It closes that morning: students can still see the photos, nothing new is added.')).toBeInTheDocument();
    // No date yet: no date to show.
    expect(screen.queryByText(/Face data will be deleted on/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Date'), '2026-11-14');
    expect(screen.getByText('Face data will be deleted on 12 Feb 2027.')).toBeInTheDocument();
    // The last day counts when there is one.
    await user.type(screen.getByLabelText(/^Last day/), '2026-11-16');
    expect(screen.getByText('Face data will be deleted on 14 Feb 2027.')).toBeInTheDocument();
    await user.clear(days);
    await user.type(days, '30');
    expect(screen.getByText('Face data will be deleted on 16 Dec 2026.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Close the album automatically on'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: /Create the event/ }));
    await waitFor(() => expect(net.called('POST /admin/events')).toHaveLength(1));
    expect(net.called('POST /admin/events')[0].body).toMatchObject({ starts_on: '2026-11-14', ends_on: '2026-11-16', close_on: '2026-12-31', face_days: 30 });
  });

  it('keeps the face data when the days are left empty, and refuses a number that is not a whole day count', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/events': { body: { events: [] } },
      'POST /admin/events': (c) => ({ status: 201, body: { event: adminEvent({ id: 'ev9', title: c.body.title }), folder_error: null } }),
      'GET /admin/events/ev9': { body: { event: adminEvent({ id: 'ev9' }) } },
    });
    const { user } = renderAt('/admin/events/new', admin);
    await user.type(await screen.findByLabelText(/^Title/), 'Fest');
    await user.click(screen.getByText('More options'));
    const days = screen.getByLabelText('Delete face data');
    await user.clear(days);
    await user.type(days, '0');
    await user.click(screen.getByRole('button', { name: /Create the event/ }));
    expect(await screen.findByText('Delete face data: type a number of days from 1 to 3650, or leave it empty.')).toBeInTheDocument();
    expect(net.called('POST /admin/events')).toHaveLength(0);

    await user.clear(days);
    await user.click(screen.getByRole('button', { name: /Create the event/ }));
    await waitFor(() => expect(net.called('POST /admin/events')).toHaveLength(1));
    expect(net.called('POST /admin/events')[0].body).toMatchObject({ face_days: null, close_on: null });
  });
});

describe('an event: closing and face data', () => {
  const event = (over: Record<string, unknown> = {}) => adminEvent({ starts_on: '2026-08-01', counts: { total: 1, shown: 1 }, ...over });
  const routes = (e: ReturnType<typeof adminEvent>) => ({
    ...base,
    'GET /admin/events': { body: { events: [e] } },
    'GET /admin/events/ev1': { body: { event: e } },
    'GET /admin/events/ev1/media': { body: { total: 0, media: [] } },
    'GET /admin/onedrive/folders': { body: { folders: [] } },
  });

  it('shows what is set, and an older event keeps its face data until archived', async () => {
    const net = mockFetch({
      ...routes(event({ close_on: null, face_days: null })),
      'PATCH /admin/events/ev1': (c) => ({ body: { event: event({ close_on: c.body.close_on, face_days: c.body.face_days }) } }),
    });
    const { user } = renderAt('/admin/events/ev1?tab=settings', admin);
    await user.click(await screen.findByText('More options'));
    expect(screen.getByLabelText('Delete face data')).toHaveValue(null);
    expect(screen.queryByText(/Face data will be deleted on/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Delete face data'), '70');
    expect(screen.getByText('Face data will be deleted on 10 Oct 2026.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(net.called('PATCH /admin/events/ev1')).toHaveLength(1));
    expect(net.called('PATCH /admin/events/ev1')[0].body).toMatchObject({ face_days: 70, close_on: null });
  });

  it('says when the face data was deleted, and the days can no longer be changed', async () => {
    mockFetch(routes(event({ status: 'closed', face_days: 90, face_deleted_at: '2026-11-03T12:00:00Z', close_on: '2026-08-10' })));
    const { user } = renderAt('/admin/events/ev1?tab=settings', admin);
    // On the event's line too.
    expect(await screen.findByText('Face data deleted on 3 Nov 2026')).toBeInTheDocument();
    await user.click(screen.getByText('More options'));
    expect(screen.getByText('Face data deleted on 3 Nov 2026.')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete face data')).toBeDisabled();
    expect(screen.getByLabelText('Close the album automatically on')).toHaveValue('2026-08-10');
    expect(screen.queryByText(/Face data will be deleted on/)).not.toBeInTheDocument();
  });
});

describe('the reminder for old closed events', () => {
  it('asks before deleting the face data, then the slip goes', async () => {
    let reminder = true;
    const net = mockFetch({
      ...base,
      'GET /admin/events': () => ({
        body: {
          events: [
            adminEvent({ status: 'closed', starts_on: '2026-03-01', face_reminder: reminder }),
            adminEvent({ id: 'ev2', title: 'Sports Day', status: 'live', face_reminder: false }),
          ],
        },
      }),
      'POST /admin/events/ev1/face-data/delete': () => ((reminder = false), { body: { event: adminEvent({ status: 'closed' }), deleted: { faces: 120, kept: 2, results: 0 } } }),
    });
    const { user } = renderAt('/admin', admin);
    const slip = await screen.findByRole('group', { name: 'Face data of Annual Day 2026' });
    expect(slip).toHaveTextContent('Closed more than 90 days ago. Face data is still kept.');
    // Only the closed event has one, and the card still opens the event.
    expect(screen.getAllByRole('group', { name: /^Face data of/ })).toHaveLength(1);
    expect(screen.getByText('Annual Day 2026').closest('a')).toHaveAttribute('href', '/admin/events/ev1');

    await user.click(within(slip).getByRole('button', { name: /Delete face data now/ }));
    expect(slip).toHaveTextContent('Delete the face data of Annual Day 2026? Face search ends for this event. The photos stay.');
    expect(net.called('POST /admin/events/ev1/face-data/delete')).toHaveLength(0);
    await user.click(within(slip).getByRole('button', { name: 'Cancel' }));
    await user.click(within(slip).getByRole('button', { name: /Delete face data now/ }));
    await user.click(within(slip).getByRole('button', { name: /^Delete face data$/ }));
    await waitFor(() => expect(net.called('POST /admin/events/ev1/face-data/delete')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Face data of Annual Day 2026' })).not.toBeInTheDocument());
  });

  it('shows the error when the face data could not be deleted', async () => {
    mockFetch({
      ...base,
      'GET /admin/events': { body: { events: [adminEvent({ status: 'closed', face_reminder: true })] } },
      'POST /admin/events/ev1/face-data/delete': { status: 500, body: { error: 'error', message: 'The database is busy.' } },
    });
    const { user } = renderAt('/admin', admin);
    const slip = await screen.findByRole('group', { name: 'Face data of Annual Day 2026' });
    await user.click(within(slip).getByRole('button', { name: /Delete face data now/ }));
    await user.click(within(slip).getByRole('button', { name: /^Delete face data$/ }));
    expect(await within(slip).findByText('The database is busy.')).toBeInTheDocument();
  });
});

describe('the activity log', () => {
  it('names the app for what it did by itself', async () => {
    mockFetch({
      ...base,
      'GET /admin/onedrive/status': { body: { status: { kind: 'local', rootName: 'demo' }, setup: {} } },
      'GET /admin/audit': {
        body: {
          entries: [
            { actor: 'system', action: 'event.face_expired', detail: { faces: 10, kept: 1 }, created_at: '2026-11-17T01:00:00Z' },
            { actor: 'system', action: 'event.auto_close', detail: { title: 'Fest' }, created_at: '2026-11-16T01:00:00Z' },
            { actor: 'org@college.edu', action: 'request.approved', detail: { kind: 'removal', count: 4 }, created_at: '2026-11-15T01:00:00Z' },
          ],
        },
      },
    });
    renderAt('/admin/settings?tab=more', admin);
    expect(await screen.findByText(/deleted the face data of an event when its time was up/)).toBeInTheDocument();
    expect(screen.getByText(/closed an event on its closing day: Fest/)).toBeInTheDocument();
    expect(screen.getAllByText('The app')).toHaveLength(2);
    expect(screen.getByText(/took a student out of the photos they asked about \(4\)/)).toBeInTheDocument();
  });
});
