import { screen, waitFor } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { me } from './fixtures';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;
const signedIn = {
  'GET /admin/me': { body: me },
  'GET /admin/events': { body: { events: [] } },
  'GET /admin/requests': { body: { requests: [] } },
};

describe('admin sign-in', () => {
  it('signs in with a password and opens the console', async () => {
    let session = false;
    const net = mockFetch({
      'GET /admin/auth/options': { body: { microsoft: false } },
      'POST /admin/login': () => ((session = true), { body: { ok: true } }),
      'GET /admin/me': () => (session ? { body: me } : { status: 401, body: { error: 'not_signed_in', message: 'Sign in first.' } }),
      'GET /admin/events': { body: { events: [] } },
      'GET /admin/requests': { body: { requests: [] } },
    });
    const { user } = renderAt('/admin/login', admin);
    await user.type(screen.getByLabelText(/Email/), 'admin@college.edu');
    await user.type(screen.getByLabelText(/Password/), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Events' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/admin$/);
    expect(net.called('POST /admin/login')[0].body).toEqual({ email: 'admin@college.edu', password: 'correct horse' });
    expect(await screen.findByText('No events yet')).toBeInTheDocument();
  });

  it('shows the server message when the password is wrong', async () => {
    mockFetch({
      'GET /admin/auth/options': { body: { microsoft: false } },
      'POST /admin/login': { status: 401, body: { error: 'bad_login', message: 'That email and password do not match.' } },
    });
    const { user } = renderAt('/admin/login', admin);
    await user.type(screen.getByLabelText(/Email/), 'admin@college.edu');
    await user.type(screen.getByLabelText(/Password/), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match.');
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/login');
  });

  it('offers Microsoft sign-in only when the server has it', async () => {
    mockFetch({ 'GET /admin/auth/options': { body: { microsoft: false } } });
    const first = renderAt('/admin/login', admin);
    await waitFor(() => expect(first.client.getQueryData(['api', '/admin/auth/options'])).toEqual({ microsoft: false }));
    expect(screen.queryByRole('link', { name: /Sign in with Microsoft/ })).not.toBeInTheDocument();
    first.unmount();

    mockFetch({ 'GET /admin/auth/options': { body: { microsoft: true } } });
    renderAt('/admin/login', admin);
    const link = await screen.findByRole('link', { name: /Sign in with Microsoft/ });
    // A full page visit to the server, not a fetch.
    expect(link).toHaveAttribute('href', '/auth/microsoft');
  });

  it('keeps working when the options cannot be read', async () => {
    mockFetch({ 'GET /admin/auth/options': { status: 500, body: { error: 'error', message: 'Oops' } } });
    renderAt('/admin/login', admin);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Microsoft/ })).not.toBeInTheDocument();
  });

  it('shows a failed Microsoft sign-in and removes it from the address', async () => {
    mockFetch({
      'GET /admin/auth/options': { body: { microsoft: true } },
      'GET /admin/me': { status: 401, body: { error: 'not_signed_in', message: 'Sign in first.' } },
      'GET /admin/requests': { status: 401, body: { error: 'not_signed_in', message: 'Sign in first.' } },
    });
    renderAt(`/admin?sso_error=${encodeURIComponent('This Microsoft account is not on the team.')}`, admin);
    expect(await screen.findByRole('alert')).toHaveTextContent('This Microsoft account is not on the team.');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/admin\/login$/));
    // The message stays after the address is tidied.
    expect(screen.getByRole('alert')).toHaveTextContent('This Microsoft account is not on the team.');
  });

  it('shows sso_error given straight to the sign-in page', async () => {
    mockFetch({ 'GET /admin/auth/options': { body: { microsoft: true } } });
    renderAt('/admin/login?sso_error=Sign-in%20was%20cancelled.', admin);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/admin\/login$/));
  });

  it('sends a signed-out visitor from the console to the sign-in page', async () => {
    mockFetch({
      'GET /admin/auth/options': { body: { microsoft: false } },
      'GET /admin/me': { status: 401, body: { error: 'not_signed_in', message: 'Sign in first.' } },
      'GET /admin/requests': { status: 401, body: {} },
    });
    renderAt('/admin/settings', admin);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/admin\/login$/);
  });

  it('opens the console straight away when already signed in', async () => {
    mockFetch(signedIn);
    renderAt('/admin', admin);
    expect(await screen.findByRole('heading', { name: 'Events' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
