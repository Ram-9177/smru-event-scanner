import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Album, Mine, MyData } from '../student';
import { media, studentEvent } from './fixtures';
import { mockFetch, renderAt } from './helpers';

/* Remove me (feature F), on the student side. */

const routes = (
  <>
    <Route path="/e/:slug/mine" element={<Mine />} />
    <Route path="/e/:slug/album" element={<Album />} />
    <Route path="/e/:slug/me" element={<MyData />} />
  </>
);
const me = { album_open: true, searched: true, my_photos: 2, uploads_left: 30 };
const keep = { available: false, on: false, push: false, consent_version: 'k1' };
const mine = (over: Record<string, unknown> = {}) => ({ searched: true, new_photos: 0, more_coming: false, download: true, sure: [media('p1'), media('p2')], maybe: [media('p3')], keep, removal: null, fresh_count: 0, ...over });
const session = (contact: string | null = null) => ({ 'POST /e/annual-day/session': { body: { event: studentEvent(), me, contact } } });
const removal = (status: 'open' | 'approved' | 'declined', count = 2) => ({ id: 'r1', status, count, created_at: '2026-11-17T10:00:00Z', resolved_at: status === 'open' ? null : '2026-11-18T10:00:00Z' });
const LINK = "Ask to remove me from this event's photos";

describe('remove me', () => {
  it('asks, lists the photos found, sends the note and shows that the request is waiting', async () => {
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine() }, 'POST /e/annual-day/removal': { status: 201, body: { removal: removal('open') } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: LINK }));

    const dialog = screen.getByRole('dialog', { name: 'Remove me from these photos?' });
    expect(within(dialog).getByText("We'll ask the organisers to take the 2 photos we found of you out of the album. They check each request first.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Anything they should know? (optional)'), '  Please take these down  ');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));

    expect(await screen.findByText('Your removal request is waiting. The organisers will check it soon.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(net.called('POST /e/annual-day/removal')[0].body).toEqual({ note: 'Please take these down' });
    // While it waits, it is not offered again.
    expect(screen.queryByRole('button', { name: LINK })).not.toBeInTheDocument();
  });

  it('sends no note when the field is empty, and Cancel sends nothing', async () => {
    const net = mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ sure: [media('p1')] }) }, 'POST /e/annual-day/removal': { status: 201, body: { removal: removal('open', 1) } } });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: LINK }));
    expect(screen.getByText(/take the 1 photo we found of you/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(net.called('POST /e/annual-day/removal')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: LINK }));
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(net.called('POST /e/annual-day/removal')).toHaveLength(1));
    expect(net.called('POST /e/annual-day/removal')[0].body).toEqual({});
  });

  it('shows the answer when one is already waiting', async () => {
    let asked = 0;
    mockFetch({
      ...session(),
      'GET /e/annual-day/mine': () => ({ body: mine({ removal: asked ? removal('open') : null }) }),
      'POST /e/annual-day/removal': () => (asked++, { status: 409, body: { error: 'removal_open', message: 'You already asked. Your removal request is waiting.' } }),
    });
    const { user } = renderAt('/e/annual-day/mine', routes);
    await user.click(await screen.findByRole('button', { name: LINK }));
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    // The phone catches up with the server: the status line shows and the dialog goes.
    expect(await screen.findByText('Your removal request is waiting. The organisers will check it soon.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says when the organisers removed the photos', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ sure: [], removal: removal('approved') }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText('Done. The photos you asked about are no longer in the album.')).toBeInTheDocument();
    // Nothing left to remove.
    expect(screen.queryByRole('button', { name: LINK })).not.toBeInTheDocument();
  });

  it('says when the organisers kept the photos, with who to ask', async () => {
    mockFetch({ ...session('the IT help desk'), 'GET /e/annual-day/mine': { body: mine({ removal: removal('declined') }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByText('The organisers kept these photos. Ask the IT help desk if you have questions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LINK })).toBeInTheDocument();
  });

  it('is offered in the fine print too', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine() } });
    const { user } = renderAt('/e/annual-day/me', routes);
    const forget = await screen.findByRole('dialog', { name: 'Delete my results?' });
    await user.click(within(forget).getByText('What this app keeps about you'));
    await user.click(await within(forget).findByRole('button', { name: LINK }));
    expect(await screen.findByRole('dialog', { name: 'Remove me from these photos?' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Delete my results?' })).not.toBeInTheDocument();
  });

  it('is not offered before any photo of you was found', async () => {
    mockFetch({ ...session(), 'GET /e/annual-day/mine': { body: mine({ sure: [], maybe: [] }) } });
    renderAt('/e/annual-day/mine', routes);
    expect(await screen.findByRole('heading', { level: 1, name: 'No prints of you yet.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: LINK })).not.toBeInTheDocument();
  });
});
