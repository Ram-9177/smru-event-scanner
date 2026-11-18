import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { adminEvent, campuses, me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;

describe('admin events list', () => {
  const list = {
    'GET /admin/me': { body: me },
    'GET /admin/requests': { body: { requests: [{ id: 'r1' }] } },
    'GET /admin/campuses': { body: { campuses } },
    'GET /admin/events': {
      body: {
        events: [
          adminEvent({ counts: { shown: 120, review: 3 } }),
          adminEvent({ id: 'ev2', slug: 'sports-day', title: 'Sports Day', status: 'draft', folder: null, venue: null, starts_on: null, campus: campuses[1] }),
        ],
      },
    },
  };

  it('lists the events with their campus and what waits for approval', async () => {
    mockFetch(list);
    const { user } = renderAt('/admin', admin);
    expect(await screen.findByText('Annual Day 2026')).toBeInTheDocument();
    const annual = screen.getByText('Annual Day 2026').closest('a')!;
    expect(annual).toHaveAttribute('href', '/admin/events/ev1');
    expect(within(annual).getByText('120 photos')).toBeInTheDocument();
    expect(within(annual).getByText('3 waiting for approval')).toBeInTheDocument();
    expect(within(annual).getByText('Hyderabad')).toBeInTheDocument();
    const sports = screen.getByText('Sports Day').closest('a')!;
    expect(within(sports).getByText('No folder yet')).toBeInTheDocument();
    expect(within(sports).getByText('No date')).toBeInTheDocument();

    // The top bar: Events (with what waits for approval), Requests (with the open reports), People, Share kit, Settings;
    // on a phone the reports bell stands in for Requests.
    const top = screen.getAllByRole('navigation', { name: 'Admin' })[0];
    expect(within(top).getAllByRole('link').map((a) => a.textContent?.trim())).toEqual(['Events3 waiting for approval', 'Requests1 open', 'People', 'Share kit', 'Settings']);
    expect(within(top).getByRole('link', { name: /^Requests/ })).toHaveAttribute('href', '/admin/requests');
    expect(within(top).getByRole('link', { name: 'Share kit' })).toHaveAttribute('href', '/admin/share');
    expect(screen.getByRole('link', { name: 'Reports from students: 1 open' })).toHaveAttribute('href', '/admin/requests');

    // What waits for approval comes first, one tap from its tab; the phone bar's round button makes a new event.
    const needs = screen.getByRole('region', { name: 'Needs your approval' });
    expect(within(needs).getByRole('link', { name: /Annual Day 2026: 3 waiting/ })).toHaveAttribute('href', '/admin/events/ev1?tab=waiting');
    expect(within(needs).getByRole('link', { name: /A photo was reported by a student/ })).toHaveAttribute('href', '/admin/requests');
    // Each row says its count once (the badge is for the eye), and the hint is about approving.
    expect(within(needs).getByRole('link', { name: 'Annual Day 2026: 3 waiting Review' })).toBeInTheDocument();
    expect(within(needs).getByRole('link', { name: 'A photo was reported by a student Check' })).toBeInTheDocument();
    expect(within(needs).getByText("Students' photos and videos stay out of the album until you approve them.")).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Admin, phone' })).getByRole('link', { name: 'New event' })).toHaveAttribute('href', '/admin/events/new');

    // The campus chips filter the list.
    await user.click(within(await screen.findByRole('group', { name: 'Campus' })).getByRole('button', { name: /Chebrolu/ }));
    expect(screen.queryByText('Annual Day 2026')).not.toBeInTheDocument();
    expect(screen.getByText('Sports Day')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/admin?campus=c2');
  });

  it('says what a report is when only a report waits', async () => {
    mockFetch({ ...list, 'GET /admin/events': { body: { events: [adminEvent({ counts: { shown: 120 } })] } } });
    renderAt('/admin', admin);
    const needs = await screen.findByRole('region', { name: 'Needs your approval' });
    expect(within(needs).getByText('A student asked for a photo to come down. Hide it or keep it.')).toBeInTheDocument();
    expect(within(needs).queryByText(/until you approve them/)).not.toBeInTheDocument();
    expect(within(needs).getAllByRole('link')).toHaveLength(1);
    expect(within(needs).getByRole('link', { name: 'A photo was reported by a student Check' })).toHaveAttribute('href', '/admin/requests');
  });

  it("makes the phone bar's round button add a person under People", async () => {
    mockFetch({ ...list, 'GET /admin/people': { body: { people: [] } } });
    renderAt('/admin/people', admin);
    const phone = await screen.findByRole('navigation', { name: 'Admin, phone' });
    expect(within(phone).getByRole('link', { name: 'Add a person' })).toHaveAttribute('href', '/admin/people/new');
    expect(within(phone).queryByRole('link', { name: 'New event' })).not.toBeInTheDocument();
  });

  it('shows the error and tries again', async () => {
    let tries = 0;
    mockFetch({
      'GET /admin/me': { body: me },
      'GET /admin/requests': { body: { requests: [] } },
      'GET /admin/events': () => (++tries <= 2 ? { status: 500, body: { error: 'error', message: 'The database is busy.' } } : { body: { events: [adminEvent()] } }),
    });
    const { user } = renderAt('/admin', admin);
    expect(await screen.findByText('The database is busy.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Annual Day 2026')).toBeInTheDocument();
  });
});

describe('a new event', () => {
  it('asks only for the title, date and campus, then opens the event to add photos', async () => {
    const net = mockFetch({
      'GET /admin/me': { body: me },
      'GET /admin/requests': { body: { requests: [] } },
      'GET /admin/events': { body: { events: [] } },
      'GET /admin/campuses': { body: { campuses } },
      'POST /admin/events': (c) => ({ status: 201, body: { event: adminEvent({ id: 'ev9', title: c.body.title, status: 'draft', campus: campuses[1] }), folder_error: null } }),
      'GET /admin/events/ev9': { body: { event: adminEvent({ id: 'ev9', title: 'Sports Day', status: 'draft', campus: campuses[1] }) } },
    });
    const { user } = renderAt('/admin/events/new', admin);
    await user.type(await screen.findByLabelText(/^Title/), 'Sports Day');
    await user.type(screen.getByLabelText('Date'), '2026-12-05');
    await user.selectOptions(await screen.findByLabelText('Campus'), 'Chebrolu');
    // Everything else waits under More options.
    expect(screen.getByText('More options').closest('details')).not.toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: /Create the event/ }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/events/ev9'));
    const body = net.called('POST /admin/events')[0].body;
    expect(body).toMatchObject({ title: 'Sports Day', starts_on: '2026-12-05', campus_id: 'c2', venue: null, auto_approve: false, crowd_uploads: true });
    expect(body).not.toHaveProperty('passcode');
    expect(await screen.findByText('Event created')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Add photos & videos' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('an event over more days', () => {
  const routes = {
    'GET /admin/me': { body: me },
    'GET /admin/requests': { body: { requests: [] } },
    'GET /admin/events': { body: { events: [] } },
    'GET /admin/campuses': { body: { campuses } },
  };

  it('sends the last day, and asks for the first day with it', async () => {
    const net = mockFetch({
      ...routes,
      'POST /admin/events': (c) => ({ status: 201, body: { event: adminEvent({ id: 'ev9', title: c.body.title, starts_on: c.body.starts_on, ends_on: c.body.ends_on }), folder_error: null } }),
      'GET /admin/events/ev9': { body: { event: adminEvent({ id: 'ev9', title: 'Fest', starts_on: '2026-11-14', ends_on: '2026-11-16' }) } },
    });
    const { user } = renderAt('/admin/events/new', admin);
    await user.type(await screen.findByLabelText(/^Title/), 'Fest');
    await user.type(screen.getByLabelText(/^Last day/), '2026-11-16');
    await user.click(screen.getByRole('button', { name: /Create the event/ }));
    expect(await screen.findByText('Set the date of the first day too.')).toBeInTheDocument();
    expect(net.called('POST /admin/events')).toHaveLength(0);
    // The last day cannot be before the first.
    await user.type(screen.getByLabelText('Date'), '2026-11-14');
    expect(screen.getByLabelText(/^Last day/)).toHaveAttribute('min', '2026-11-14');
    await user.click(screen.getByRole('button', { name: /Create the event/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin/events/ev9'));
    expect(net.called('POST /admin/events')[0].body).toMatchObject({ starts_on: '2026-11-14', ends_on: '2026-11-16' });
    expect(await screen.findByText('14–16 Nov 2026 · Main hall')).toBeInTheDocument();
  });

  it('clears the last day in the event settings', async () => {
    const net = mockFetch({
      ...routes,
      'GET /admin/events/ev1': { body: { event: adminEvent({ starts_on: '2026-11-30', ends_on: '2026-12-02', counts: { total: 1, shown: 1 } }) } },
      'GET /admin/events/ev1/media': { body: { total: 0, media: [] } },
      'GET /admin/onedrive/status': { body: { status: { kind: 'local', rootName: 'demo' }, setup: {} } },
      'PATCH /admin/events/ev1': (c) => ({ body: { event: adminEvent({ starts_on: '2026-11-30', ends_on: c.body.ends_on, counts: { total: 1, shown: 1 } }) } }),
    });
    const { user } = renderAt('/admin/events/ev1?tab=settings', admin);
    expect(await screen.findByText('30 Nov – 2 Dec 2026 · Main hall')).toBeInTheDocument();
    await user.clear(await screen.findByLabelText(/^Last day/));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(net.called('PATCH /admin/events/ev1')).toHaveLength(1));
    expect(net.called('PATCH /admin/events/ev1')[0].body).toMatchObject({ starts_on: '2026-11-30', ends_on: null });
    expect(await screen.findByText('30 Nov 2026 · Main hall')).toBeInTheDocument();
  });
});

describe('settings', () => {
  const settings = (emailed: boolean) => ({
    'GET /admin/me': { body: me },
    'GET /admin/requests': { body: { requests: [] } },
    'GET /admin/onedrive/status': { body: { status: { kind: 'local', rootName: 'demo' }, setup: { redirect_uri: 'http://localhost:3000/admin/onedrive/callback', https: false, may_connect: true } } },
    'GET /admin/audit': { body: { entries: [] } },
    'GET /admin/team': { body: { team: [{ id: 'u1', email: me.user.email, role: 'super_admin', created_at: '2026-01-01' }] } },
    'POST /admin/team': { body: { ok: true, emailed } },
  });

  it('keeps OneDrive, Campuses, Team and My password as tabs', async () => {
    mockFetch(settings(true));
    const { user } = renderAt('/admin/settings', admin);
    const tabs = await screen.findByRole('tablist', { name: 'Settings' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['OneDrive', 'Campuses', 'Team', 'Alerts and storage', 'My password', 'More']);
    expect(await screen.findByText(/This server is in demo mode/)).toBeInTheDocument();
    await user.click(within(tabs).getByRole('tab', { name: 'My password' }));
    expect(screen.getByLabelText(/Current password/)).toBeInTheDocument();
  });

  it('says the email went out when the server sent one', async () => {
    const net = mockFetch(settings(true));
    const { user } = renderAt('/admin/settings?tab=team', admin);
    await user.type(await screen.findByLabelText(/^Email/), 'new@college.edu');
    await user.type(screen.getByLabelText(/Their password/), 'a long password');
    await user.click(screen.getByRole('button', { name: /Add organiser/ }));
    expect(await screen.findByText('new@college.edu can sign in now. We emailed them how to sign in.')).toBeInTheDocument();
    expect(net.called('POST /admin/team')[0].body).toEqual({ email: 'new@college.edu', password: 'a long password', role: 'organiser' });
  });

  it('adds a super admin, changes roles and shows the last sign-in', async () => {
    const team = [
      { id: 'u1', email: me.user.email, role: 'super_admin', created_at: '2026-01-01', last_sign_in_at: '2026-11-16T10:30:00Z' },
      { id: 'u2', email: 'org@college.edu', role: 'organiser', created_at: '2026-02-01', last_sign_in_at: null },
    ];
    const net = mockFetch({
      ...settings(true),
      'GET /admin/team': { body: { team } },
      'PATCH /admin/team/u2': { body: { ok: true } },
    });
    const { user } = renderAt('/admin/settings?tab=team', admin);
    expect(await screen.findByText('Never signed in')).toBeInTheDocument();
    expect(screen.getByText(/^Last signed in/)).toBeInTheDocument();
    // The only super admin cannot make themselves an organiser.
    expect(screen.queryByRole('button', { name: 'Make organiser' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Make super admin' }));
    expect(await screen.findByText('org@college.edu is now a super admin.')).toBeInTheDocument();
    expect(net.called('PATCH /admin/team/u2')[0].body).toEqual({ role: 'super_admin' });

    await user.type(screen.getByLabelText(/^Email/), 'boss@college.edu');
    await user.type(screen.getByLabelText(/Their password/), 'a long password');
    await user.selectOptions(screen.getByLabelText('Role'), 'Super admin');
    await user.click(screen.getByRole('button', { name: /Add super admin/ }));
    await screen.findByText('boss@college.edu can sign in now. We emailed them how to sign in.');
    expect(net.called('POST /admin/team')[0].body).toEqual({ email: 'boss@college.edu', password: 'a long password', role: 'super_admin' });
  });

  it("shows the server's answer when a role change is refused", async () => {
    const net = mockFetch({
      ...settings(true),
      'GET /admin/team': {
        body: {
          team: [
            { id: 'u1', email: me.user.email, role: 'super_admin', created_at: '2026-01-01', last_sign_in_at: null },
            { id: 'u2', email: 'other@college.edu', role: 'super_admin', created_at: '2026-02-01', last_sign_in_at: null },
          ],
        },
      },
      'PATCH /admin/team/u1': { status: 400, body: { error: 'last_super_admin', message: 'There has to be one super admin. Make someone else a super admin first.' } },
    });
    const { user } = renderAt('/admin/settings?tab=team', admin);
    // Two super admins: you can step down yourself.
    const [mine] = await screen.findAllByRole('row');
    expect(mine).toHaveTextContent('admin@college.edu (you)');
    await user.click(within(mine).getByRole('button', { name: 'Make organiser' }));
    // Stepping down yourself asks twice.
    expect(net.called('PATCH /admin/team/u1')).toHaveLength(0);
    await user.click(within(mine).getByRole('button', { name: 'Tap again to make yourself an organiser' }));
    expect(net.called('PATCH /admin/team/u1')[0].body).toEqual({ role: 'organiser' });
    expect(await screen.findByText('There has to be one super admin. Make someone else a super admin first.')).toBeInTheDocument();
  });

  it('asks to pass the password on when no email was sent', async () => {
    mockFetch(settings(false));
    const { user } = renderAt('/admin/settings?tab=team', admin);
    await user.type(await screen.findByLabelText(/^Email/), 'new@college.edu');
    await user.type(screen.getByLabelText(/Their password/), 'a long password');
    await user.click(screen.getByRole('button', { name: /Add organiser/ }));
    expect(await screen.findByText('new@college.edu can sign in now. Give them the password yourself.')).toBeInTheDocument();
  });

  it('adds a campus', async () => {
    let list = [...campuses];
    const net = mockFetch({
      ...settings(true),
      'GET /admin/campuses': () => ({ body: { campuses: list.map((c) => ({ ...c, events: 0 })) } }),
      'POST /admin/campuses': (c) => ((list = [...list, { id: 'c4', name: c.body.name, slug: 'vijayawada' }]), { status: 201, body: { campus: list.at(-1) } }),
    });
    const { user } = renderAt('/admin/settings?tab=campuses', admin);
    expect(await screen.findByText('Chebrolu')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New campus'), 'Vijayawada');
    await user.click(screen.getByRole('button', { name: /Add campus/ }));
    expect(await screen.findByText('Vijayawada was added.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Rename Vijayawada' })).toBeInTheDocument();
    expect(net.called('POST /admin/campuses')[0].body).toEqual({ name: 'Vijayawada' });
  });
});
