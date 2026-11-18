import { screen } from '@testing-library/react';
import { Route } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AdminApp } from '../admin';
import { mockFetch, renderAt } from './helpers';

const admin = <Route path="/admin/*" element={<AdminApp />} />;
const SENT = 'If that email belongs to a team member, we have sent a link to reset the password. It works for 30 minutes.';

describe('forgot password', () => {
  it('goes from the sign-in screen to the form and sends the email', async () => {
    const net = mockFetch({
      'GET /admin/auth/options': { body: { microsoft: false } },
      'POST /admin/password/forgot': { body: { ok: true } },
    });
    const { user } = renderAt('/admin/login', admin);
    await user.click(screen.getByRole('link', { name: 'Forgot password?' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/forgot');
    await user.type(screen.getByLabelText(/Email/), 'organiser@college.edu');
    await user.click(screen.getByRole('button', { name: /Send the link/ }));
    expect(await screen.findByText(SENT)).toBeInTheDocument();
    expect(net.called('POST /admin/password/forgot')[0].body).toEqual({ email: 'organiser@college.edu' });
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/admin/login');
  });

  it('says when there is no connection', async () => {
    mockFetch({});
    const { user } = renderAt('/admin/forgot', admin);
    await user.type(screen.getByLabelText(/Email/), 'organiser@college.edu');
    await user.click(screen.getByRole('button', { name: /Send the link/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(SENT)).not.toBeInTheDocument();
  });
});

describe('reset password page', () => {
  it('checks the two passwords before sending', async () => {
    const net = mockFetch({ 'POST /admin/password/reset': { body: { ok: true } } });
    const { user } = renderAt('/admin/reset?token=abc123', admin);
    await user.type(screen.getByLabelText(/^New password/), 'short');
    await user.type(screen.getByLabelText(/Repeat/), 'short');
    await user.click(screen.getByRole('button', { name: /Save the new password/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use 10 characters or more.');

    await user.clear(screen.getByLabelText(/^New password/));
    await user.type(screen.getByLabelText(/^New password/), 'long enough 1');
    await user.click(screen.getByRole('button', { name: /Save the new password/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('The two passwords are not the same.');
    expect(net.calls).toHaveLength(0);
  });

  it('saves the new password and links to sign in', async () => {
    const net = mockFetch({ 'POST /admin/password/reset': { body: { ok: true } } });
    const { user } = renderAt('/admin/reset?token=abc123', admin);
    await user.type(screen.getByLabelText(/^New password/), 'a new password');
    await user.type(screen.getByLabelText(/Repeat/), 'a new password');
    await user.click(screen.getByRole('button', { name: /Save the new password/ }));
    expect(await screen.findByText('Your new password is saved.')).toBeInTheDocument();
    expect(net.called('POST /admin/password/reset')[0].body).toEqual({ token: 'abc123', password: 'a new password' });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/admin/login');
  });

  it('explains an expired or used link', async () => {
    mockFetch({ 'POST /admin/password/reset': { status: 400, body: { error: 'invalid_token', message: 'Invalid token.' } } });
    const { user } = renderAt('/admin/reset?token=old', admin);
    await user.type(screen.getByLabelText(/^New password/), 'a new password');
    await user.type(screen.getByLabelText(/Repeat/), 'a new password');
    await user.click(screen.getByRole('button', { name: /Save the new password/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used. Ask for a new one.');
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/admin/forgot');
  });

  it('shows any other server message', async () => {
    mockFetch({ 'POST /admin/password/reset': { status: 400, body: { error: 'weak_password', message: 'Pick a password that is harder to guess.' } } });
    const { user } = renderAt('/admin/reset?token=abc123', admin);
    await user.type(screen.getByLabelText(/^New password/), 'password1234');
    await user.type(screen.getByLabelText(/Repeat/), 'password1234');
    await user.click(screen.getByRole('button', { name: /Save the new password/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a password that is harder to guess.');
    // The form stays, to try another password.
    expect(screen.getByLabelText(/^New password/)).toBeInTheDocument();
  });

  it('asks for a new link when the address has no token', () => {
    mockFetch({});
    renderAt('/admin/reset', admin);
    expect(screen.getByRole('alert')).toHaveTextContent('Ask for a new one.');
  });
});
