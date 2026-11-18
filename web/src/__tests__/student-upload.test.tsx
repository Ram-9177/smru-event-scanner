import { screen, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AddPhotos } from '../student';
import { studentEvent } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const routes = <Route path="/e/:slug/add" element={<AddPhotos />} />;
const me = { album_open: true, searched: false, my_photos: 0, uploads_left: 30 };
const session = { 'POST /e/annual-day/session': { body: { event: studentEvent(), me, contact: null } } };

describe('add your photos', () => {
  it('sends photos and videos, then says an organiser checks them first', async () => {
    const net = mockFetch({ ...session, 'POST /e/annual-day/uploads': { status: 201, body: { result: 'added', review: 'pending', uploads_left: 28 } } });
    const { user } = renderAt('/e/annual-day/add', routes);
    await user.type(await screen.findByLabelText(/Your name/), 'Asha');
    const photo = new File(['p'.repeat(800)], 'stage.jpg', { type: 'image/jpeg' });
    const clip = new File(['v'.repeat(800)], 'dance.mp4', { type: 'video/mp4' });
    await user.upload(screen.getByLabelText(/Choose photos or videos/), [photo, clip]);

    expect(await screen.findByText('Thanks! An organiser will check them before they appear in the album.')).toBeInTheDocument();
    expect(screen.getByText(/2 added/)).toBeInTheDocument();
    const sent = net.called('POST /e/annual-day/uploads');
    expect(sent.map((c) => c.headers['content-type'])).toEqual(['image/jpeg', 'video/mp4']);
    expect(sent[1].body).toBe(clip);
    expect(sent[0].headers['x-uploader-name']).toBe('Asha');
    // Each file has its own line.
    expect(screen.getByRole('list', { name: 'Files being added' })).toHaveTextContent('dance.mp4');
  });

  it('stops the whole run when the server is nearly full, and says so once', async () => {
    const full = 'The server is nearly full, so photos cannot be added right now. Try again later.';
    const net = mockFetch({ ...session, 'POST /e/annual-day/uploads': { status: 507, body: { error: 'disk_full', message: full } } });
    const { user } = renderAt('/e/annual-day/add', routes);
    const files = ['a.jpg', 'b.jpg'].map((n) => new File(['p'], n, { type: 'image/jpeg' }));
    await user.upload(await screen.findByLabelText(/Choose photos or videos/), files);
    expect(await screen.findByText('Nothing new was added')).toBeInTheDocument();
    expect(screen.getAllByText(full)).toHaveLength(1);
    expect(net.called('POST /e/annual-day/uploads')).toHaveLength(1);
  });

  it('stops the whole run when the server is busy, and says so once', async () => {
    const net = mockFetch({ ...session, 'POST /e/annual-day/uploads': { status: 503, body: { error: 'busy', message: 'Many photos are being added right now. Try again in a minute.' } } });
    const { user } = renderAt('/e/annual-day/add', routes);
    const files = ['a.jpg', 'b.jpg', 'c.jpg'].map((n) => new File(['p'], n, { type: 'image/jpeg' }));
    await user.upload(await screen.findByLabelText(/Choose photos or videos/), files);
    expect(await screen.findByText('Nothing new was added')).toBeInTheDocument();
    expect(screen.getAllByText('Many photos are being added right now. Try again in a minute.')).toHaveLength(1);
    expect(net.called('POST /e/annual-day/uploads')).toHaveLength(1);
    const list = screen.getByRole('list', { name: 'Files being added' });
    expect(within(list).getAllByText('Not sent.')).toHaveLength(3);
    expect(within(list).queryByText('Waiting')).not.toBeInTheDocument();
  });

  it('turns away a video over 200 MB without sending it', async () => {
    const net = mockFetch({ ...session, 'POST /e/annual-day/uploads': { status: 201, body: { result: 'added', review: 'pending' } } });
    const { user } = renderAt('/e/annual-day/add', routes);
    const big = new File(['v'], 'long.mov', { type: 'video/quicktime' });
    Object.defineProperty(big, 'size', { value: 300 * 1024 * 1024 });
    await user.upload(await screen.findByLabelText(/Choose photos or videos/), big);
    expect(await screen.findByText('Larger than 200 MB.')).toBeInTheDocument();
    expect(screen.getByText('Nothing new was added')).toBeInTheDocument();
    expect(net.called('POST /e/annual-day/uploads')).toHaveLength(0);
  });

  it('says when adding photos is closed', async () => {
    mockFetch({ 'POST /e/annual-day/session': { body: { event: studentEvent({ options: { find: true, album: true, album_locked: false, upload: false, download: true } }), me, contact: null } } });
    renderAt('/e/annual-day/add', routes);
    expect(await screen.findByText('Adding photos is closed for this event.')).toBeInTheDocument();
  });
});
