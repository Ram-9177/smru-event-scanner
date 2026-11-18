import { screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AdminApp } from '../admin';
import { adminEvent, campuses, me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;
const base = {
  'GET /admin/me': { body: me },
  'GET /admin/requests': { body: { requests: [] } },
  'GET /admin/events': { body: { events: [adminEvent()] } },
};

describe('share kit', () => {
  it('keeps the one main link and QR, and gives each campus its own link and QR', async () => {
    mockFetch({ ...base, 'GET /admin/campuses': { body: { campuses } } });
    const { user } = renderAt('/admin/share', admin);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText'); // user-event puts its own clipboard in place

    // The one QR stays as it was.
    const ticket = await screen.findByRole('region', { name: 'The one QR and link' });
    expect(within(ticket).getByRole('img', { name: 'QR code for https://photos.college.edu' })).toHaveAttribute('src', '/api/admin/qr');

    // One row a campus: its link, its QR, Copy link and the two downloads.
    const list = await screen.findByRole('list', { name: 'Campus links' });
    expect(screen.getByText("Print each campus its own QR; it shows only that campus's events.")).toBeInTheDocument();
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/^https:/).textContent)).toEqual([
      'https://photos.college.edu/c/hyderabad',
      'https://photos.college.edu/c/chebrolu',
      'https://photos.college.edu/c/budampadu',
    ]);
    const hyd = rows[0];
    expect(within(hyd).getByText('Hyderabad')).toBeInTheDocument();
    expect(within(hyd).getByRole('img', { name: 'QR code for https://photos.college.edu/c/hyderabad' })).toHaveAttribute('src', '/api/admin/qr?campus=hyderabad');
    const png = within(hyd).getByRole('link', { name: 'Download PNG of the Hyderabad QR' });
    expect(png).toHaveAttribute('href', '/api/admin/qr?campus=hyderabad&format=png');
    expect(png).toHaveAttribute('download', 'event-photos-hyderabad-qr.png');
    const svg = within(hyd).getByRole('link', { name: 'Download SVG of the Hyderabad QR' });
    expect(svg).toHaveAttribute('href', '/api/admin/qr?campus=hyderabad');
    expect(svg).toHaveAttribute('download', 'event-photos-hyderabad-qr.svg');

    await user.click(within(rows[1]).getByRole('button', { name: /Copy link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://photos.college.edu/c/chebrolu'));
    expect(within(rows[1]).getByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('shows no campus links when there are no campuses', async () => {
    mockFetch({ ...base, 'GET /admin/campuses': { body: { campuses: [] } } });
    renderAt('/admin/share', admin);
    expect(await screen.findByRole('region', { name: 'The one QR and link' })).toBeInTheDocument();
    expect(await screen.findByText(/Photos from Annual Day 2026 are here/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Campus links' })).not.toBeInTheDocument();
  });
});
