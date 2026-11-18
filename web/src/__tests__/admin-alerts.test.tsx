import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { adminEvent, me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;
const GB = 1024 ** 3;

const base = {
  'GET /admin/me': { body: me },
  'GET /admin/requests': { body: { requests: [] } },
  'GET /admin/campuses': { body: { campuses: [] } },
  'GET /admin/events': { body: { events: [adminEvent()] } },
};

const syncAlert = {
  key: 'sync_failing:ev1',
  kind: 'sync_failing',
  severity: 'warn',
  title: 'Sync is failing for Annual Day 2026',
  detail: 'The last syncs did not work.',
  event: { id: 'ev1', title: 'Annual Day 2026' },
  action: { label: 'Open the event', to: '/admin/events/ev1?tab=settings' },
  started_at: '2026-11-17T08:00:00Z',
};
const faceAlert = {
  key: 'face_down',
  kind: 'face_down',
  severity: 'critical',
  title: 'Face recognition is not running',
  detail: 'New photos cannot be read and selfies do not work. Restart the app; if this stays, the face model files in server/models are missing.',
  event: null,
  action: null,
  started_at: '2026-11-17T09:00:00Z',
};

describe('the alerts banner', () => {
  it('shows each problem across the console, critical as an alert, with its action', async () => {
    const net = mockFetch({ ...base, 'GET /admin/alerts': { body: { alerts: [faceAlert, syncAlert] } } });
    const { user } = renderAt('/admin', admin);
    const critical = await screen.findByRole('alert');
    expect(critical).toHaveTextContent('Face recognition is not running');
    expect(critical).toHaveClass('alertbar', 'critical');
    expect(within(critical).queryByRole('link')).not.toBeInTheDocument();

    const warn = screen.getByText('Sync is failing for Annual Day 2026').closest('.alertbar')!;
    expect(warn).toHaveAttribute('role', 'status');
    expect(warn).toHaveClass('warn');
    expect(warn).toHaveTextContent('The last syncs did not work.');
    const go = within(warn as HTMLElement).getByRole('link', { name: 'Open the event' });
    expect(go).toHaveAttribute('href', '/admin/events/ev1?tab=settings');
    // The old note does not show twice when the alerts say it.
    expect(screen.queryByText('Face recognition is not ready')).not.toBeInTheDocument();
    expect(net.called('GET /admin/alerts')).toHaveLength(1);

    await user.click(go);
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/events/ev1?tab=settings');
  });

  it('shows nothing when there is no problem', async () => {
    mockFetch({ ...base, 'GET /admin/alerts': { body: { alerts: [] } } });
    renderAt('/admin', admin);
    expect(await screen.findByText('Annual Day 2026')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.alertbars')).toBeNull());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falls back to the face recognition note when the alerts cannot be read', async () => {
    mockFetch({ ...base, 'GET /admin/me': { body: { ...me, face_service: false } } });
    renderAt('/admin', admin);
    expect(await screen.findByText('Face recognition is not ready')).toBeInTheDocument();
  });
});

const MB = 1024 ** 2;

/** A storage report: the database, the server and OneDrive, each its own part (`over` replaces fields in each). */
const storage = (over: { machine?: string; host?: string; database?: object; server?: object; onedrive?: object; copies?: object } = {}) => {
  const base = {
    machine: 'Mac',
    host: 'localhost:3000',
    database: { size: 80 * MB, backups: 300 * MB, backups_on: true },
    server: { temp: 0, cache: 120 * MB, cache_max: 300 * MB, legacy_copies: 0, uploads_paused: false, min_free_upload: 1 * GB },
    onedrive: { connected: true, quota: { total: 1024 * GB, used: 256 * GB, remaining: 768 * GB }, copies: 14.5 * GB },
    copies: { waiting: 0, lost: 0, running: false, last_error: null, local_done: true },
  };
  return {
    body: {
      ...base,
      ...over,
      database: { ...base.database, ...over.database },
      server: { ...base.server, ...over.server },
      onedrive: { ...base.onedrive, ...over.onedrive },
      copies: { ...base.copies, ...over.copies },
    },
  };
};

const alertsTab = (over: Record<string, unknown> = {}) => ({
  ...base,
  'GET /admin/alerts': { body: { alerts: [] } },
  'GET /admin/alerts/settings': { body: { smtp: true, email_alerts: true, email: me.user.email, digest_hour: 9 } },
  'GET /admin/storage': storage(),
  'GET /admin/onedrive/status': { body: { status: { kind: 'local', rootName: 'demo' }, setup: {}, backup: { dir: '/Users/ram/Desktop/Event-Scanner/backups', last_at: '2026-11-17T02:00:00Z', last_error: null } } },
  ...over,
});

describe('settings: alerts and storage', () => {
  it('turns email alerts off and sends a test email', async () => {
    const net = mockFetch({
      ...alertsTab(),
      'PATCH /admin/alerts/settings': (c) => ({ body: { smtp: true, email_alerts: c.body.email_alerts, email: me.user.email, digest_hour: 9 } }),
      'POST /admin/alerts/test': { body: { sent: true, to: me.user.email } },
    });
    const { user } = renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByRole('tab', { name: 'Alerts and storage' })).toHaveAttribute('aria-selected', 'true');
    const toggle = await screen.findByRole('switch', { name: /Email me about problems/ });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(
        'Sync failures, OneDrive, backups, disk space and face recognition. At most one email per problem every 12 hours, and one when it is fixed. Plus a morning summary at 09:00 when uploads or requests are waiting.',
      ),
    ).toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() => expect(net.called('PATCH /admin/alerts/settings')).toHaveLength(1));
    expect(net.called('PATCH /admin/alerts/settings')[0].body).toEqual({ email_alerts: false });
    await waitFor(() => expect(screen.getByRole('switch', { name: /Email me about problems/ })).not.toBeChecked());

    await user.click(screen.getByRole('button', { name: /Send a test email/ }));
    expect(await screen.findByText('Sent to admin@college.edu.')).toBeInTheDocument();
    expect(net.called('POST /admin/alerts/test')).toHaveLength(1);
  });

  it('leaves out the morning summary when it is off, and shows why a test email failed', async () => {
    mockFetch({
      ...alertsTab({ 'GET /admin/alerts/settings': { body: { smtp: true, email_alerts: false, email: me.user.email, digest_hour: null } } }),
      'POST /admin/alerts/test': { status: 502, body: { error: 'send_failed', message: 'The email could not be sent. Check SMTP_URL in server/.env.' } },
    });
    const { user } = renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByRole('switch', { name: /Email me about problems/ })).not.toBeChecked();
    expect(screen.getByText(/one when it is fixed\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/morning summary/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Send a test email/ }));
    expect(await screen.findByText('The email could not be sent. Check SMTP_URL in server/.env.')).toBeInTheDocument();
  });

  it('says plainly when email is not set up', async () => {
    mockFetch(alertsTab({ 'GET /admin/alerts/settings': { body: { smtp: false, email_alerts: true, email: me.user.email, digest_hour: 9 } } }));
    renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByText('Email is not set up on this server, so alerts show only here in the console. To get them by email, set SMTP_URL in server/.env and restart.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Email me about problems/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send a test email/ })).toBeDisabled();
  });

  it('shows the database, this Mac and Microsoft OneDrive, each its own part, and nothing of the disk itself', async () => {
    mockFetch(alertsTab());
    renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByRole('heading', { name: 'Database' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'This Mac' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Microsoft OneDrive' })).toBeInTheDocument();
    expect(screen.getByText(/Photos and videos are stored only in Microsoft OneDrive/)).toHaveTextContent(
      'Photos and videos are stored only in Microsoft OneDrive. The database keeps the events, settings and face data. The server keeps only short-lived working files and a small photo cache: every upload passes through it on its way to OneDrive.',
    );
    const row = (label: string) => screen.getByText(label).parentElement!;
    expect(row('Size')).toHaveTextContent('80 MB');
    expect(row('Backups')).toHaveTextContent('300 MB');
    expect(row('Temporary files')).toHaveTextContent('None');
    expect(row('Photo cache')).toHaveTextContent('120 MB');
    expect(row('Photo cache')).toHaveTextContent('at most 300 MB');
    expect(screen.queryByText('Old copies still here')).not.toBeInTheDocument();
    expect(screen.getByText('OneDrive: 256.0 GB used of 1024.0 GB')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Space used in OneDrive' })).toHaveAttribute('aria-valuenow', '25');
    expect(row('App copies in OneDrive')).toHaveTextContent('14.5 GB');
    expect(row('App copies in OneDrive')).toHaveTextContent('in the folder _app copies (do not edit)');
    expect(row('Copies being rebuilt')).toHaveTextContent('None');
    expect(row('Photos that cannot be shown')).toHaveTextContent('None');
    expect(await screen.findByText('Last backup')).toBeInTheDocument();
    expect(row('Last backup')).toHaveTextContent('In /Users/ram/Desktop/Event-Scanner/backups');
    // The disk itself is not shown: no meter, no free space, nothing about uploads while they go.
    expect(screen.queryByRole('progressbar', { name: /Space used on/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/free of|Measured on the disk/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Uploads are paused|Uploads stop below/)).not.toBeInTheDocument();
    expect(screen.getByText(/Free up space/)).toBeInTheDocument(); // the OneDrive sync client advice, on a Mac
  });

  it('while copies are moved and rebuilt: the old copies still here, how many wait, and those that cannot be shown', async () => {
    mockFetch(
      alertsTab({
        'GET /admin/storage': storage({
          database: { size: GB, backups: 0, backups_on: false },
          server: { temp: 2 * MB, legacy_copies: 3 * GB, cache: 0, cache_max: 0 },
          onedrive: { quota: null, copies: null },
          copies: { waiting: 1200, lost: 3, running: true, last_error: 'OneDrive answered 500', local_done: false },
        }),
      }),
    );
    renderAt('/admin/settings?tab=alerts', admin);
    const row = async (label: string) => (await screen.findByText(label)).parentElement!;
    expect(await row('Old copies still here')).toHaveTextContent('3.0 GB');
    expect(await row('Copies being rebuilt')).toHaveTextContent('1200, working');
    expect(await row('Photos that cannot be shown')).toHaveTextContent('3');
    expect(await row('App copies in OneDrive')).toHaveTextContent('Not known');
    expect(screen.getByText('OneDrive did not say how much space it has.')).toBeInTheDocument();
    expect(screen.getByText('Last problem making a copy: OneDrive answered 500')).toBeInTheDocument();
  });

  it('says nothing about the disk while uploads go, and says so with what to do once they are paused', async () => {
    mockFetch(alertsTab({ 'GET /admin/storage': storage({ database: { backups: 0, backups_on: false }, server: { cache_max: 0 } }) }));
    const first = renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByText('Temporary files')).toBeInTheDocument();
    expect(screen.queryByText(/Uploads are paused|Uploads stop below|GB free/)).not.toBeInTheDocument();
    expect(screen.getByText('Backups').parentElement).toHaveTextContent('Off');
    expect(screen.getByText('Photo cache').parentElement).toHaveTextContent('Off');
    expect(screen.queryByText('Last backup')).not.toBeInTheDocument();
    first.unmount();

    mockFetch(alertsTab({ 'GET /admin/storage': storage({ server: { uploads_paused: true } }) }));
    renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByText('Uploads are paused: less than 1 GB free for temporary files. Free up space on the Mac.')).toBeInTheDocument();
  });

  it('on a server: names it by its address, lists only the app\'s own files there, and advises a bigger disk once uploads are paused', async () => {
    mockFetch(
      alertsTab({
        'GET /admin/storage': storage({ machine: 'server', host: 'stmarys-event-scanner.supercxo.ai', server: { cache: 256 * MB, uploads_paused: true } }),
      }),
    );
    renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByRole('heading', { name: 'Server' })).toBeInTheDocument();
    expect(screen.getByText('stmarys-event-scanner.supercxo.ai')).toBeInTheDocument();
    expect(screen.getByText('Uploads are paused: less than 1 GB free for temporary files. Give the server a bigger disk, or free up space on it.')).toBeInTheDocument();
    const row = (label: string) => screen.getByText(label).parentElement!;
    expect(row('Photo cache')).toHaveTextContent('256 MB');
    // Only the app's own files on the server: nothing else of it is looked at or listed.
    const kv = row('Temporary files').parentElement!;
    expect([...kv.children].map((d) => d.firstElementChild?.textContent)).toEqual(['Temporary files', 'Photo cache']);
    expect(screen.queryByText(/\bMac\b/)).not.toBeInTheDocument(); // nor the OneDrive app advice, which is for a Mac
  });

  it('says when the last backup failed', async () => {
    mockFetch(alertsTab({ 'GET /admin/onedrive/status': { body: { status: { kind: 'local' }, setup: {}, backup: { dir: '/b', last_at: null, last_error: 'pg_dump was not found.' } } } }));
    renderAt('/admin/settings?tab=alerts', admin);
    expect(await screen.findByText('The last backup did not work: pg_dump was not found.')).toBeInTheDocument();
    expect(screen.getByText('Last backup').parentElement).toHaveTextContent('None yet');
  });

  it('keeps the tab from organisers', async () => {
    const organiser = { ...me, user: { ...me.user, role: 'organiser' as const } };
    const net = mockFetch({
      ...alertsTab(),
      'GET /admin/me': { body: organiser },
    });
    renderAt('/admin/settings?tab=alerts', admin);
    const tabs = await screen.findByRole('tablist', { name: 'Settings' });
    expect(within(tabs).queryByRole('tab', { name: 'Alerts and storage' })).not.toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'OneDrive' })).toHaveAttribute('aria-selected', 'true');
    expect(net.called('GET /admin/storage')).toHaveLength(0);
    expect(net.called('GET /admin/alerts/settings')).toHaveLength(0);
  });
});

describe('uploads when the server is full', () => {
  it('stops the remaining files at disk_full', async () => {
    const net = mockFetch({
      ...base,
      'GET /admin/alerts': { body: { alerts: [] } },
      'GET /admin/events/ev1': { body: { event: adminEvent() } },
      'POST /admin/events/ev1/photos': { status: 507, body: { error: 'disk_full', message: 'The server has less than 3 GB free, so uploads are paused. Free up space on the Mac (Settings, Storage).' } },
    });
    const { user } = renderAt('/admin/events/ev1?tab=add', admin);
    const files = Array.from({ length: 8 }, (_, i) => new File(['x'], `p${i}.jpg`, { type: 'image/jpeg' }));
    await user.upload(await screen.findByLabelText(/Drop photos and videos here/), files);
    expect(await screen.findByText('Stopped: The server has less than 3 GB free, so uploads are paused. Free up space on the Mac (Settings, Storage).')).toBeInTheDocument();
    // Three go at once; once one is refused nothing more is sent.
    expect(net.called('POST /admin/events/ev1/photos').length).toBeLessThanOrEqual(3);
    expect(screen.getByText(/not sent\.$/)).toBeInTheDocument();
  });
});
